#!/usr/bin/env node
// @ts-check
/**
 * find-ts-convention-issues — deterministic candidate extractor for the ts-conventions-reviewer agent.
 *
 * Reports each TypeScript-convention breach introduced on an added line, with the fixed rule set of
 * lib/ts-rules.mjs and lib/ts-detect.mjs, run through the shared pipeline of lib/ts-scan.mjs.
 * Output is JSON on stdout; the same repository state always produces byte-identical output.
 *
 * Exit codes: 0 ok (whatever the findings), 2 usage/config error, 3 environment error.
 */
import path from 'node:path';
import { runIfMain } from './lib/cli.mjs';
import { globToRegExp, loadTsConventionsConfig } from './lib/config.mjs';
import { pathExistsAtCommit, repoRoot } from './lib/git.mjs';
import { detect, directoryNameIssue, exportedNames, fileNameIssue } from './lib/ts-detect.mjs';
import { PASCAL_CASE_FACTORIES, RULES, RULE_IDS, SUPPRESSION_MARKER } from './lib/ts-rules.mjs';
import { parseScanArgs, scanChanges } from './lib/ts-scan.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./lib/git.mjs').ChangedFile} ChangedFile */
/** @typedef {import('./lib/ts-rules.mjs').RuleId} RuleId */
/** @typedef {import('./lib/ts-scan.mjs').ScanItem<RuleId>} RawItem */

export const TOOL_VERSION = '0.2.0';

const HELP = `Usage: find-ts-convention-issues.mjs [options]

Lists TypeScript convention breaches introduced in the working tree (vs. the merge-base with
--base) and classifies them deterministically. Prints JSON on stdout.

Options:
  --base <ref>        Base branch/ref (default: origin/HEAD, then origin/main|master|develop, main|master|develop)
  --repo <dir>        Repository directory (default: current directory)
  --config <file>     Config file (default: <repo>/.claude/pr-review.json)
  --typescript <dir>  typescript package directory (default: auto; env PR_REVIEW_TYPESCRIPT)
  --no-types          Do not build the type checker (faster; the intersection rule falls back to syntax)
  --verbose           Also list excluded items
  -h, --help          Show this help
`;

/**
 * @param {string[]} argv
 * @returns {object} The JSON report.
 */
export function run(argv) {
  const opts = parseScanArgs(argv);
  if (opts.help) return { help: HELP };

  const root = repoRoot(path.resolve(opts.repo));
  const loaded = loadTsConventionsConfig(root, opts.config, RULE_IDS);
  const factories = new Set([...PASCAL_CASE_FACTORIES, ...loaded.config.pascalCaseFactories]);
  const defaultExportRes = loaded.config.defaultExportPaths.map(globToRegExp);
  /** @type {Set<string>} */
  const seenDirs = new Set();

  return scanChanges(root, opts, loaded, {
    tool: 'find-ts-convention-issues',
    version: TOOL_VERSION,
    idPrefix: 'TC',
    rules: RULES,
    ruleIds: RULE_IDS,
    marker: SUPPRESSION_MARKER,
    detect: (ts, sf, rel, checker) =>
      detect(
        ts,
        sf,
        { isTsx: rel.endsWith('.tsx'), defaultExportAllowed: defaultExportRes.some((re) => re.test(rel)), pascalCaseFactories: factories },
        checker,
      ),
    fileItems: ({ ts, base, file, sf }) => nameItems(ts, root, base, file, sf, seenDirs),
  });
}

/**
 * File and directory names this PR introduces: new files, renamed files whose name changed,
 * and directories absent from the base (each directory once per run, through `seenDirs`).
 * @param {TS} ts
 * @param {string} root
 * @param {string} base
 * @param {ChangedFile} f
 * @param {SourceFile} sf
 * @param {Set<string>} seenDirs
 * @returns {{ file: string, item: RawItem }[]}
 */
function nameItems(ts, root, base, f, sf, seenDirs) {
  /** @type {{ file: string, item: RawItem }[]} */
  const out = [];
  const oldBase = f.oldPath === null ? null : f.oldPath.slice(f.oldPath.lastIndexOf('/') + 1);
  const newBase = f.path.slice(f.path.lastIndexOf('/') + 1);
  if (f.status === 'added' || f.status === 'untracked' || (f.status === 'renamed' && oldBase !== newBase)) {
    const issue = fileNameIssue(f.path, exportedNames(ts, sf));
    if (issue !== null) out.push({ file: f.path, item: nameItem('V-FILE-NAME', issue) });
  }
  if (f.status !== 'modified') {
    const segments = f.path.split('/').slice(0, -1);
    for (let i = 0; i < segments.length; i += 1) {
      const dir = segments.slice(0, i + 1).join('/');
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      if (pathExistsAtCommit(root, base, dir)) continue;
      const issue = directoryNameIssue(/** @type {string} */ (segments[i]));
      if (issue !== null) out.push({ file: `${dir}/`, item: nameItem('V-FILE-NAME', issue) });
    }
  }
  return out;
}

/**
 * A file- or directory-name item (no line, never "moved": the name itself is new).
 * @param {RuleId} rule
 * @param {{ subject: string, detail: string, expected: string, suggestion: string }} issue
 * @returns {RawItem}
 */
function nameItem(rule, issue) {
  return {
    rule,
    line: 0,
    column: 0,
    startLine: 0,
    endLine: 0,
    subject: issue.subject,
    detail: issue.detail,
    expected: issue.expected,
    suggestion: issue.suggestion,
    sig: `${rule}|${issue.subject}`,
    exempt: null,
  };
}

runIfMain(import.meta.url, run);
