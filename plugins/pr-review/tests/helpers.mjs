// @ts-check
/** Shared fixtures for the scanner tests: throwaway git repositories with a base and a feature branch. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
export const TS_DIR = path.join(PLUGIN_DIR, 'node_modules', 'typescript');

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'preserve',
    noEmit: true,
    skipLibCheck: true,
    lib: ['ES2022', 'DOM'],
  },
  include: ['src'],
});

const JSX_TYPES = `declare namespace JSX {
  interface Element {}
  interface IntrinsicElements { [name: string]: Record<string, unknown> }
}
`;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

/**
 * @typedef {Record<string, string | null>} Files  path → content (null deletes the file)
 */

/**
 * @param {string} dir
 * @param {Files} files
 */
export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * Creates a repo with `base` committed on main and `head` on a feature branch.
 * @param {import('node:test').TestContext} t
 * @param {{ base?: Files, head?: Files, commitHead?: boolean, rename?: [string, string] }} spec
 * @returns {string}
 */
export function makeRepo(t, { base = {}, head = {}, commitHead = true, rename }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @param {string[]} args */
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write(dir, { 'tsconfig.json': TSCONFIG, 'src/jsx.d.ts': JSX_TYPES, ...base });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  if (rename !== undefined) git('mv', rename[0], rename[1]);
  write(dir, head);
  if (commitHead) {
    git('add', '-A');
    git('commit', '-q', '-m', 'head');
  }
  return dir;
}
