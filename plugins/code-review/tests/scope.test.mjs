// @ts-check
/** The scope options every scanner shares: --path, --staged and --head. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { test } from 'node:test';
import { run as runMagic } from '../scripts/find-magic-strings.mjs';
import { run as runZod } from '../scripts/find-zod-issues.mjs';
import { renderReport } from '../scripts/lib/report.mjs';
import { TS_DIR, makeRepo, write } from './helpers.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

/** @param {string} dir @param {...string} args */
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: GIT_ENV }).toString('utf8').trim();

/** @param {string[]} lines */
const src = (lines) => `${lines.join('\n')}\n`;

const SCHEMAS = src([
  'export interface Schema<TOut> { parse(x: unknown): TOut; safeParse(x: unknown): { success: boolean } }',
  'export declare const userSchema: Schema<{ id: string }>;',
]);

/** A file with one Zod `.parse` call, on line 2. @param {string} name */
const parser = (name) => src([`import { userSchema } from '${'../'.repeat(name.split('/').length - 2)}schemas';`, `export const ${name.replace(/\W/g, '_')} = (x: unknown): unknown => userSchema.parse(x);`]);

/** @param {string} dir @param {...string} extra @returns {any} */
const zod = (dir, ...extra) => runZod(['--repo', dir, '--base', 'main', '--typescript', TS_DIR, ...extra]);

/** @param {any} r @returns {string[]} */
const files = (r) => r.candidates.map((/** @type {any} */ c) => c.file);

test('--path limits the reviewed files to the pathspecs, includes and excludes', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/schemas.ts': SCHEMAS },
    head: { 'src/web/a.ts': parser('src/web/a.ts'), 'src/web/a.legacy.ts': parser('src/web/a.legacy.ts'), 'src/api/b.ts': parser('src/api/b.ts') },
  });
  assert.deepEqual(files(zod(dir)), ['src/api/b.ts', 'src/web/a.legacy.ts', 'src/web/a.ts']);
  const web = zod(dir, '--path', 'src/web');
  assert.deepEqual(files(web), ['src/web/a.legacy.ts', 'src/web/a.ts']);
  assert.deepEqual(web.scope, { changes: 'worktree', paths: ['src/web'] });
  assert.deepEqual(files(zod(dir, '--path', 'src/web', '--path', ':!*.legacy.ts')), ['src/web/a.ts']);
  assert.deepEqual(files(zod(dir, '--path', ':!src/web')), ['src/api/b.ts']);
  // Untracked files obey the pathspecs too.
  write(dir, { 'src/web/new.ts': parser('src/web/new.ts'), 'src/api/new.ts': parser('src/api/new.ts') });
  assert.deepEqual(files(zod(dir, '--path', 'src/api')), ['src/api/b.ts', 'src/api/new.ts']);
});

test('code moved in from a deleted file outside --path is still not new', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/schemas.ts': SCHEMAS, 'src/old/a.ts': parser('src/old/a.ts').replace('src_old_a_ts', 'moved') },
    head: { 'src/old/a.ts': null, 'src/web/a.ts': parser('src/web/a.ts').replace('src_web_a_ts', 'moved') },
  });
  const r = zod(dir, '--path', 'src/web');
  assert.deepEqual(files(r), []);
  assert.equal(r.summary.excluded['E-MOVED'], 1);
});

test('--staged reviews the index: unstaged edits and untracked files are left out', (t) => {
  const dir = makeRepo(t, { base: { 'src/schemas.ts': SCHEMAS }, head: { 'src/staged.ts': parser('src/staged.ts') }, commitHead: false });
  git(dir, 'add', 'src/staged.ts');
  // On disk the staged file gains a second call and a new file appears: neither is staged.
  write(dir, {
    'src/staged.ts': `${parser('src/staged.ts')}export const more = (x: unknown): unknown => userSchema.parse(x);\n`,
    'src/untracked.ts': parser('src/untracked.ts'),
  });
  const staged = zod(dir, '--staged');
  assert.deepEqual(staged.candidates.map((/** @type {any} */ c) => `${c.file}:${c.line}`), ['src/staged.ts:2']);
  assert.deepEqual(staged.scope, { changes: 'staged', paths: [] });
  // The default scope still sees everything.
  assert.deepEqual(files(zod(dir)), ['src/staged.ts', 'src/staged.ts', 'src/untracked.ts']);
  // --base HEAD --staged: only what is staged on top of the last commit.
  git(dir, 'commit', '-q', '-m', 'staged');
  assert.deepEqual(files(zod(dir, '--staged')), ['src/staged.ts']);
  assert.deepEqual(files(runZod(['--repo', dir, '--base', 'HEAD', '--staged', '--typescript', TS_DIR])), []);
});

test('--head reviews a commit: one commit, a range, never the working tree', (t) => {
  const dir = makeRepo(t, { base: { 'src/schemas.ts': SCHEMAS }, head: { 'src/one.ts': parser('src/one.ts') } });
  const first = git(dir, 'rev-parse', 'HEAD');
  write(dir, { 'src/two.ts': parser('src/two.ts') });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'two');
  // Uncommitted: a third call on disk, outside every commit.
  write(dir, { 'src/three.ts': parser('src/three.ts') });

  assert.deepEqual(files(zod(dir)), ['src/one.ts', 'src/three.ts', 'src/two.ts']);
  const range = zod(dir, '--head', 'HEAD');
  assert.deepEqual(files(range), ['src/one.ts', 'src/two.ts']);
  assert.equal(range.head.ref, 'HEAD');
  assert.equal(range.head.dirty, false);
  assert.deepEqual(range.scope, { changes: 'commit', paths: [] });
  // A single commit: base = its parent.
  assert.deepEqual(files(runZod(['--repo', dir, '--base', `${first}`, '--head', 'HEAD', '--typescript', TS_DIR])), ['src/two.ts']);
  assert.deepEqual(files(runZod(['--repo', dir, '--base', `${first}^`, '--head', first, '--typescript', TS_DIR])), ['src/one.ts']);
  // Combined with --path.
  assert.deepEqual(files(zod(dir, '--head', 'HEAD', '--path', 'src/two.ts')), ['src/two.ts']);
});

test('--head and --staged errors have stable codes', (t) => {
  const dir = makeRepo(t, { base: { 'src/schemas.ts': SCHEMAS }, head: { 'src/one.ts': parser('src/one.ts') } });
  /** @param {string} code */
  const fails = (code) => (/** @type {any} */ e) => e.code === code;
  assert.throws(() => zod(dir, '--head', 'no-such-ref'), fails('HEAD_NOT_FOUND'));
  assert.throws(() => zod(dir, '--head', 'HEAD', '--staged'), fails('USAGE'));
  assert.throws(() => zod(dir, '--path', ' '), fails('USAGE'));
});

test('magic strings on a commit read the commit, not the disk, including the existing-constant search', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/constants.ts': "export const STATUS_OPEN = 'status-open';\n" },
    head: { 'src/use.ts': "export const s = (): string => 'status-open';\n" },
  });
  // On disk the constant is gone and the use is rewritten; the commit still has both.
  write(dir, { 'src/constants.ts': 'export {};\n', 'src/use.ts': 'export const s = (): string => STATUS;\n' });
  const r = /** @type {any} */ (runMagic(['--repo', dir, '--base', 'main', '--head', 'HEAD', '--typescript', TS_DIR, '--no-types']));
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => `${c.file}:${c.line} ${c.value} ${c.rule} ${c.existingDefinitions.map((/** @type {any} */ d) => d.name).join(',')}`),
    ['src/use.ts:1 status-open V-EXISTING-CONSTANT STATUS_OPEN'],
  );
});

test('the report scope line names staged changes, a commit and the paths', () => {
  /** @param {object} over @returns {any} */
  const scan = (over) => ({
    tool: 'find-zod-issues',
    base: { ref: 'origin/main', mergeBase: '1a2b3c4d5e' },
    head: { ref: 'feat/x', dirty: true },
    typescript: { version: '6.0.3', typeInfo: 'full' },
    files: { scanned: 1, skipped: 0 },
    summary: { excluded: {} },
    candidates: [],
    ...over,
  });
  const scopeLine = (/** @type {object} */ over) => renderReport('zod', scan(over), new Map()).split('\n')[2];
  assert.equal(scopeLine({}), '- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/x` + uncommitted changes · 1 files scanned · 0 skipped · type info: full');
  assert.equal(
    scopeLine({ scope: { changes: 'staged', paths: ['apps/web', ':!*.test.ts'] } }),
    '- Scope: `origin/main` (merge-base `1a2b3c4`) → staged changes · paths `apps/web`, `:!*.test.ts` · 1 files scanned · 0 skipped · type info: full',
  );
  assert.equal(
    scopeLine({ head: { ref: 'abc1234', dirty: false }, scope: { changes: 'commit', paths: [] } }),
    '- Scope: `origin/main` (merge-base `1a2b3c4`) → `abc1234` · 1 files scanned · 0 skipped · type info: full',
  );
});
