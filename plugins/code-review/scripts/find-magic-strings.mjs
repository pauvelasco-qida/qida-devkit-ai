#!/usr/bin/env node
// @ts-check
/**
 * find-magic-strings — deterministic candidate extractor for the magic-string-reviewer agent.
 *
 * Compares the working tree (or the index, or a commit) with the merge-base of HEAD and a base
 * branch, optionally limited to some paths, parses every changed
 * TS/JS file with the TypeScript compiler, and classifies every string literal on an added line
 * with a fixed, ordered rule set. Output is JSON on stdout; the same repository state always
 * produces byte-identical output.
 *
 * Exit codes: 0 ok (whatever the findings), 2 usage/config error, 3 environment error.
 */
import path from 'node:path';
import {
  classifySyntax,
  collectDefinitions,
  collectLiterals,
  secretFormatMatches,
  secretInfo,
  secretKind,
  shapeOf,
  staticLength,
} from './lib/classify.mjs';
import { SCOPE_HELP, runIfMain, sortBy } from './lib/cli.mjs';
import { isScannedExtension, loadConfig, skipReason } from './lib/config.mjs';
import { ScannerError } from './lib/errors.mjs';
import { filesAtTarget, grepFiles, repoRoot } from './lib/git.mjs';
import { PLACEHOLDER } from './lib/rules.mjs';
import {
  deletedSources,
  filePositions,
  suppressionChecker,
  tallyBy,
  openScan,
  openSources,
  parseScanArgs,
  targetReader,
  unreadWarning,
  unreadableWarning,
  sourceLines,
} from './lib/ts-scan.mjs';
import { holdsSecretText, redactRecords, snippetMasker } from './lib/redact.mjs';
import { TypeProber } from './lib/type-probe.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./lib/classify.mjs').Literal} Literal */
/** @typedef {import('./lib/config.mjs').MagicStringsConfig} MagicStringsConfig */
/** @typedef {import('./lib/ts-scan.mjs').FilePositions} FilePositions */
/**
 * Helpers of one scanned file, shared by all its literals.
 * @typedef {object} FileContext
 * @property {FilePositions} positions Git positions (reported positions are git's, like the diff).
 * @property {(line: number) => boolean} suppressed Marker check on the real source lines.
 * @property {(line: number) => string} snippet Masked snippet of a TypeScript line.
 */

export const TOOL_VERSION = '0.3.0';
const MAX_DEFINITION_FILES = 400;
const DEFAULT_MAX_PROBES = 1000;
const SUPPRESSION_MARKER = 'magic-string-ok';
const SOURCE_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'];

const HELP = `Usage: find-magic-strings.mjs [options]

Lists string literals added in the working tree (vs. the merge-base with --base) and classifies
them deterministically. Prints JSON on stdout.

Options:
  --base <ref>        Base branch/ref (default: origin/HEAD, then origin/main|master|develop, main|master|develop)
${SCOPE_HELP}  --repo <dir>        Repository directory (default: current directory)
  --config <file>     Config file (default: <repo>/.claude/code-review.json)
  --typescript <dir>  typescript package directory (default: auto; env CODE_REVIEW_TYPESCRIPT)
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
 * @property {FileContext} ctx The file's shared helpers (one object per file, not per literal).
 * @property {'format' | 'heuristic' | null} secret How the value looks like a secret, computed once.
 * @property {string[]} secretMatches Its known-format matches, computed with it.
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
 * Whether a value's known-format credentials are all obvious placeholders. Only the matched
 * tokens are judged, never the text around them (`'Your token: ghp_…'` stays a secret): each token
 * must be made of plain words including a placeholder word (`sk-0000000000000000-your-key`, `ghp_xxxx…`;
 * see `isPlaceholderToken`), or be AWS's documented `…EXAMPLE` key or an all-X AWS key (`AKIAXXXX…`). Placeholders are excluded,
 * never printed.
 * @param {string} value
 * @param {readonly string[]} [matches] The value's known-format matches, when already computed.
 * @returns {boolean}
 */
function isPlaceholder(value, matches = secretFormatMatches(value)) {
  return matches.length > 0 && matches.every((m) => isPlaceholderToken(m) || /^(?:AKIA|ASIA)(?:[0-9A-Z]{9}EXAMPLE|X{16})$/.test(m));
}

/** Placeholder words, or a run of `x`. */
const PLACEHOLDER_WORD = /^(?:your|example|placeholder|dummy|fake|sample|changeme|replace|replaceme|x{4,})$/;

/**
 * A matched token is a placeholder only when it is made of plain words: every delimited segment
 * is a single-case word (`your`, `YOUR`, `XXXX`), a short number or a zero-filled id (`T00000000`,
 * as in Slack's documented webhook), and one is a placeholder word. A real key
 * with a placeholder-like suffix (`sk-proj-<random>-example`) keeps its random segment, so it
 * stays a secret.
 * @param {string} token
 * @returns {boolean}
 */
function isPlaceholderToken(token) {
  const segments = token.split(/[-_./:]+/).filter((s) => s !== '');
  return (
    segments.some((s) => PLACEHOLDER_WORD.test(s.toLowerCase())) &&
    segments.every((s) => /^(?:[a-z]{1,16}|[A-Z]{1,16}|[xX]{4,}|\d{1,4}|[A-Z]?0{4,})$/.test(s))
  );
}

/**
 * A value with its known-format matches removed, to judge what is left on its own.
 * @param {string} value
 * @param {readonly string[]} [matches]
 * @returns {string}
 */
function withoutFormatMatches(value, matches = secretFormatMatches(value)) {
  return matches.reduce((acc, m) => acc.split(m).join(' '), value);
}

/**
 * @param {string[]} argv
 * @returns {object} The JSON report.
 */
export function run(argv) {
  const opts = parseScanArgs(argv, { maxProbes: DEFAULT_MAX_PROBES });
  if (opts.help) return { help: HELP };

  const root = repoRoot(path.resolve(opts.repo));
  const { config, path: configPath, warnings } = loadConfig(root, opts.config);
  const { base, target, moves, scanned, header, files } = openScan(root, opts, config, isScannedExtension);

  /** @type {Record<string, number>} */
  const excludedCounts = {};
  /** @type {{ file: string, line: number, value: string, rule: string, detail: string }[]} */
  const excludedList = [];
  const report = {
    tool: 'find-magic-strings',
    version: TOOL_VERSION,
    ...header,
    typescript: /** @type {{ version: string, typeInfo: 'full' | 'partial' | 'none' | 'disabled', probes: number } | null} */ (null),
    config: { path: configPath, warnings },
    files,
    summary: { violations: 0, review: 0, excluded: excludedCounts },
    candidates: /** @type {Candidate[]} */ ([]),
    excluded: /** @type {typeof excludedList | undefined} */ (undefined),
    warnings: /** @type {string[] | undefined} */ (undefined),
  };
  // An allow-list entry in a credential format accepts that credential wherever it is inlined:
  // say so in every report, even one with nothing scanned (by position, never by value).
  const allowWarnings = config.allowValues.flatMap((v, i) =>
    secretKind(v) === 'format' ? [`magicStrings.allowValues[${i}] is in a credential format: it accepts a hardcoded credential (ADR-IN-007).`] : [],
  );
  if (scanned.length === 0) {
    if (allowWarnings.length > 0) report.warnings = allowWarnings;
    return report;
  }

  const { ts, parse, previous, unreadable } = openSources(root, opts, base, scanned);
  /** Value balance: > 0 means more occurrences after the PR than before (introduced, not moved). */
  /** @type {Map<string, number>} */
  const delta = new Map();
  /** @param {readonly Literal[]} lits @param {1 | -1} sign */
  const tally = (lits, sign) => tallyBy(delta, lits, sign, (l) => l.value);
  /** @type {Working[]} */
  const work = [];
  /** @type {Map<string, SourceFile>} */
  const headFiles = new Map();
  const read = targetReader(root, target, scanned);
  /** @type {string[]} */
  const unread = [];

  for (const f of scanned) {
    const abs = path.join(root, f.path);
    const text = read(f.path);
    if (text === null) {
      unread.push(f.path);
      continue;
    }
    const sf = parse(abs, text);
    headFiles.set(f.path, sf);
    const lits = collectLiterals(ts, sf);
    tally(lits, 1);
    const old = previous.get(f.path);
    previous.delete(f.path); // used once: released as soon as it is tallied
    if (old !== undefined) tally(collectLiterals(ts, parse(old.path, old.text)), -1);
    const positions = filePositions(sf);
    const added = lits.filter((lit) => positions.added(lit.line, lit.endLine, f.addedLines));
    if (added.length === 0) continue;
    const lines = sourceLines(sf);
    // Indexes the file's secret literals from `lits`, only when a snippet is printed.
    /**
     * Per literal, computed at most once and shared by the work items and the masker: its secret
     * kind (a piece of a private key split across literals counts as one), its format matches,
     * and whether a snippet must hide it.
     */
    /** @type {Map<Literal, { kind: 'format' | 'heuristic' | null, matches: string[], holds: boolean }>} */
    const infos = new Map();
    /** @param {Literal} l */
    const infoOf = (l) => {
      let hit = infos.get(l);
      if (hit === undefined) {
        const { kind, matches } = secretInfo(l.value);
        const holds = holdsSecretText(ts, l.node, l.value, kind);
        hit = { kind: kind ?? (holds ? 'heuristic' : null), matches, holds };
        infos.set(l, hit);
      }
      return hit;
    };
    /** @type {FileContext} */
    const ctx = { positions, suppressed: suppressionChecker(ts, sf, lines, SUPPRESSION_MARKER), snippet: snippetMasker(ts, sf, lines, () => lits.filter((l) => infoOf(l).holds)) };
    for (const lit of added) {
      work.push({
        file: f.path,
        lit,
        sf,
        ctx,
        secret: infoOf(lit).kind,
        secretMatches: infoOf(lit).matches,
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

  // Literals moved out of deleted files are not introduced either (read only when something can move).
  const deleted = work.length > 0 ? deletedSources(root, base, config, isScannedExtension, moves) : { sources: [], unreadable: [] };
  for (const d of deleted.sources) tally(collectLiterals(ts, parse(d.path, d.text)), -1);
  const baseWarnings = [...unreadWarning(unread), ...unreadableWarning([...unreadable, ...deleted.unreadable])];
  baseWarnings.unshift(...allowWarnings);

  // Step 1 — per-literal rules, fixed order, first match wins. A known credential format comes
  // before the inline marker, so a one-line comment cannot hide it (ADR-IN-007); only an explicit
  // `allowValues` entry (reviewed config) or an obvious placeholder value clears it. The entropy
  // heuristic can misfire on public ids and hashes, so it comes after the marker and can be accepted.
  for (const w of work) {
    const v = w.lit.value;
    /** @param {string} rule @param {string} [detail] */
    const exclude = (rule, detail = '') => {
      w.verdict = 'EXCLUDED';
      w.rule = rule;
      w.detail = detail;
    };
    const secret = () => {
      w.verdict = 'VIOLATION';
      w.rule = 'V-SECRET';
      w.adr = 'ADR-IN-007';
      w.context = 'secret';
      w.redacted = true;
    };
    if (config.allowValues.includes(v)) exclude('E-ALLOWLISTED');
    else if (w.secret === 'format') {
      // A placeholder credential next to a real opaque token is still a secret.
      const matches = w.secretMatches;
      if (isPlaceholder(v, matches) && secretKind(withoutFormatMatches(v, matches)) === null) exclude('E-PLACEHOLDER');
      else secret();
    } else if (staticLength(v) < config.minLength) exclude('E-TRIVIAL');
    else if (w.ctx.suppressed(w.lit.line)) exclude('E-SUPPRESSED');
    else if (w.secret === 'heuristic') secret();
    else {
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
  const lookup = new Set(
    work
      .filter((w) => w.verdict !== 'EXCLUDED' && w.rule !== 'V-SECRET' && !w.lit.value.includes(PLACEHOLDER))
      .map((w) => w.lit.value)
      .filter((v) => !/['"`\\\n\r]/.test(v)),
  );
  if (lookup.size > 0) {
    const needles = sortBy([...lookup], (v) => v).flatMap((v) => [`'${v}'`, `"${v}"`, `\`${v}\``]);
    /** @type {string[]} */
    let matches = [];
    try {
      matches = grepFiles(root, needles, SOURCE_PATHSPECS, target);
    } catch (e) {
      if (!(e instanceof ScannerError)) throw e;
      // Keep the report, but say that existing constants in other files were not searched.
      baseWarnings.push(`Existing-constant search skipped (${e.code}): ${e.message}`);
    }
    const files = new Set(
      matches
        .filter((p) => isScannedExtension(p) && skipReason(p, config) === null)
        .slice(0, MAX_DEFINITION_FILES),
    );
    for (const p of headFiles.keys()) files.add(p);
    /** @type {Map<string, { name: string, file: string, line: number }[]>} */
    const defs = new Map();
    // Other files holding a value are read on the reviewed side too (disk, index or commit).
    const others = filesAtTarget(root, target, sortBy([...files].filter((p) => !headFiles.has(p)), (x) => x)).texts;
    for (const p of sortBy([...files], (x) => x)) {
      let sf = headFiles.get(p);
      if (sf === undefined) {
        const text = others.get(p);
        if (text === undefined) continue;
        sf = parse(p, text);
      }
      /** @type {FilePositions | null} */
      let at = null;
      for (const [value, list] of collectDefinitions(ts, sf)) {
        if (!lookup.has(value)) continue;
        const all = defs.get(value) ?? [];
        at ??= filePositions(sf);
        // Git line numbers, like every other line of the report.
        for (const d of list) all.push({ name: d.name, file: p, line: at.report(d.line, 1).line });
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
        const value = w.secret !== null ? `[REDACTED: ${w.lit.value.length} chars]` : w.lit.value;
        excludedList.push({ file: w.file, line: w.ctx.positions.report(w.lit.line, w.lit.column).line, value, rule: w.rule, detail: w.detail });
      }
      continue;
    }
    n += 1;
    const value = w.redacted ? `[REDACTED: ${w.lit.value.length} chars]` : w.lit.value;
    const code = w.ctx.snippet(w.lit.line);
    const at = w.ctx.positions.report(w.lit.line, w.lit.column);
    report.candidates.push({
      id: `MS-${String(n).padStart(3, '0')}`,
      file: w.file,
      line: at.line,
      column: at.column,
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
  // The redaction boundary: every field quoting source (`value`, `code`, `detail`…).
  report.candidates = redactRecords(report.candidates);
  if (report.excluded !== undefined) report.excluded = redactRecords(report.excluded);
  if (baseWarnings.length > 0) report.warnings = baseWarnings;
  return report;
}

runIfMain(import.meta.url, run);
