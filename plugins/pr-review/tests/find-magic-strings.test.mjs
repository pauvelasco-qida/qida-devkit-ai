// @ts-check
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/find-magic-strings.mjs';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'find-magic-strings.mjs');
const TS_DIR = path.join(PLUGIN_DIR, 'node_modules', 'typescript');

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
function write(dir, files) {
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
function makeRepo(t, { base = {}, head = {}, commitHead = true, rename }) {
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

/**
 * @param {string} dir
 * @param {...string} extra
 * @returns {any}
 */
function scan(dir, ...extra) {
  return run(['--repo', dir, '--base', 'main', '--typescript', TS_DIR, ...extra]);
}

/**
 * @param {any} report
 * @returns {Record<string, { preclass: string, rule: string }>}
 */
function byValue(report) {
  return Object.fromEntries(report.candidates.map((/** @type {any} */ c) => [c.value, { preclass: c.preclass, rule: c.rule }]));
}

test('untyped comparison needs review; comparison against a literal union is proven by the compiler', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/status.ts': "export type Status = 'active' | 'inactive';\n" },
    head: {
      'src/use.ts': [
        "import type { Status } from './status';",
        'export function isActive(s: Status, raw: string): boolean {',
        "  if (raw === 'pending') return false;",
        "  return s === 'active';",
        '}',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--verbose');
  assert.deepEqual(byValue(r), { pending: { preclass: 'REVIEW', rule: 'REVIEW' } });
  assert.equal(r.candidates[0].context, 'comparison');
  assert.equal(r.candidates[0].typed, false);
  assert.equal(r.summary.excluded['E-TYPED'], 1);
  assert.equal(r.summary.excluded['E-MODULE'], 1);
  assert.equal(r.typescript.typeInfo, 'full');
});

test('inline TanStack query keys violate ADR-FE-002; the key dictionary does not', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/queries.ts': [
        'declare function useQuery(o: { queryKey: readonly unknown[]; queryFn: () => unknown }): unknown;',
        'declare const queryClient: { invalidateQueries(o: { queryKey: readonly unknown[] }): void; setQueryData(k: readonly unknown[], v: unknown): void };',
        "export const userKeys = { all: ['users'] as const, detail: (id: string) => [...userKeys.all, 'detail', id] as const };",
        "export function useUsers() { return useQuery({ queryKey: ['users-list'], queryFn: () => 1 }); }",
        "export function refresh() { queryClient.invalidateQueries({ queryKey: ['orders'] }); queryClient.setQueryData(['cart'], null); }",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  assert.deepEqual(byValue(r), {
    'users-list': { preclass: 'VIOLATION', rule: 'V-FE002-INLINE-QUERY-KEY' },
    orders: { preclass: 'VIOLATION', rule: 'V-FE002-INLINE-QUERY-KEY' },
    cart: { preclass: 'VIOLATION', rule: 'V-FE002-INLINE-QUERY-KEY' },
  });
  assert.equal(r.summary.excluded['E-DEFINITION'], 2);
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.adr === 'ADR-FE-002'));
});

test('user-visible literals violate ADR-FE-004; styling, test ids and i18n keys are excluded', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/View.tsx': [
        'declare function toast(msg: string): void;',
        'declare function t(key: string): string;',
        'export function View() {',
        "  toast('Saved successfully');",
        '  return (',
        '    <div className="flex gap-2" data-testid="view">',
        '      <input placeholder="Search users" />',
        "      {'Hello there'}",
        "      <span title={t('common:title')} />",
        '    </div>',
        '  );',
        '}',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  assert.deepEqual(byValue(r), {
    'Saved successfully': { preclass: 'VIOLATION', rule: 'V-FE004-UI-TEXT' },
    'Search users': { preclass: 'VIOLATION', rule: 'V-FE004-UI-TEXT' },
    'Hello there': { preclass: 'VIOLATION', rule: 'V-FE004-UI-TEXT' },
  });
  assert.equal(r.summary.excluded['E-STYLING'], 1);
  assert.equal(r.summary.excluded['E-MARKUP-ATTRIBUTE'], 1);
  assert.equal(r.summary.excluded['E-I18N'], 1);
});

test('definitions, logs, errors, directives, types and standard values are never candidates', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/dep.ts': 'export const dep = 1;\n' },
    head: {
      'src/misc.ts': [
        "'use strict';",
        "import { dep } from './dep';",
        "export type Mode = 'alpha' | 'beta';",
        "console.log('debug message here', dep);",
        "export class AppError extends Error { constructor() { super('Something failed badly'); this.name = 'AppError'; } }",
        "export function f(x: unknown) { if (typeof x === 'string') throw new Error(`bad input ${'value'}`); }",
        "export enum Color { Red = 'red' }",
        "export const API = { users: '/api/users' };",
        "export function isErr(e: object) { return 'code' in e; }",
        "export const json = () => fetch('/x', { method: 'POST' });",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  const leftovers = r.candidates.map((/** @type {any} */ c) => c.value);
  assert.deepEqual(leftovers, ['/x']);
  assert.deepEqual(Object.keys(r.summary.excluded), [
    'E-DEFINITION',
    'E-DEV-MESSAGE',
    'E-DIRECTIVE',
    'E-LOG',
    'E-MODULE',
    'E-PROPERTY-NAME',
    'E-STANDARD-VALUE',
    'E-TYPE-POSITION',
  ]);
  assert.equal(r.summary.excluded['E-DEV-MESSAGE'], 4);
});

test('a literal that only moved between files is not introduced; untouched lines are ignored', (t) => {
  const dir = makeRepo(t, {
    base: {
      'src/a.ts': [
        'declare function fetchIt(k: string): void;',
        "export const a = () => fetchIt('legacy-key');",
        "export const keep = () => fetchIt('untouched-key');",
        '',
      ].join('\n'),
    },
    head: {
      'src/a.ts': ['declare function fetchIt(k: string): void;', "export const keep = () => fetchIt('untouched-key');", ''].join(
        '\n',
      ),
      'src/b.ts': ['declare function fetchIt(k: string): void;', "export const b = () => fetchIt('legacy-key');", ''].join('\n'),
    },
  });
  const r = scan(dir);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.summary.excluded['E-MOVED'], 1);
});

test('existing constant, duplicated value and URL/path are deterministic violations', (t) => {
  const dir = makeRepo(t, {
    base: {
      'src/constants.ts': "export const ROUTES = { settings: '/settings' } as const;\nexport const STORAGE_KEY = 'session-token';\n",
    },
    head: {
      'src/nav.ts': [
        'declare function go(p: string): void;',
        'declare const storage: { getItem(k: string): string | null };',
        "export function a() { go('/settings'); go('/profile'); return storage.getItem('session-token'); }",
        "export function b(x: string) { return x === 'archived' || x.startsWith('archived'); }",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  assert.deepEqual(byValue(r), {
    '/settings': { preclass: 'VIOLATION', rule: 'V-EXISTING-CONSTANT' },
    '/profile': { preclass: 'VIOLATION', rule: 'V-URL-OR-PATH' },
    'session-token': { preclass: 'VIOLATION', rule: 'V-EXISTING-CONSTANT' },
    archived: { preclass: 'VIOLATION', rule: 'V-DUPLICATED' },
  });
  const settings = r.candidates.find((/** @type {any} */ c) => c.value === '/settings');
  assert.deepEqual(settings.existingDefinitions, [{ name: 'ROUTES.settings', file: 'src/constants.ts', line: 1 }]);
  const token = r.candidates.find((/** @type {any} */ c) => c.value === 'session-token');
  assert.deepEqual(token.existingDefinitions, [{ name: 'STORAGE_KEY', file: 'src/constants.ts', line: 2 }]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.id),
    ['MS-001', 'MS-002', 'MS-003', 'MS-004', 'MS-005'],
  );
});

test('the same repository state always produces byte-identical output', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/x.ts': "declare function go(p: string): void;\nexport const f = (s: string) => { go('/a'); return s === 'zeta' ? 'one' : 'two'; };\n",
      'src/y.tsx': 'export const Y = () => <input placeholder="Type here" />;\n',
    },
  });
  const first = JSON.stringify(scan(dir));
  const second = JSON.stringify(scan(dir));
  assert.equal(first, second);
});

test('test files, configured ignores, allow-list and inline suppression', (t) => {
  const dir = makeRepo(t, {
    head: {
      '.claude/pr-review.json': JSON.stringify({ magicStrings: { ignorePaths: ['src/legacy/**'], allowValues: ['allowed-value'] } }),
      'src/a.test.ts': "export const x = 'whatever-value';\n",
      'src/legacy/old.ts': "export function o(f: (s: string) => void) { f('legacy-value'); }\n",
      'src/c.ts': [
        'declare function fn(s: string): void;',
        "fn('allowed-value');",
        "fn('other-value'); // magic-string-ok: protocol token defined by the vendor",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--verbose');
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.files.skippedPaths, [
    { path: 'src/a.test.ts', reason: 'test' },
    { path: 'src/legacy/old.ts', reason: 'ignored-by-config' },
  ]);
  assert.deepEqual(r.files.skippedByReason, { 'ignored-by-config': 1, test: 1 });
  assert.equal(r.files.skipped, 2);
  // Paths are listed only with --verbose, to keep the default output small for the agent.
  assert.equal(scan(dir).files.skippedPaths, undefined);
  assert.equal(r.summary.excluded['E-ALLOWLISTED'], 1);
  assert.equal(r.summary.excluded['E-SUPPRESSED'], 1);
  assert.equal(r.config.path, '.claude/pr-review.json');
});

test('secret-looking literals are reported with the value redacted everywhere', (t) => {
  const fakeKey = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  const dir = makeRepo(t, {
    head: { 'src/s.ts': `declare function send(k: string): void;\nexport const AWS_KEY = '${fakeKey}';\nsend(AWS_KEY);\n` },
  });
  const r = scan(dir);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].rule, 'V-SECRET');
  assert.equal(r.candidates[0].value, `[REDACTED: ${fakeKey.length} chars]`);
  assert.ok(!JSON.stringify(r).includes(fakeKey));
});

test('uncommitted and untracked changes are part of the review', (t) => {
  const dir = makeRepo(t, {
    commitHead: false,
    head: { 'src/new.ts': "declare function f(s: string): void;\nf('brand-new-value');\n" },
  });
  const r = scan(dir);
  assert.deepEqual(byValue(r), { 'brand-new-value': { preclass: 'REVIEW', rule: 'REVIEW' } });
  assert.equal(r.head.dirty, true);
});

test('renamed file: only added lines count', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/old.ts': "declare function call(s: string): void;\nexport const f = () => call('kept-value');\n" },
    rename: ['src/old.ts', 'src/renamed.ts'],
    head: {
      'src/renamed.ts': [
        'declare function call(s: string): void;',
        "export const f = () => call('kept-value');",
        "export const g = () => call('fresh-value');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  assert.deepEqual(byValue(r), { 'fresh-value': { preclass: 'REVIEW', rule: 'REVIEW' } });
});

test('typed JSX props are excluded by the probe; --no-types leaves them for review', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/Button.tsx': [
        "type Props = { variant: 'primary' | 'ghost'; tone: 'soft' | 'loud'; size: string; label: string };",
        'export function Button(_p: Props) { return null; }',
        'export const Use = () => <Button variant="primary" tone="soft" size="large" label="Click me" />;',
        '',
      ].join('\n'),
    },
  });
  const typed = scan(dir);
  // Both typed props sit on one element: the compiler reports only the first failing one per
  // check, so the second is only found by the next probe round.
  assert.deepEqual(byValue(typed), {
    large: { preclass: 'REVIEW', rule: 'REVIEW' },
    'Click me': { preclass: 'VIOLATION', rule: 'V-FE004-UI-TEXT' },
  });
  assert.equal(typed.summary.excluded['E-TYPED'], 2);
  const untyped = scan(dir, '--no-types');
  assert.equal(untyped.typescript.typeInfo, 'disabled');
  assert.deepEqual(byValue(untyped), {
    primary: { preclass: 'REVIEW', rule: 'REVIEW' },
    soft: { preclass: 'REVIEW', rule: 'REVIEW' },
    large: { preclass: 'REVIEW', rule: 'REVIEW' },
    'Click me': { preclass: 'VIOLATION', rule: 'V-FE004-UI-TEXT' },
  });
});

test('long URLs, file names and identifiers are not mistaken for secrets', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/assets.ts': [
        'declare function load(u: string): void;',
        "load('https://strapi-upload-files-production.s3.eu-central-1.amazonaws.com/large_photo_e4df8a5f27.webp');",
        "load('large_cuidadora_ancianos_turno_noche_cff68e042c.webp');",
        "load('a_very_long_snake_case_identifier_value_2024');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.rule !== 'V-SECRET'));
  assert.equal(r.candidates.length, 3);
});

test('a PR without TS/JS changes needs no TypeScript at all', (t) => {
  const dir = makeRepo(t, { head: { 'README.md': '# hello\n' } });
  const r = /** @type {any} */ (run(['--repo', dir, '--base', 'main', '--typescript', path.join(dir, 'missing')]));
  assert.deepEqual(r.candidates, []);
  assert.equal(r.files.otherFiles, 1);
  assert.equal(r.typescript, null);
});

test('CLI: environment and usage errors are JSON with stable codes and exit codes', (t) => {
  const dir = makeRepo(t, { head: { 'src/a.ts': "export const f = (g: (s: string) => void) => g('value-here');\n" } });
  const noTs = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'main', '--typescript', path.join(dir, 'missing')], {
    encoding: 'utf8',
  });
  assert.equal(noTs.status, 3);
  assert.equal(JSON.parse(noTs.stdout).error.code, 'TYPESCRIPT_NOT_FOUND');

  const badBase = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'does-not-exist'], { encoding: 'utf8' });
  assert.equal(badBase.status, 2);
  assert.equal(JSON.parse(badBase.stdout).error.code, 'BASE_NOT_FOUND');

  const ok = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'main', '--typescript', TS_DIR], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).candidates[0].value, 'value-here');
});
