#!/usr/bin/env node
// @ts-check
/**
 * find-magic-strings — deterministic candidate extractor for the magic-string-reviewer agent.
 *
 * Compares the working tree with the merge-base of HEAD and a base branch, parses every changed
 * TS/JS file with the TypeScript compiler, and classifies every string literal on an added line
 * with a fixed, ordered rule set. Output is JSON on stdout; the same repository state always
 * produces byte-identical output.
 *
 * Exit codes: 0 ok (whatever the findings), 2 usage/config error, 3 environment error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  classifySyntax,
  collectDefinitions,
  collectLiterals,
  looksLikeSecret,
  shapeOf,
  staticLength,
} from './lib/classify.mjs';
import { runIfMain, scriptKind, sortBy } from './lib/cli.mjs';
import { isScannedExtension, loadConfig, skipReason } from './lib/config.mjs';
import { ScannerError } from './lib/errors.mjs';
import { changedFiles, fileAtCommit, grepFiles, headInfo, mergeBase, repoRoot, resolveBaseRef } from './lib/git.mjs';
import { PLACEHOLDER } from './lib/rules.mjs';
import { TypeProber } from './lib/type-probe.mjs';
import { loadTypeScript } from './lib/typescript-loader.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./lib/classify.mjs').Literal} Literal */
/** @typedef {import('./lib/config.mjs').MagicStringsConfig} MagicStringsConfig */

export const TOOL_VERSION = '0.1.0';
const MAX_DEFINITION_FILES = 400;
const MAX_CODE = 160;
const DEFAULT_MAX_PROBES = 1000;
const SOURCE_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'];

const HELP = `Usage: find-magic-strings.mjs [options]

Lists string literals added in the working tree (vs. the merge-base with --base) and classifies
them deterministically. Prints JSON on stdout.

Options:
  --base <ref>        Base branch/ref (default: origin/HEAD, then origin/main|master|develop, main|master|develop)
  --repo <dir>        Repository directory (default: current directory)
  --config <file>     Config file (default: <repo>/.claude/pr-review.json)
  --typescript <dir>  typescript package directory (default: auto; env PR_REVIEW_TYPESCRIPT)
  --no-types          Skip type-check probes (faster, less precise)
  --max-probes <n>    Type-check probe budget (default: ${DEFAULT_MAX_PROBES})
  --verbose           Also list excluded literals
  -h, --help          Show this help
`;

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {'string' | 'template'} kind
 * @property {string} value
 * @property {string} shape
 * @property {string} context
 * @property {string} detail
 * @property {'VIOLATION' | 'REVIEW'} preclass
 * @property {string} rule
 * @property {string | null} adr
 * @property {boolean | null} typed
 * @property {number} occurrencesInPr
 * @property {{ name: string, file: string, line: number }[]} existingDefinitions
 * @property {string} code
 */

/**
 * @typedef {object} Working
 * @property {string} file
 * @property {Literal} lit
 * @property {SourceFile} sf
 * @property {string[]} lines
 * @property {'EXCLUDED' | 'VIOLATION' | 'PENDING'} verdict
 * @property {string} rule
 * @property {string | null} adr
 * @property {string} context
 * @property {string} detail
 * @property {boolean | null} typed
 * @property {boolean} redacted
 * @property {{ name: string, file: string, line: number }[]} existing
 */

/**
 * @param {Literal} lit
 * @param {Set<number> | 'all'} added
 * @returns {boolean}
 */
function onAddedLine(lit, added) {
  if (added === 'all') return true;
  for (let n = lit.line; n <= lit.endLine; n += 1) if (added.has(n)) return true;
  return false;
}

/**
 * @param {string[]} lines
 * @param {number} line
 * @returns {boolean}
 */
function isSuppressed(lines, line) {
  const marker = 'magic-string-ok';
  return (lines[line - 1] ?? '').includes(marker) || (lines[line - 2] ?? '').includes(marker);
}

/**
 * @param {string[]} argv
 * @returns {{ base: string | null, repo: string, config: string | null, typescript: string | null, types: boolean, maxProbes: number, verbose: boolean, help: boolean }}
 */
function parseCli(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        repo: { type: 'string' },
        config: { type: 'string' },
        typescript: { type: 'string' },
        'no-types': { type: 'boolean', default: false },
        'max-probes': { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (e) {
    throw new ScannerError('USAGE', /** @type {Error} */ (e).message, 2, 'Run with --help.');
  }
  const v = parsed.values;
  const maxProbes = v['max-probes'] === undefined ? DEFAULT_MAX_PROBES : Number(v['max-probes']);
  if (!Number.isInteger(maxProbes) || maxProbes < 0) {
    throw new ScannerError('USAGE', '--max-probes must be an integer >= 0.', 2);
  }
  const envTs = process.env.PR_REVIEW_TYPESCRIPT;
  return {
    base: typeof v.base === 'string' ? v.base : null,
    repo: typeof v.repo === 'string' ? v.repo : process.cwd(),
    config: typeof v.config === 'string' ? v.config : null,
    typescript: typeof v.typescript === 'string' ? v.typescript : envTs !== undefined && envTs !== '' ? envTs : null,
    types: v['no-types'] !== true,
    maxProbes,
    verbose: v.verbose === true,
    help: v.help === true,
  };
}

/**
 * @param {string[]} argv
 * @returns {object} The JSON report.
 */
export function run(argv) {
  const opts = parseCli(argv);
  if (opts.help) return { help: HELP };

  const root = repoRoot(path.resolve(opts.repo));
  const { config, path: configPath, warnings } = loadConfig(root, opts.config);
  const baseRef = resolveBaseRef(root, opts.base);
  const base = mergeBase(root, baseRef);
  const head = headInfo(root);
  const changed = changedFiles(root, base);

  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  const scanned = [];
  let otherFiles = 0;
  for (const f of changed) {
    if (!isScannedExtension(f.path)) {
      otherFiles += 1;
      continue;
    }
    const reason = skipReason(f.path, config);
    if (reason !== null) skipped.push({ path: f.path, reason });
    else if (fs.existsSync(path.join(root, f.path))) scanned.push(f);
  }

  /** @type {Record<string, number>} */
  const excludedCounts = {};
  /** @type {{ file: string, line: number, value: string, rule: string, detail: string }[]} */
  const excludedList = [];
  const report = {
    tool: 'find-magic-strings',
    version: TOOL_VERSION,
    base: { ref: baseRef, mergeBase: base },
    head,
    typescript: /** @type {{ version: string, typeInfo: 'full' | 'partial' | 'none' | 'disabled', probes: number } | null} */ (null),
    config: { path: configPath, warnings },
    files: {
      scanned: scanned.length,
      skipped: skipped.length,
      skippedByReason: Object.fromEntries(
        sortBy([...new Set(skipped.map((s) => s.reason))], (r) => r).map((r) => [r, skipped.filter((s) => s.reason === r).length]),
      ),
      otherFiles,
      scannedPaths: opts.verbose ? scanned.map((f) => f.path) : undefined,
      skippedPaths: opts.verbose ? skipped : undefined,
    },
    summary: { violations: 0, review: 0, excluded: excludedCounts },
    candidates: /** @type {Candidate[]} */ ([]),
    excluded: /** @type {typeof excludedList | undefined} */ (undefined),
  };
  if (scanned.length === 0) return report;

  const { ts } = loadTypeScript(root, opts.typescript, scanned.map((f) => path.dirname(f.path)));

  /** @type {Map<string, number>} */
  const delta = new Map();
  /** @type {Working[]} */
  const work = [];
  /** @type {Map<string, SourceFile>} */
  const headFiles = new Map();

  for (const f of scanned) {
    const abs = path.join(root, f.path);
    const text = fs.readFileSync(abs, 'utf8');
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(f.path, ts));
    headFiles.set(f.path, sf);
    const lits = collectLiterals(ts, sf);
    for (const l of lits) delta.set(l.value, (delta.get(l.value) ?? 0) + 1);
    if (f.oldPath !== null) {
      const oldText = fileAtCommit(root, base, f.oldPath);
      if (oldText !== null) {
        const oldSf = ts.createSourceFile(f.oldPath, oldText, ts.ScriptTarget.Latest, true, scriptKind(f.oldPath, ts));
        for (const l of collectLiterals(ts, oldSf)) delta.set(l.value, (delta.get(l.value) ?? 0) - 1);
      }
    }
    const lines = text.split(/\r?\n/);
    for (const lit of lits) {
      if (!onAddedLine(lit, f.addedLines)) continue;
      work.push({
        file: f.path,
        lit,
        sf,
        lines,
        verdict: 'PENDING',
        rule: 'REVIEW',
        adr: null,
        context: '',
        detail: '',
        typed: null,
        redacted: false,
        existing: [],
      });
    }
  }

  // Step 1 — per-literal rules, fixed order, first match wins.
  for (const w of work) {
    const v = w.lit.value;
    /** @param {string} rule @param {string} [detail] */
    const exclude = (rule, detail = '') => {
      w.verdict = 'EXCLUDED';
      w.rule = rule;
      w.detail = detail;
    };
    if (staticLength(v) < config.minLength) exclude('E-TRIVIAL');
    else if (isSuppressed(w.lines, w.lit.line)) exclude('E-SUPPRESSED');
    else if (config.allowValues.includes(v)) exclude('E-ALLOWLISTED');
    else if (looksLikeSecret(v)) {
      w.verdict = 'VIOLATION';
      w.rule = 'V-SECRET';
      w.adr = 'ADR-IN-007';
      w.context = 'secret';
      w.redacted = true;
    } else {
      const s = classifySyntax(ts, w.lit, w.sf, config);
      if (s.verdict === 'EXCLUDED') exclude(s.rule, s.detail);
      else if ((delta.get(v) ?? 0) <= 0) exclude('E-MOVED');
      else {
        w.verdict = s.verdict;
        w.rule = s.rule;
        w.adr = s.adr;
        w.context = s.context;
        w.detail = s.detail;
      }
    }
  }

  // Step 2 — type-check probe for literals still pending.
  const prober = opts.types && config.typedLiteralsAreSafe ? new TypeProber(ts, root, opts.maxProbes) : null;
  let filesWithTypes = 0;
  if (prober !== null) {
    for (const f of scanned) {
      const abs = path.join(root, f.path);
      if (!prober.hasTypes(abs)) continue;
      filesWithTypes += 1;
      const pending = work.filter((w) => w.file === f.path && w.verdict === 'PENDING');
      const sf = headFiles.get(f.path);
      if (pending.length === 0 || sf === undefined) continue;
      const typed = prober.probeFile(
        abs,
        pending.map((w) => w.lit),
        sf,
      );
      pending.forEach((w, i) => {
        w.typed = typed[i];
        if (w.typed === true) {
          w.verdict = 'EXCLUDED';
          w.rule = 'E-TYPED';
        }
      });
    }
  }
  report.typescript = {
    version: ts.version,
    typeInfo:
      prober === null ? 'disabled' : filesWithTypes === scanned.length ? 'full' : filesWithTypes === 0 ? 'none' : 'partial',
    probes: prober === null ? 0 : prober.probesRun,
  };

  // Step 3 — an existing named definition with the same value.
  const lookup = [
    ...new Set(
      work
        .filter((w) => w.verdict !== 'EXCLUDED' && w.rule !== 'V-SECRET' && !w.lit.value.includes(PLACEHOLDER))
        .map((w) => w.lit.value)
        .filter((v) => !/['"`\\\n\r]/.test(v)),
    ),
  ].sort();
  if (lookup.length > 0) {
    const needles = lookup.flatMap((v) => [`'${v}'`, `"${v}"`, `\`${v}\``]);
    const files = new Set(
      grepFiles(root, needles, SOURCE_PATHSPECS)
        .filter((p) => isScannedExtension(p) && skipReason(p, config) === null)
        .slice(0, MAX_DEFINITION_FILES),
    );
    for (const p of headFiles.keys()) files.add(p);
    /** @type {Map<string, { name: string, file: string, line: number }[]>} */
    const defs = new Map();
    for (const p of sortBy([...files], (x) => x)) {
      let sf = headFiles.get(p);
      if (sf === undefined) {
        const abs = path.join(root, p);
        if (!fs.existsSync(abs)) continue;
        sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(p, ts));
      }
      for (const [value, list] of collectDefinitions(ts, sf)) {
        if (!lookup.includes(value)) continue;
        const all = defs.get(value) ?? [];
        for (const d of list) all.push({ name: d.name, file: p, line: d.line });
        defs.set(value, all);
      }
    }
    for (const w of work) {
      if (w.verdict === 'EXCLUDED' || w.rule === 'V-SECRET') continue;
      w.existing = sortBy(defs.get(w.lit.value) ?? [], (d) => `${d.file}\0${String(d.line).padStart(8, '0')}\0${d.name}`);
      if (w.verdict === 'PENDING' && w.existing.length > 0) {
        w.verdict = 'VIOLATION';
        w.rule = 'V-EXISTING-CONSTANT';
      }
    }
  }

  // Step 4 — the same value repeated in the PR, then URL/path shapes; the rest needs review.
  /** @type {Map<string, number>} */
  const occurrences = new Map();
  for (const w of work) {
    if (w.verdict === 'EXCLUDED' || w.rule === 'V-SECRET') continue;
    occurrences.set(w.lit.value, (occurrences.get(w.lit.value) ?? 0) + 1);
  }
  for (const w of work) {
    if (w.verdict !== 'PENDING') continue;
    if ((occurrences.get(w.lit.value) ?? 0) >= config.duplicateThreshold) {
      w.verdict = 'VIOLATION';
      w.rule = 'V-DUPLICATED';
    } else if (['url', 'path'].includes(shapeOf(w.lit.value))) {
      w.verdict = 'VIOLATION';
      w.rule = 'V-URL-OR-PATH';
    }
  }

  // Output, sorted by file, line, column.
  const ordered = sortBy(
    work,
    (w) => `${w.file}\0${String(w.lit.line).padStart(8, '0')}\0${String(w.lit.column).padStart(8, '0')}`,
  );
  let n = 0;
  for (const w of ordered) {
    if (w.verdict === 'EXCLUDED') {
      excludedCounts[w.rule] = (excludedCounts[w.rule] ?? 0) + 1;
      if (opts.verbose) {
        excludedList.push({ file: w.file, line: w.lit.line, value: w.lit.value, rule: w.rule, detail: w.detail });
      }
      continue;
    }
    n += 1;
    const rawLine = (w.lines[w.lit.line - 1] ?? '').trim();
    const value = w.redacted ? `[REDACTED: ${w.lit.value.length} chars]` : w.lit.value;
    let code = w.redacted ? rawLine.split(w.lit.value).join('[REDACTED]') : rawLine;
    if (code.length > MAX_CODE) code = `${code.slice(0, MAX_CODE - 1)}…`;
    report.candidates.push({
      id: `MS-${String(n).padStart(3, '0')}`,
      file: w.file,
      line: w.lit.line,
      column: w.lit.column,
      kind: w.lit.kind,
      value,
      shape: w.redacted ? 'secret' : shapeOf(w.lit.value),
      context: w.context,
      detail: w.detail,
      preclass: w.verdict === 'VIOLATION' ? 'VIOLATION' : 'REVIEW',
      rule: w.rule,
      adr: w.adr,
      typed: w.typed,
      occurrencesInPr: w.redacted ? 1 : (occurrences.get(w.lit.value) ?? 1),
      existingDefinitions: w.existing,
      code,
    });
  }
  const sortedCounts = Object.fromEntries(Object.entries(excludedCounts).sort(([a], [b]) => (a < b ? -1 : 1)));
  report.summary = {
    violations: report.candidates.filter((c) => c.preclass === 'VIOLATION').length,
    review: report.candidates.filter((c) => c.preclass === 'REVIEW').length,
    excluded: sortedCounts,
  };
  if (opts.verbose) report.excluded = excludedList;
  return report;
}

runIfMain(import.meta.url, run);
