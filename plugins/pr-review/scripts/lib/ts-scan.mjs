// @ts-check
/**
 * Shared pipeline of the TypeScript-only scanners (find-ts-convention-issues, find-zod-issues).
 *
 * Compares the working tree with the merge-base of HEAD and a base branch, parses every changed
 * TypeScript file with the repository's TypeScript compiler, runs the scanner's detector and keeps
 * the items introduced on an added line. Each scanner supplies only its rules, its detector and its
 * suppression marker; the same repository state always produces byte-identical output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scriptKind, sortBy } from './cli.mjs';
import { isTypeScriptFile, skipReason } from './config.mjs';
import { ScannerError } from './errors.mjs';
import { changedFiles, deletedFiles, fileAtCommit, headInfo, mergeBase, resolveBaseRef } from './git.mjs';
import { TypeProber } from './type-probe.mjs';
import { loadTypeScript } from './typescript-loader.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Node} Node */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('typescript').TypeChecker} TypeChecker */
/** @typedef {import('./git.mjs').ChangedFile} ChangedFile */

/**
 * One potential breach found in a file. `exempt` names the E-* rule when an exemption applies.
 * @template {string} [TRule=string]
 * @typedef {object} ScanItem
 * @property {TRule} rule
 * @property {number} line Anchor line, 1-based (0 for file and directory names).
 * @property {number} column Anchor column, 1-based.
 * @property {number} startLine First line of the span whose change makes the item "introduced".
 * @property {number} endLine Last line of that span.
 * @property {string} subject What the report names (identifier or short code).
 * @property {string} detail Rule-specific context.
 * @property {string | null} expected Expected naming style, for naming rules.
 * @property {string | null} suggestion Deterministic replacement, when one exists.
 * @property {string} sig Signature used to tell moved code from introduced code.
 * @property {string | null} exempt
 */

/**
 * @typedef {object} RuleInfo
 * @property {'VIOLATION' | 'REVIEW'} preclass
 * @property {'blocking' | 'advisory'} severity
 * @property {string | null} adr
 */

/**
 * @typedef {object} ScanOptions
 * @property {string | null} base
 * @property {string} repo
 * @property {string | null} config
 * @property {string | null} typescript
 * @property {boolean} types
 * @property {boolean} verbose
 * @property {boolean} help
 */

/**
 * A loaded config section: only the keys the pipeline itself applies.
 * @typedef {object} LoadedConfig
 * @property {{ ignorePaths: readonly string[], disabledRules?: readonly string[] }} config
 * @property {string | null} path
 * @property {string[]} warnings
 */

/**
 * What a scanner plugs into the pipeline.
 * @typedef {object} Scanner
 * @property {string} tool
 * @property {string} version
 * @property {string} idPrefix Candidate ids are `<idPrefix>-001…`.
 * @property {Readonly<Record<string, RuleInfo>>} rules
 * @property {readonly string[]} ruleIds Rule ids in report order.
 * @property {string} marker Line marker that accepts a finding deliberately.
 * @property {(ts: TS, sf: SourceFile, rel: string, checker: TypeChecker | null) => ScanItem[]} detect
 *   Pure: depends only on the source text, the path and (when given) the type checker.
 * @property {(ctx: { ts: TS, base: string, file: ChangedFile, sf: SourceFile }) => { file: string, item: ScanItem }[]} [fileItems]
 *   Items about the file itself rather than its code (file and directory names), with line 0.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} file Repo-relative path (a directory ends with `/`).
 * @property {number} line 0 for file and directory names.
 * @property {number} column
 * @property {string} rule
 * @property {'VIOLATION' | 'REVIEW'} preclass
 * @property {'blocking' | 'advisory'} severity
 * @property {string | null} adr
 * @property {string} subject
 * @property {string} detail
 * @property {string | null} expected
 * @property {string | null} suggestion
 * @property {string} code
 */

/**
 * @typedef {object} Working
 * @property {string} file
 * @property {ScanItem} item
 * @property {string[]} lines
 * @property {'EXCLUDED' | 'CANDIDATE'} verdict
 * @property {string} rule Final rule: the item's rule, or the E-* rule that excluded it.
 */

const MAX_SUBJECT = 60;
const MAX_DETAIL = 120;
const MAX_CODE = 160;

/**
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
export function clip(s, max = MAX_SUBJECT) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Builds a scan item anchored on a node.
 * @template {string} TRule
 * @param {SourceFile} sf
 * @param {TRule} rule
 * @param {Node} anchor Node whose start gives the reported line and column.
 * @param {Node} span Node whose lines make the item "introduced" when one of them is added.
 * @param {{ subject: string, sig: string, detail?: string, expected?: string | null, suggestion?: string | null, exempt?: string | null }} data
 * @returns {ScanItem<TRule>}
 */
export function rawItem(sf, rule, anchor, span, data) {
  /** @param {number} pos */
  const lc = (pos) => sf.getLineAndCharacterOfPosition(pos);
  const a = lc(anchor.getStart(sf));
  return {
    rule,
    line: a.line + 1,
    column: a.character + 1,
    startLine: lc(span.getStart(sf)).line + 1,
    endLine: lc(span.getEnd()).line + 1,
    subject: clip(data.subject),
    detail: clip(data.detail ?? '', MAX_DETAIL),
    expected: data.expected ?? null,
    suggestion: data.suggestion ?? null,
    sig: `${rule}|${data.sig}`,
    exempt: data.exempt ?? null,
  };
}

/**
 * Parses the options shared by the TypeScript scanners.
 * @param {string[]} argv
 * @returns {ScanOptions}
 */
export function parseScanArgs(argv) {
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
  const envTs = process.env.PR_REVIEW_TYPESCRIPT;
  return {
    base: typeof v.base === 'string' ? v.base : null,
    repo: typeof v.repo === 'string' ? v.repo : process.cwd(),
    config: typeof v.config === 'string' ? v.config : null,
    typescript: typeof v.typescript === 'string' ? v.typescript : envTs !== undefined && envTs !== '' ? envTs : null,
    types: v['no-types'] !== true,
    verbose: v.verbose === true,
    help: v.help === true,
  };
}

/**
 * The marker accepts its own line, or the next line when it sits on a comment-only line.
 * @param {string[]} lines
 * @param {number} line
 * @param {string} marker
 * @returns {boolean}
 */
function isSuppressed(lines, line, marker) {
  const previous = (lines[line - 2] ?? '').trim();
  return (lines[line - 1] ?? '').includes(marker) || (/^(?:\/\/|\/\*|\*)/.test(previous) && previous.includes(marker));
}

/**
 * @param {ScanItem} item
 * @param {Set<number> | 'all'} added
 * @returns {boolean}
 */
function introducedOnAddedLine(item, added) {
  if (added === 'all') return true;
  for (let n = item.startLine; n <= item.endLine; n += 1) if (added.has(n)) return true;
  return false;
}

/**
 * @param {Map<string, number>} counts
 * @param {readonly ScanItem[]} items
 * @param {1 | -1} sign
 */
function tally(counts, items, sign) {
  for (const i of items) counts.set(i.sig, (counts.get(i.sig) ?? 0) + sign);
}

/**
 * Runs a scanner over the TypeScript files changed against the merge-base.
 * @param {string} root Repository root.
 * @param {ScanOptions} opts
 * @param {LoadedConfig} loaded
 * @param {Scanner} scanner
 * @returns {object} The JSON report.
 */
export function scanChanges(root, opts, loaded, scanner) {
  const { config } = loaded;
  const disabledRules = config.disabledRules ?? [];
  const baseRef = resolveBaseRef(root, opts.base);
  const base = mergeBase(root, baseRef);
  const head = headInfo(root);
  const changed = changedFiles(root, base);

  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  const scanned = [];
  let otherFiles = 0;
  for (const f of changed) {
    if (!isTypeScriptFile(f.path)) {
      otherFiles += 1;
      continue;
    }
    const reason = skipReason(f.path, config);
    if (reason !== null) skipped.push({ path: f.path, reason });
    else if (fs.existsSync(path.join(root, f.path))) scanned.push(f);
  }

  /** @type {Record<string, number>} */
  const excludedCounts = {};
  /** @type {{ file: string, line: number, rule: string, excludedBy: string, subject: string }[]} */
  const excludedList = [];
  const report = {
    tool: scanner.tool,
    version: scanner.version,
    base: { ref: baseRef, mergeBase: base },
    head,
    typescript: /** @type {{ version: string, typeInfo: 'full' | 'partial' | 'none' | 'disabled' } | null} */ (null),
    config: {
      path: loaded.path,
      warnings: loaded.warnings,
      ...(config.disabledRules === undefined ? {} : { disabledRules: config.disabledRules }),
    },
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
    summary: { blocking: 0, advisory: 0, review: 0, excluded: excludedCounts },
    candidates: /** @type {Candidate[]} */ ([]),
    excluded: /** @type {typeof excludedList | undefined} */ (undefined),
  };
  if (scanned.length === 0) return report;

  const { ts } = loadTypeScript(root, opts.typescript, scanned.map((f) => path.dirname(f.path)));
  const prober = opts.types ? new TypeProber(ts, root, 0) : null;
  /** @type {Map<import('typescript').Program, TypeChecker>} */
  const checkers = new Map();
  /** @param {string} rel @param {string} text @returns {SourceFile} */
  const parse = (rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel, ts));

  /** Signature balance: > 0 means more occurrences after the PR than before (introduced, not moved). */
  /** @type {Map<string, number>} */
  const balance = new Map();
  /** @type {Working[]} */
  const work = [];
  let filesWithTypes = 0;

  for (const f of scanned) {
    const abs = path.join(root, f.path);
    const text = fs.readFileSync(abs, 'utf8');
    const project = prober === null ? null : prober.projectFor(abs);
    const programSf = project === null ? undefined : project.program.getSourceFile(abs);
    /** @type {TypeChecker | null} */
    let checker = null;
    if (project !== null && programSf !== undefined && programSf.text === text) {
      filesWithTypes += 1;
      checker = checkers.get(project.program) ?? project.program.getTypeChecker();
      checkers.set(project.program, checker);
    }
    const sf = checker !== null && programSf !== undefined ? programSf : parse(f.path, text);
    const items = scanner.detect(ts, sf, f.path, checker);
    // Signatures do not depend on the checker, so typed and untyped items balance against each other.
    tally(balance, items, 1);
    if (f.oldPath !== null) {
      const oldText = fileAtCommit(root, base, f.oldPath);
      if (oldText !== null) tally(balance, scanner.detect(ts, parse(f.oldPath, oldText), f.oldPath, null), -1);
    }

    const lines = text.split(/\r?\n/);
    for (const item of items) {
      if (introducedOnAddedLine(item, f.addedLines)) work.push({ file: f.path, item, lines, verdict: 'CANDIDATE', rule: item.rule });
    }
    if (scanner.fileItems !== undefined) {
      for (const { file, item } of scanner.fileItems({ ts, base, file: f, sf })) {
        work.push({ file, item, lines: [], verdict: 'CANDIDATE', rule: item.rule });
      }
    }
  }

  // Code moved out of deleted files is not introduced either.
  for (const p of deletedFiles(root, base)) {
    if (!isTypeScriptFile(p) || skipReason(p, config) !== null) continue;
    const oldText = fileAtCommit(root, base, p);
    if (oldText !== null) tally(balance, scanner.detect(ts, parse(p, oldText), p, null), -1);
  }

  report.typescript = {
    version: ts.version,
    typeInfo: prober === null ? 'disabled' : filesWithTypes === scanned.length ? 'full' : filesWithTypes === 0 ? 'none' : 'partial',
  };

  // Per-item rules, fixed order, first match wins.
  for (const w of work) {
    /** @param {string} rule */
    const exclude = (rule) => {
      w.verdict = 'EXCLUDED';
      w.rule = rule;
    };
    if (disabledRules.includes(w.item.rule)) exclude('E-DISABLED');
    else if (w.item.line > 0 && isSuppressed(w.lines, w.item.line, scanner.marker)) exclude('E-SUPPRESSED');
    else if (w.item.exempt !== null) exclude(w.item.exempt);
    else if (w.item.line > 0 && (balance.get(w.item.sig) ?? 0) <= 0) exclude('E-MOVED');
  }

  // Output, sorted by file, line, column, rule order.
  const ordered = sortBy(
    work,
    (w) =>
      `${w.file}\0${String(w.item.line).padStart(8, '0')}\0${String(w.item.column).padStart(8, '0')}\0${String(scanner.ruleIds.indexOf(w.item.rule)).padStart(3, '0')}`,
  );
  let n = 0;
  for (const w of ordered) {
    if (w.verdict === 'EXCLUDED') {
      excludedCounts[w.rule] = (excludedCounts[w.rule] ?? 0) + 1;
      if (opts.verbose) {
        excludedList.push({ file: w.file, line: w.item.line, rule: w.item.rule, excludedBy: w.rule, subject: w.item.subject });
      }
      continue;
    }
    const info = scanner.rules[w.item.rule];
    if (info === undefined) throw new Error(`${scanner.tool}: rule ${w.item.rule} has no catalogue entry.`);
    n += 1;
    let code = w.item.line > 0 ? (w.lines[w.item.line - 1] ?? '').trim() : '';
    if (code.length > MAX_CODE) code = `${code.slice(0, MAX_CODE - 1)}…`;
    report.candidates.push({
      id: `${scanner.idPrefix}-${String(n).padStart(3, '0')}`,
      file: w.file,
      line: w.item.line,
      column: w.item.column,
      rule: w.item.rule,
      preclass: info.preclass,
      severity: info.severity,
      adr: info.adr,
      subject: w.item.subject,
      detail: w.item.detail,
      expected: w.item.expected,
      suggestion: w.item.suggestion,
      code,
    });
  }
  report.summary = {
    blocking: report.candidates.filter((c) => c.severity === 'blocking').length,
    advisory: report.candidates.filter((c) => c.severity === 'advisory' && c.preclass === 'VIOLATION').length,
    review: report.candidates.filter((c) => c.preclass === 'REVIEW').length,
    excluded: Object.fromEntries(Object.entries(excludedCounts).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  if (opts.verbose) report.excluded = excludedList;
  return report;
}
