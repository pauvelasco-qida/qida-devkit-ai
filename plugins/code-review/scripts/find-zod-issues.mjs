#!/usr/bin/env node
// @ts-check
/**
 * find-zod-issues — deterministic candidate extractor for the zod-reviewer agent.
 *
 * Reports each `.parse` / `.parseAsync` call on a Zod schema introduced on an added line (the
 * conventions require `safeParse` / `safeParseAsync`), with the rules of lib/zod-detect.mjs run
 * through the shared pipeline of lib/ts-scan.mjs. Output is JSON on stdout; the same repository
 * state always produces byte-identical output.
 *
 * Exit codes: 0 ok (whatever the findings), 2 usage/config error, 3 environment error.
 */
import path from 'node:path';
import { SCOPE_HELP, runIfMain } from './lib/cli.mjs';
import { loadZodConfig } from './lib/config.mjs';
import { declaredPackages } from './lib/packages.mjs';
import { repoRoot } from './lib/git.mjs';
import { parseScanArgs, scanChanges } from './lib/ts-scan.mjs';
import { RULES, RULE_IDS, SUPPRESSION_MARKER, detect } from './lib/zod-detect.mjs';

export const TOOL_VERSION = '0.3.0';

const HELP = `Usage: find-zod-issues.mjs [options]

Lists Zod .parse / .parseAsync calls introduced in the working tree (vs. the merge-base with
--base), which must be safeParse / safeParseAsync. Prints JSON on stdout.

Options:
  --base <ref>        Base branch/ref (default: origin/HEAD, then origin/main|master|develop, main|master|develop)
${SCOPE_HELP}  --repo <dir>        Repository directory (default: current directory)
  --config <file>     Config file (default: <repo>/.claude/code-review.json)
  --typescript <dir>  typescript package directory (default: auto; env CODE_REVIEW_TYPESCRIPT)
  --no-types          Do not build the type checker (faster; Zod schemas are recognised by syntax only)
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
  const packagesFor = declaredPackages(root);
  return scanChanges(root, opts, loadZodConfig(root, opts.config), {
    tool: 'find-zod-issues',
    version: TOOL_VERSION,
    idPrefix: 'ZOD',
    rules: RULES,
    ruleIds: RULE_IDS,
    marker: SUPPRESSION_MARKER,
    detect: (ts, sf, rel, checker) => detect(ts, sf, checker, packagesFor(rel)),
  });
}

runIfMain(import.meta.url, run);
