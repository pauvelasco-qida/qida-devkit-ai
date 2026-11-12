// @ts-check
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScannerError } from './errors.mjs';

/** @typedef {typeof import('typescript')} TS */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

/**
 * @param {string} dir Directory of a `typescript` package.
 * @returns {TS | null} The module if it exposes the classic compiler API (TypeScript <= 6).
 */
function tryLoad(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return null;
  try {
    /** @type {TS} */
    const ts = require(dir);
    if (typeof ts.createSourceFile === 'function' && typeof ts.createProgram === 'function') return ts;
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} name e.g. "typescript@5.9.3" or "typescript@5.9.3_peer"
 * @returns {number[] | null}
 */
function pnpmTypescriptVersion(name) {
  const m = /^typescript@(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Candidate `typescript` package directories, in fixed priority order.
 * TypeScript 7 (native) has no classic JS API, so pnpm's virtual store is searched for the
 * highest 5.x/6.x copy that some tool in the repo already depends on.
 * @param {string} root Repository root.
 * @param {readonly string[]} extraDirs Directories (repo-relative) whose node_modules to try, e.g. workspace packages.
 * @returns {string[]}
 */
function candidateDirs(root, extraDirs) {
  /** @type {string[]} */
  const dirs = [path.join(root, 'node_modules', 'typescript')];
  for (const d of extraDirs) {
    let cur = path.resolve(root, d);
    while (cur.startsWith(root) && cur !== root) {
      dirs.push(path.join(cur, 'node_modules', 'typescript'));
      cur = path.dirname(cur);
    }
  }
  const pnpmStore = path.join(root, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmStore)) {
    const versions = fs
      .readdirSync(pnpmStore)
      .map((name) => ({ name, v: pnpmTypescriptVersion(name) }))
      .filter((e) => e.v !== null && e.v[0] < 7)
      .sort((a, b) => {
        const va = /** @type {number[]} */ (a.v);
        const vb = /** @type {number[]} */ (b.v);
        for (let i = 0; i < 3; i += 1) if (va[i] !== vb[i]) return vb[i] - va[i];
        return a.name < b.name ? -1 : 1;
      });
    for (const e of versions) dirs.push(path.join(pnpmStore, e.name, 'node_modules', 'typescript'));
  }
  dirs.push(path.join(PLUGIN_DIR, 'node_modules', 'typescript'));
  return [...new Set(dirs)];
}

/**
 * Loads a TypeScript compiler with the classic API.
 * @param {string} root Repository root.
 * @param {string | null} explicit Path given with --typescript (or CODE_REVIEW_TYPESCRIPT); when set, only it is tried.
 * @param {readonly string[]} extraDirs
 * @returns {{ ts: TS, dir: string }}
 */
export function loadTypeScript(root, explicit, extraDirs) {
  const dirs = explicit !== null ? [path.resolve(explicit)] : candidateDirs(root, extraDirs);
  for (const dir of dirs) {
    const ts = tryLoad(dir);
    if (ts !== null) return { ts, dir };
  }
  throw new ScannerError(
    'TYPESCRIPT_NOT_FOUND',
    explicit !== null
      ? `No TypeScript compiler with the classic API (<= 6.x) at ${explicit}.`
      : 'No TypeScript compiler with the classic API (<= 6.x) found in the repository.',
    3,
    'Install dependencies (`pnpm install`) or point --typescript / CODE_REVIEW_TYPESCRIPT at a typescript 5.x or 6.x package directory.',
  );
}
