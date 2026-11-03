// @ts-check
import fs from 'node:fs';
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

/**
 * Runs a scanner's `run(argv)` as the process entry point when `moduleUrl` is the executed script:
 * prints the JSON report (or help) on stdout and maps errors to JSON plus a stable exit code.
 * @param {string} moduleUrl `import.meta.url` of the scanner.
 * @param {(argv: string[]) => object} run
 */
export function runIfMain(moduleUrl, run) {
  if (process.argv[1] === undefined || real(process.argv[1]) !== real(fileURLToPath(moduleUrl))) return;
  try {
    const out = run(process.argv.slice(2));
    if ('help' in out) {
      process.stdout.write(String(out.help));
      return;
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    if (e instanceof ScannerError) {
      process.stdout.write(`${JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint } }, null, 2)}\n`);
      process.exitCode = e.exitCode;
      return;
    }
    const err = /** @type {Error} */ (e);
    process.stdout.write(`${JSON.stringify({ error: { code: 'INTERNAL', message: err.message, hint: null } }, null, 2)}\n`);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  }
}
