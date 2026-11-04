// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScannerError } from './errors.mjs';

/** @typedef {typeof import('typescript')} TS */

/**
 * @param {string} rel
 * @param {TS} ts
 * @returns {import('typescript').ScriptKind}
 */
export function scriptKind(rel, ts) {
  if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (rel.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Stable sort by a string key (code-unit order, locale-independent).
 * @template T
 * @param {T[]} list
 * @param {(x: T) => string} key
 * @returns {T[]}
 */
export function sortBy(list, key) {
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * @param {string} p
 * @returns {string}
 */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Help text of the option `runIfMain` handles for every scanner. */
export const SAVE_HELP = `  --save              Save the full JSON to a new temporary file and print only its path
                      ("savedTo"), any "error" and the REVIEW candidates ("review"):
                      the input of render-report.mjs
`;

/**
 * Saves a scanner's full JSON to a new temporary file (for render-report.mjs) and returns what
 * the agent needs on stdout: the file, any error, and the REVIEW candidates it must judge.
 * @param {string} tool The scanner's file name without extension.
 * @param {Record<string, unknown>} out
 * @returns {object}
 */
function saved(tool, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
  const file = path.join(dir, `${tool}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const candidates = Array.isArray(out.candidates) ? out.candidates : [];
  return {
    savedTo: file,
    ...(out.error === undefined ? {} : { error: out.error }),
    review: candidates.filter((c) => c !== null && typeof c === 'object' && c.preclass === 'REVIEW'),
  };
}

/**
 * Runs a scanner's `run(argv)` as the process entry point when `moduleUrl` is the executed script:
 * prints the JSON report (or help) on stdout and maps errors to JSON plus a stable exit code.
 * With `--save`, the JSON goes to a temporary file instead and stdout carries its path (`saved`).
 * @param {string} moduleUrl `import.meta.url` of the scanner.
 * @param {(argv: string[]) => object} run
 */
export function runIfMain(moduleUrl, run) {
  if (process.argv[1] === undefined || real(process.argv[1]) !== real(fileURLToPath(moduleUrl))) return;
  const argv = process.argv.slice(2);
  const save = argv.includes('--save');
  const tool = path.basename(fileURLToPath(moduleUrl), '.mjs');
  /** @param {Record<string, unknown>} out */
  const print = (out) => process.stdout.write(`${JSON.stringify(save ? saved(tool, out) : out, null, 2)}\n`);
  try {
    const out = run(argv.filter((a) => a !== '--save'));
    if ('help' in out) {
      process.stdout.write(`${String(out.help)}${SAVE_HELP}`);
      return;
    }
    print(/** @type {Record<string, unknown>} */ (out));
  } catch (e) {
    if (e instanceof ScannerError) {
      print({ error: { code: e.code, message: e.message, hint: e.hint } });
      process.exitCode = e.exitCode;
      return;
    }
    const err = /** @type {Error} */ (e);
    print({ error: { code: 'INTERNAL', message: err.message, hint: null } });
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  }
}
