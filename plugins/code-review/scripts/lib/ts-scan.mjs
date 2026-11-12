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
import { changedFiles, deletedFiles, filesAtCommit, headInfo, mergeBase, resolveBaseRef } from './git.mjs';
import { capText } from './classify.mjs';
import { clip, redactRecords, snippetMasker } from './redact.mjs';
import { TypeProber } from './type-probe.mjs';
import { loadTypeScript } from './typescript-loader.mjs';

/** Longest subject or detail kept on a scan item (items of base and deleted files included). */
const MAX_STORED = 400;

/**
 * Caps a stored text at MAX_STORED, at a separator (never inside a token, so masking still sees
 * every token whole), keeping a trailing call (`.parse(…)`) so the printed subject can show it.
 * @param {string} s
 * @returns {string}
 */
function capStored(s) {
  return clip(s, MAX_STORED, capText);
}

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
 * @property {number} maxProbes Type-check probe budget (0 when the scanner takes no --max-probes).
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
 * @property {FilePositions | null} positions Git positions of the file (null for file and directory names).
 * @property {(line: number) => boolean} suppressed
 * @property {(line: number) => string} snippet Masked snippet of a TypeScript line.
 * @property {'EXCLUDED' | 'CANDIDATE'} verdict
 * @property {string} rule Final rule: the item's rule, or the E-* rule that excluded it.
 */


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
    // Capped, not final: masked and clipped at output, only for the items printed. The cap is far
    // above the printed length, so the shown start (and a trailing call) are never affected.
    subject: capStored(data.subject),
    detail: capStored(data.detail ?? ''),
    expected: data.expected ?? null,
    // A call-form suggestion quotes the receiver like the subject: capped the same way. Any other
    // suggestion is code to paste and is kept whole.
    suggestion: data.suggestion === undefined || data.suggestion === null ? null : data.suggestion.endsWith('(…)') ? capStored(data.suggestion) : data.suggestion,
    sig: `${rule}|${data.sig}`,
    exempt: data.exempt ?? null,
  };
}

/**
 * Parses the options shared by every scanner. `--max-probes` is accepted only when the scanner
 * gives it a default.
 * @param {string[]} argv
 * @param {{ maxProbes?: number }} [defaults]
 * @returns {ScanOptions}
 */
export function parseScanArgs(argv, defaults = {}) {
  /** @type {NonNullable<import('node:util').ParseArgsConfig['options']>} */
  const options = {
    base: { type: 'string' },
    repo: { type: 'string' },
    config: { type: 'string' },
    typescript: { type: 'string' },
    'no-types': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  };
  if (defaults.maxProbes !== undefined) options['max-probes'] = { type: 'string' };
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: false, strict: true });
  } catch (e) {
    throw new ScannerError('USAGE', /** @type {Error} */ (e).message, 2, 'Run with --help.');
  }
  const v = parsed.values;
  const rawProbes = v['max-probes'];
  if (typeof rawProbes === 'string' && !/^\d+$/.test(rawProbes)) {
    throw new ScannerError('USAGE', '--max-probes must be an integer >= 0.', 2);
  }
  const maxProbes = typeof rawProbes === 'string' ? Number(rawProbes) : (defaults.maxProbes ?? 0);
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 0) {
    throw new ScannerError('USAGE', '--max-probes must be an integer >= 0.', 2);
  }
  const envTs = process.env.CODE_REVIEW_TYPESCRIPT;
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
 * Suppression check of one file. The marker accepts its own line, or the next line when it sits
 * on a comment-only line: a line whose every non-blank character belongs to a comment, as the
 * TypeScript scanner sees it (`// …`, a block comment or its continuation, or a JSX comment
 * `{/* … *\/}`, whose braces are allowed). Code before or after the comment on that line
 * (`/* x *\/ call(); // marker`, `* rate; // marker`) makes it a code line, whose marker covers
 * only itself. Comments are inspected only when a marker sits on the line above a finding.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {readonly string[]} lines From `sourceLines`.
 * @param {string} marker
 * @returns {(line: number) => boolean} Whether a finding on this 1-based TypeScript line is suppressed.
 */
export function suppressionChecker(ts, sf, lines, marker) {
  /** Comment-only verdict per line, so many findings under one marker line walk the tree once. */
  /** @type {Map<number, boolean>} */
  const commentOnly = new Map();
  return (line) => {
    if ((lines[line - 1] ?? '').includes(marker)) return true;
    if (!(lines[line - 2] ?? '').includes(marker)) return false;
    const hit = commentOnly.get(line - 2) ?? isCommentOnlyLine(ts, sf, line - 2);
    commentOnly.set(line - 2, hit);
    return hit;
  };
}

/**
 * Whether a 0-based TypeScript line is made only of comments (JSX comment braces allowed). Only
 * the nodes whose span touches the line are visited, and only the line's characters are marked.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {number} i
 * @returns {boolean}
 */
function isCommentOnlyLine(ts, sf, i) {
  const text = sf.text;
  const starts = sf.getLineStarts();
  const lineStart = starts[i] ?? text.length;
  const lineEnd = i + 1 < starts.length ? starts[i + 1] : text.length;
  /** Per character of the line: inside a comment. */
  const inComment = new Array(lineEnd - lineStart).fill(false);
  /** @type {Set<number>} */
  const seen = new Set();
  /** @param {number} pos */
  const mark = (pos) => {
    if (seen.has(pos)) return;
    seen.add(pos);
    /** @param {number} start @param {number} end */
    const fill = (start, end) => {
      for (let p = Math.max(start, lineStart); p < Math.min(end, lineEnd); p += 1) inComment[p - lineStart] = true;
    };
    ts.forEachLeadingCommentRange(text, pos, fill);
    ts.forEachTrailingCommentRange(text, pos, fill);
  };
  /** JSX text spans: visible text, never a comment, even when it reads `// …`. */
  /** @type {[number, number][]} */
  const jsxText = [];
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (node.end < lineStart || node.pos > lineEnd) return;
    if (ts.isJsxText(node)) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    mark(node.pos);
    mark(node.end);
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  for (const [from, to] of jsxText) {
    for (let p = Math.max(from, lineStart); p < Math.min(to, lineEnd); p += 1) inComment[p - lineStart] = false;
  }
  /** @type {number[]} */
  const code = [];
  let comment = false;
  for (let p = lineStart; p < lineEnd; p += 1) {
    if (/\s/.test(text[p])) continue;
    if (inComment[p - lineStart]) comment = true;
    else code.push(p);
  }
  // A JSX comment `{/* … */}`: only its two braces are outside the comment.
  const jsxBraces = code.length === 2 && text[code[0]] === '{' && text[code[1]] === '}';
  return comment && (code.length === 0 || jsxBraces);
}

/**
 * Git positions of one file: whether a span was added, and where an item is reported.
 * @typedef {object} FilePositions
 * @property {(startLine: number, endLine: number, added: Set<number> | 'all') => boolean} added
 *   Whether any line of a span (TypeScript lines) was added in the working tree.
 * @property {(line: number, column: number) => { line: number, column: number }} report
 *   Git line and column of a TypeScript line and column (0 stays 0: file names).
 */

/**
 * @param {SourceFile} sf
 * @returns {FilePositions}
 */
export function filePositions(sf) {
  const gitLines = gitLineMap(sf);
  return {
    added: (startLine, endLine, added) => onAddedLines(gitLines, startLine, endLine, added),
    report: (line, column) => reportPosition(sf, gitLines, line, column),
  };
}

/**
 * Git position (line and column, both 1-based, lines ending only at `\n`) of a TypeScript line
 * and column, for the report: the same numbers the diff and the PR show (0 stays 0: file names).
 * @param {SourceFile} sf
 * @param {readonly number[]} gitLines From `gitLineMap`.
 * @param {number} line TypeScript line.
 * @param {number} column TypeScript column.
 * @returns {{ line: number, column: number }}
 */
function reportPosition(sf, gitLines, line, column) {
  if (line <= 0) return { line: 0, column };
  const pos = (sf.getLineStarts()[line - 1] ?? 0) + column - 1;
  return { line: gitLines[line - 1] ?? line, column: pos - (sf.text.lastIndexOf('\n', pos - 1) + 1) + 1 };
}

/**
 * Lines of a source file as TypeScript numbers them (`\r\n`, `\n`, a lone `\r`, U+2028 and
 * U+2029 all break lines), without their terminators, so `lines[line - 1]` is the reported line.
 * @param {SourceFile} sf
 * @returns {string[]}
 */
export function sourceLines(sf) {
  const starts = sf.getLineStarts();
  return starts.map((s, i) =>
    sf.text.slice(s, i + 1 < starts.length ? starts[i + 1] : sf.text.length).replace(/(?:\r\n|[\r\n\u2028\u2029])$/, ''),
  );
}

/**
 * Base content of each changed file at the merge-base (under its old path), in one git call.
 * New files have no entry.
 * @param {string} root
 * @param {string} base
 * @param {readonly ChangedFile[]} files
 * @returns {{ texts: Map<string, { path: string, text: string }>, unreadable: string[] }} Keyed by the file's current path.
 */
export function previousTexts(root, base, files) {
  const { texts, unreadable } = filesAtCommit(
    root,
    base,
    files.flatMap((f) => (f.oldPath === null ? [] : [f.oldPath])),
  );
  /** @type {Map<string, { path: string, text: string }>} */
  const out = new Map();
  for (const f of files) {
    const text = f.oldPath === null ? undefined : texts.get(f.oldPath);
    if (f.oldPath !== null && text !== undefined) out.set(f.path, { path: f.oldPath, text });
  }
  return { texts: out, unreadable };
}

/**
 * The report warning for base versions that could not be read, or none.
 * @param {readonly string[]} unreadable
 * @returns {string[]}
 */
export function unreadableWarning(unreadable) {
  if (unreadable.length === 0) return [];
  const list = [...unreadable].sort().slice(0, 5).join(', ');
  const more = unreadable.length > 5 ? ` and ${unreadable.length - 5} more` : '';
  return [`Base version unreadable for ${list}${more}: code moved from them may be reported as new.`];
}

/**
 * First steps every scanner shares: resolve the base and the merge-base, read HEAD, list the
 * changed files and split them into scanned, skipped and other files.
 * @param {string} root
 * @param {ScanOptions} opts
 * @param {{ ignorePaths: readonly string[] }} config
 * @param {(p: string) => boolean} isSource
 */
export function openScan(root, opts, config, isSource) {
  const baseRef = resolveBaseRef(root, opts.base);
  const base = mergeBase(root, baseRef);
  const head = headInfo(root);
  const parts = partitionChanged(root, changedFiles(root, base), config, isSource);
  return { base, scanned: parts.scanned, header: { base: { ref: baseRef, mergeBase: base }, head }, files: filesSection(parts, opts.verbose) };
}

/**
 * Loads the repository's TypeScript and returns it with a parser and the scanned files' base texts.
 * @param {string} root
 * @param {ScanOptions} opts
 * @param {string} base
 * @param {readonly ChangedFile[]} scanned
 */
export function openSources(root, opts, base, scanned) {
  const { ts } = loadTypeScript(root, opts.typescript, scanned.map((f) => path.dirname(f.path)));
  /** @param {string} rel @param {string} text @returns {SourceFile} */
  const parse = (rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel, ts));
  const { texts, unreadable } = previousTexts(root, base, scanned);
  return { ts, parse, previous: texts, unreadable };
}

/**
 * Git's line number (lines end only at `\n`) of each TypeScript line (which also ends at a lone
 * `\r`, U+2028 and U+2029), indexed by TypeScript line - 1.
 * @param {SourceFile} sf
 * @returns {number[]}
 */
function gitLineMap(sf) {
  const starts = sf.getLineStarts();
  /** @type {number[]} */
  const out = [];
  let gitLine = 1;
  let pos = 0;
  for (const s of starts) {
    for (; pos < s; pos += 1) if (sf.text.charCodeAt(pos) === 10) gitLine += 1;
    out.push(gitLine);
  }
  return out;
}

/**
 * Whether any line of a span (TypeScript line numbers) was added in the working tree (git line
 * numbers), translating through `gitLines` so unusual line breaks cannot shift the comparison.
 * @param {readonly number[]} gitLines From `gitLineMap`.
 * @param {number} startLine
 * @param {number} endLine
 * @param {Set<number> | 'all'} added
 * @returns {boolean}
 */
function onAddedLines(gitLines, startLine, endLine, added) {
  if (added === 'all') return true;
  const from = gitLines[startLine - 1] ?? startLine;
  const to = gitLines[endLine - 1] ?? endLine;
  for (let n = from; n <= to; n += 1) if (added.has(n)) return true;
  return false;
}

/**
 * @typedef {object} ChangedParts
 * @property {ChangedFile[]} scanned Source files to read.
 * @property {{ path: string, reason: string }[]} skipped Source files left out, with the reason.
 * @property {number} otherFiles Changed files the scanner does not read.
 */

/**
 * Splits the changed files into scanned sources, skipped sources and other files.
 * @param {string} root
 * @param {readonly ChangedFile[]} changed
 * @param {{ ignorePaths: readonly string[] }} config
 * @param {(p: string) => boolean} isSource
 * @returns {ChangedParts}
 */
export function partitionChanged(root, changed, config, isSource) {
  /** @type {ChangedParts} */
  const parts = { scanned: [], skipped: [], otherFiles: 0 };
  for (const f of changed) {
    if (!isSource(f.path)) {
      parts.otherFiles += 1;
      continue;
    }
    const reason = skipReason(f.path, config);
    if (reason !== null) parts.skipped.push({ path: f.path, reason });
    else if (fs.existsSync(path.join(root, f.path))) parts.scanned.push(f);
  }
  return parts;
}

/**
 * The `files` section of a report.
 * @param {ChangedParts} parts
 * @param {boolean} verbose
 */
export function filesSection({ scanned, skipped, otherFiles }, verbose) {
  /** @type {Record<string, number>} */
  const skippedByReason = {};
  for (const s of sortBy(skipped, (x) => x.reason)) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  return {
    scanned: scanned.length,
    skipped: skipped.length,
    skippedByReason,
    otherFiles,
    scannedPaths: verbose ? scanned.map((f) => f.path) : undefined,
    skippedPaths: verbose ? skipped : undefined,
  };
}

/**
 * Base content of the source files the PR deletes: code moved out of them is not introduced.
 * @param {string} root
 * @param {string} base Merge-base sha.
 * @param {{ ignorePaths: readonly string[] }} config
 * @param {(p: string) => boolean} isSource
 * @returns {{ sources: { path: string, text: string }[], unreadable: string[] }}
 */
export function deletedSources(root, base, config, isSource) {
  const paths = deletedFiles(root, base).filter((p) => isSource(p) && skipReason(p, config) === null);
  const { texts, unreadable } = filesAtCommit(root, base, paths);
  return {
    sources: paths.flatMap((p) => {
      const text = texts.get(p);
      return text === undefined ? [] : [{ path: p, text }];
    }),
    unreadable,
  };
}

/** Balance key of a scan item. @param {ScanItem} i */
const bySig = (i) => i.sig;

/**
 * The balance that tells moved code from introduced code: +1 per occurrence after the PR, -1 per
 * occurrence before it, by key (a scan item's signature, a literal's value). > 0 means introduced.
 * @template T
 * @param {Map<string, number>} counts
 * @param {readonly T[]} items
 * @param {1 | -1} sign
 * @param {(item: T) => string} key
 */
export function tallyBy(counts, items, sign, key) {
  for (const i of items) counts.set(key(i), (counts.get(key(i)) ?? 0) + sign);
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
  const { base, scanned, header, files } = openScan(root, opts, config, isTypeScriptFile);

  /** @type {Record<string, number>} */
  const excludedCounts = {};
  /** @type {{ file: string, line: number, rule: string, excludedBy: string, subject: string }[]} */
  const excludedList = [];
  const report = {
    tool: scanner.tool,
    version: scanner.version,
    ...header,
    typescript: /** @type {{ version: string, typeInfo: 'full' | 'partial' | 'none' | 'disabled' } | null} */ (null),
    config: {
      path: loaded.path,
      warnings: loaded.warnings,
      ...(config.disabledRules === undefined ? {} : { disabledRules: config.disabledRules }),
    },
    files,
    summary: { blocking: 0, advisory: 0, review: 0, excluded: excludedCounts },
    candidates: /** @type {Candidate[]} */ ([]),
    excluded: /** @type {typeof excludedList | undefined} */ (undefined),
    warnings: /** @type {string[] | undefined} */ (undefined),
  };
  if (scanned.length === 0) return report;

  const { ts, parse, previous, unreadable } = openSources(root, opts, base, scanned);
  const prober = opts.types ? new TypeProber(ts, root, 0) : null;
  /** @type {Map<import('typescript').Program, TypeChecker>} */
  const checkers = new Map();

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
    tallyBy(balance, items, 1, bySig);
    const old = previous.get(f.path);
    previous.delete(f.path); // used once: released as soon as it is tallied
    if (old !== undefined) tallyBy(balance, scanner.detect(ts, parse(old.path, old.text), old.path, null), -1, bySig);

    const positions = filePositions(sf);
    const introduced = items.filter((item) => positions.added(item.startLine, item.endLine, f.addedLines));
    if (introduced.length > 0) {
      const lines = sourceLines(sf);
      const suppressed = suppressionChecker(ts, sf, lines, scanner.marker);
      const snippet = snippetMasker(ts, sf, lines);
      for (const item of introduced) {
        work.push({ file: f.path, item, positions, suppressed, snippet, verdict: 'CANDIDATE', rule: item.rule });
      }
    }
    if (scanner.fileItems !== undefined) {
      for (const { file, item } of scanner.fileItems({ ts, base, file: f, sf })) {
        work.push({ file, item, positions: null, suppressed: () => false, snippet: () => '', verdict: 'CANDIDATE', rule: item.rule });
      }
    }
  }

  // Code moved out of deleted files is not introduced either (read only when something can move).
  const movable = work.some((w) => w.item.line > 0);
  const deleted = movable ? deletedSources(root, base, config, isTypeScriptFile) : { sources: [], unreadable: [] };
  for (const d of deleted.sources) tallyBy(balance, scanner.detect(ts, parse(d.path, d.text), d.path, null), -1, bySig);
  const baseWarnings = unreadableWarning([...unreadable, ...deleted.unreadable]);
  if (baseWarnings.length > 0) report.warnings = baseWarnings;

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
    else if (w.item.line > 0 && w.suppressed(w.item.line)) exclude('E-SUPPRESSED');
    else if (w.item.exempt !== null) exclude(w.item.exempt);
    else if (w.item.line > 0 && (balance.get(w.item.sig) ?? 0) <= 0) exclude('E-MOVED');
  }

  /** @param {Working} w */
  const position = (w) => (w.positions === null ? { line: 0, column: w.item.column } : w.positions.report(w.item.line, w.item.column));

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
        excludedList.push({ file: w.file, line: position(w).line, rule: w.item.rule, excludedBy: w.rule, subject: w.item.subject });
      }
      continue;
    }
    const info = scanner.rules[w.item.rule];
    if (info === undefined) throw new Error(`${scanner.tool}: rule ${w.item.rule} has no catalogue entry.`);
    n += 1;
    const code = w.item.line > 0 ? w.snippet(w.item.line) : '';
    const at = position(w);
    report.candidates.push({
      id: `${scanner.idPrefix}-${String(n).padStart(3, '0')}`,
      file: w.file,
      line: at.line,
      column: at.column,
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
  // The redaction boundary: every printed string, whatever its field.
  report.candidates = redactRecords(report.candidates);
  if (report.excluded !== undefined) report.excluded = redactRecords(report.excluded);
  return report;
}
