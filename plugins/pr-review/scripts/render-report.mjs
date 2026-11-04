#!/usr/bin/env node
// @ts-check
/**
 * render-report — prints a reviewer agent's final report from its saved scan and its judgments.
 *
 * The agent runs its scanner with `--save`, judges each REVIEW candidate with one row of its
 * decision table, then passes the saved file and those rows here. Every text, count, section
 * and the result line come from lib/report.mjs, so the agent copies the output and writes nothing.
 *
 * Exit codes: 0 report printed, 2 usage error or judgments that do not fit the scan (message on
 * stderr, nothing on stdout), 1 internal error.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { REVIEWERS, RenderError, renderReport } from './lib/report.mjs';

const HELP = `Usage: render-report.mjs --reviewer <key> --scan <file> [--judge <id>=<row>]...

Prints the reviewer's markdown report, ending with its result line.

Options:
  --reviewer <key>    ${Object.keys(REVIEWERS).join(' | ')}
  --scan <file>       The scan JSON the scanner saved with --save (its "savedTo" path)
  --judge <id>=<row>  The decision-table row of one REVIEW candidate, e.g. MS-002=R3; once per REVIEW candidate
  -h, --help          Show this help
`;

/**
 * @param {string[]} argv
 * @returns {string} The report, or the help text.
 */
export function run(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        reviewer: { type: 'string' },
        scan: { type: 'string' },
        judge: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    throw new RenderError(/** @type {Error} */ (e).message);
  }
  const v = parsed.values;
  if (v.help === true) return HELP;
  const key = v.reviewer;
  if (typeof key !== 'string' || !Object.hasOwn(REVIEWERS, key)) {
    throw new RenderError(`--reviewer must be one of ${Object.keys(REVIEWERS).join(', ')}.`);
  }
  if (typeof v.scan !== 'string') throw new RenderError('--scan <file> is required.');

  /** @type {Map<string, string>} */
  const judgments = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const j of /** @type {string[]} */ (v.judge ?? [])) {
    const m = /^([A-Z]+-\d+)=([A-Z]\d+)$/.exec(j.trim());
    if (m === null) problems.push(`--judge ${j}: expected <id>=<row>, e.g. MS-002=R3.`);
    else if (judgments.has(m[1])) problems.push(`${m[1]} is judged more than once.`);
    else judgments.set(m[1], m[2]);
  }
  if (problems.length > 0) throw new RenderError(problems.join('\n'));

  /** @type {unknown} */
  let scan;
  try {
    scan = JSON.parse(fs.readFileSync(v.scan, 'utf8'));
  } catch (e) {
    throw new RenderError(`Cannot read the scan ${v.scan}: ${/** @type {Error} */ (e).message}`);
  }
  if (typeof scan !== 'object' || scan === null) throw new RenderError(`The scan ${v.scan} is not a JSON object.`);
  return `${renderReport(/** @type {keyof typeof REVIEWERS} */ (key), /** @type {import('./lib/report.mjs').Scan} */ (scan), judgments)}\n`;
}

if (process.argv[1] !== undefined && fs.realpathSync(import.meta.filename) === fs.realpathSync(process.argv[1])) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof RenderError) {
      process.stderr.write(`render-report: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      const err = /** @type {Error} */ (e);
      process.stderr.write(`${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    }
  }
}
