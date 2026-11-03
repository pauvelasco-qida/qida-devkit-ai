// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/find-magic-strings.mjs';
import { capText, maskOpaqueTokens, secretKind } from '../scripts/lib/classify.mjs';
import { PLUGIN_DIR, TS_DIR, makeRepo } from './helpers.mjs';

const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'find-magic-strings.mjs');

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
  const fakeKey = ['AKIA', 'IOSFODNN7', 'QWERTZU'].join('');
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

test('a secret written with escape sequences is redacted in the code snippet too', (t) => {
  const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7'].join('');
  const dir = makeRepo(t, {
    head: { 'src/k.ts': `export const KEY = "-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----";\n` },
  });
  const r = scan(dir);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].rule, 'V-SECRET');
  assert.equal(r.candidates[0].code, 'export const KEY = [REDACTED];');
  assert.ok(!JSON.stringify(r).includes(body));
});

test('the marker does not hide a known-format secret; an explicit allowValues entry does, still redacted', (t) => {
  const fakeKey = ['AKIA', 'ABCDEFGHIJ', 'KLMNOP'].join('');
  const otherKey = ['AKIA', 'QRSTUVWXYZ', 'ABCDEF'].join('');
  const dir = makeRepo(t, {
    head: {
      '.claude/pr-review.json': JSON.stringify({ magicStrings: { allowValues: [otherKey] } }),
      'src/s.ts': `export const A = '${fakeKey}'; // magic-string-ok\nexport const B = '${otherKey}';\n`,
    },
  });
  const r = scan(dir, '--verbose');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.line, c.rule]),
    [[1, 'V-SECRET']],
  );
  assert.equal(r.summary.excluded['E-ALLOWLISTED'], 1);
  const out = JSON.stringify(r);
  assert.ok(!out.includes(fakeKey) && !out.includes(otherKey));
});

test('literals moved out of a deleted file are not introduced', (t) => {
  // The target already exists and is much larger, so git sees a deletion, not a rename.
  const client = Array.from({ length: 40 }, (_, i) => `export const n${i} = ${i};`).join('\n');
  const moved = ['declare function fetchIt(k: string): void;', "export const a = () => fetchIt('legacy-key');", "fetchIt('/api/legacy');"];
  const dir = makeRepo(t, {
    base: { 'src/legacy/api.ts': `${moved.join('\n')}\n`, 'src/api/client.ts': `${client}\n` },
    head: { 'src/legacy/api.ts': null, 'src/api/client.ts': `${client}\n${moved.join('\n')}\n` },
  });
  const r = scan(dir);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.summary.excluded['E-MOVED'], 2);
});

test('the suppression marker covers the next line only from a comment-only line', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/c.ts': [
        'declare function fn(s: string): void;',
        "fn('first-value'); // magic-string-ok",
        "fn('second-value');",
        '// magic-string-ok: vendor token',
        "fn('third-value');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(Object.keys(byValue(r)), ['second-value']);
  assert.equal(r.summary.excluded['E-SUPPRESSED'], 2);
});

test('--max-probes is validated', () => {
  assert.throws(() => run(['--max-probes', '-1']), { code: 'USAGE' });
  assert.throws(() => run(['--max-probes', 'x']), { code: 'USAGE' });
});

test('every copy of a secret on its line is redacted, in code and comments', (t) => {
  const key = ['sk_live_', 'AbCdEfGhIjKlMnOpQrSt'].join('');
  const dir = makeRepo(t, { head: { 'src/k.ts': `export const K = ['${key}', '${key}']; // was: ${key}\n` } });
  const r = scan(dir);
  assert.ok(r.candidates.length > 0);
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.rule === 'V-SECRET'));
  assert.ok(!JSON.stringify(r).includes(key));
});

test('a JSX comment above UI text suppresses it', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/Brand.tsx': [
        'export const Brand = () => (',
        '  <div>',
        '    {/* magic-string-ok: brand name */}',
        '    <span title="Qida Care brand">x</span>',
        '  </div>',
        ');',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(r.candidates, []);
  assert.equal(r.summary.excluded['E-SUPPRESSED'], 1);
});

test('a secret is masked in the snippet of every other finding on its line', (t) => {
  const key = ['AKIA', 'ABCDEFGHIJ', 'KLMNOP'].join('');
  const dir = makeRepo(t, {
    head: { 'src/h.ts': `declare function setHeader(k: string, v: string): void;\nsetHeader('X-Custom-Api-Key-Header', '${key}');\n` },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.length >= 2);
  assert.ok(!JSON.stringify(r).includes(key));
});

test('an entropy-only secret can be accepted; a known credential format cannot', (t) => {
  const opaque = ['Zx9Qw2Er7Ty4Ui1Op6As3Df8Gh5Jk0Lz', 'Mx'].join('');
  const known = ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/ids.ts': `export const PUBLIC_ID = '${opaque}'; // magic-string-ok: public client id\nexport const TOKEN = '${known}'; // magic-string-ok\n`,
    },
  });
  const r = scan(dir, '--verbose');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.line, c.rule]),
    [[2, 'V-SECRET']],
  );
  assert.equal(r.summary.excluded['E-SUPPRESSED'], 1);
  const out = JSON.stringify(r);
  assert.ok(!out.includes(opaque) && !out.includes(known));
});

test('snippets follow TypeScript line numbering, even with U+2028 in a string', (t) => {
  const dir = makeRepo(t, {
    head: { 'src/u.ts': "declare function f(s: string): void;\nexport const sep = 'a b';\nf('after-separator');\n" },
  });
  const r = scan(dir, '--no-types');
  const c = r.candidates.find((/** @type {any} */ x) => x.value === 'after-separator');
  assert.ok(c !== undefined);
  assert.equal(c.code, "f('after-separator');");
});

test('obvious placeholders in a known credential format are not secrets', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/form.ts': [
        'declare function input(p: { placeholder: string }): void;',
        "input({ placeholder: 'sk-your-api-key-goes-here-xxxx' });",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.rule !== 'V-SECRET'));
});

test('every line of a multi-line secret is masked, however short', (t) => {
  const tail = 'Ab3x9Q==';
  const dir = makeRepo(t, {
    head: {
      'src/pem.ts': [
        'declare function use(k: string, label: string): void;',
        'export const PEM = `-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
        `${tail}\`; use(PEM, 'pem-label-value');`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.value === 'pem-label-value'));
  assert.ok(!JSON.stringify(r).includes(tail));
  assert.ok(!JSON.stringify(r).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj'));
});

test('added-line detection follows git numbering when a file has U+2028 above the change', (t) => {
  const before = "declare function f(s: string): void;\nexport const sep = 'a\u2028b';\nf('old-value');\n";
  const dir = makeRepo(t, { base: { 'src/u.ts': before }, head: { 'src/u.ts': `${before}f('new-value');\n` } });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.value),
    ['new-value'],
  );
});

test('placeholder words inside a random token body do not hide a real credential', (t) => {
  const token = ['ghp_', 'a1FakeB2c3YourD4e5Sample6F7g8H9i0J1k2'].join('');
  const dir = makeRepo(t, { head: { 'src/t.ts': `declare function auth(t: string): void;\nauth('${token}');\n` } });
  const r = scan(dir, '--no-types', '--verbose');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET'],
  );
  assert.ok(!JSON.stringify(r).includes(token));
});

test('a placeholder in a credential format is excluded and never printed', (t) => {
  const placeholder = 'sk-0000000000000000-your-key';
  const dir = makeRepo(t, { head: { 'src/p.ts': `declare function input(p: string): void;\ninput('${placeholder}');\n` } });
  const r = scan(dir, '--no-types', '--verbose');
  assert.deepEqual(r.candidates, []);
  assert.equal(r.summary.excluded['E-PLACEHOLDER'], 1);
  assert.ok(!JSON.stringify(r).includes(placeholder));
});

test('two secrets on one line, one ending a multi-line key, are both fully masked', (t) => {
  const tail = 'abc9Q==';
  const other = ['sk_live_', 'ZyXwVuTsRqPoNmLkJiHg'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/two.ts': [
        'declare function use(...a: string[]): void;',
        'use(`-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
        `${tail}\`, '${other}', 'label-on-shared-line');`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  const label = r.candidates.find((/** @type {any} */ c) => c.value === 'label-on-shared-line');
  assert.ok(label !== undefined);
  assert.equal(label.code, "[REDACTED], '[REDACTED]', 'label-on-shared-line');");
  const out = JSON.stringify(r);
  assert.ok(!out.includes(tail) && !out.includes(other));
});

test('placeholder words around a real token do not make it a placeholder', (t) => {
  const token = ['ghp_', 'R7k2Lm9Qx4Tz8Wv1Bn6Cd3Fg5Hj0Kp2Ys4Ua'].join('');
  const key = ['sk-', 'Q8w7E6r5T4y3U2i1O0pAsDfGhJkL'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/m.ts': `export const A = 'Your token is ${token}';\nexport const B = 'see https://example.com/docs ${key}';\n`,
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.line, c.rule]),
    [
      [1, 'V-SECRET'],
      [2, 'V-SECRET'],
    ],
  );
  const out = JSON.stringify(r);
  assert.ok(!out.includes(token) && !out.includes(key));
});

test('reported lines are git line numbers, as in the diff', (t) => {
  const before = "declare function f(s: string): void;\nexport const sep = 'a b';\n";
  const dir = makeRepo(t, { base: { 'src/l.ts': before }, head: { 'src/l.ts': `${before}f('line-three-in-git');\n` } });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.value, c.line, c.code]),
    [['line-three-in-git', 3, "f('line-three-in-git');"]],
  );
});

test('a code line starting with a block comment is not comment-only', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/b.ts': [
        'declare function setMode(s: string): void;',
        "/* eslint-disable-line */ setMode('mode-a'); // magic-string-ok",
        "setMode('/api/admin');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(Object.keys(byValue(r)), ['/api/admin']);
});

test('a secret that exists only in a comment, or as a re-indented copy, is masked in snippets', (t) => {
  const token = ['ghp_', 'M3n4B5v6C7x8Z9a0S1d2F3g4H5j6K7l8Q9w0'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/c.ts': `declare function foo(s: string): void;\nfoo('bar-value'); // old token ${token}\n`,
    },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.value === 'bar-value'));
  assert.ok(!JSON.stringify(r).includes(token));
});

test('a high-entropy token after a slash is masked in snippets', (t) => {
  const token = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
  const dir = makeRepo(t, {
    head: { 'src/s.ts': `declare function f(s: string): void;\nf('slash-value'); // old key: path/${token}\n` },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.value === 'slash-value'));
  assert.ok(!JSON.stringify(r).includes(token));
});

test('a code line starting with * is not comment-only', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/m.ts': [
        'declare function f(s: string): number;',
        "export const total = f('first-value')",
        "  * f('second-value'); // magic-string-ok",
        "f('third-value');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(Object.keys(byValue(r)), ['first-value', 'third-value']);
});

test('reported columns are git columns', (t) => {
  const dir = makeRepo(t, { head: { 'src/c.ts': "declare function f(...s: string[]): void;\nf('a ', 'col-value');\n" } });
  const r = scan(dir, '--no-types');
  const c = r.candidates.find((/** @type {any} */ x) => x.value === 'col-value');
  assert.ok(c !== undefined);
  assert.deepEqual([c.line, c.column], [2, 9]);
});

test('a real key with a placeholder-like suffix stays a secret', (t) => {
  const key = ['sk-proj-', 'Q8w7E6r5T4y3U2i1O0pAsDfGhJkLzXcV', '-example'].join('');
  const dir = makeRepo(t, { head: { 'src/k.ts': `export const K = '${key}';\n` } });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET'],
  );
  assert.ok(!JSON.stringify(r).includes(key));
});

test('visible JSX text that reads like a marker comment suppresses nothing', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/P.tsx': [
        'declare function t(k: string): string;',
        'export const P = () => (',
        '  <p>',
        '    // magic-string-ok',
        '    <span title="Hello visible world">{t("x")}</span>',
        '  </p>',
        ');',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.value === 'Hello visible world'));
});

test('a token inside a larger string is a secret, redacted in value and code', (t) => {
  const token = 'aZ3kQ9pL2xW7vB4nM8rT1yU6hJ5gF0dS';
  const dir = makeRepo(t, {
    head: { 'src/h.ts': `declare function send(h: Record<string, string>): void;\nsend({ Authorization: 'Bearer ${token}' });\n` },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET'],
  );
  assert.ok(!JSON.stringify(r).includes(token));
});

test('long identifiers are neither secrets nor masked', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/q.ts': [
        'declare function useGetUserProfileByIdQueryV2Options(k: string): unknown;',
        "export function q() { return useGetUserProfileByIdQueryV2Options('profile-key'); }",
        "export function n() { return useGetUserProfileByIdQueryV2Options('handleCustomerSubscriptionWebhookEventV3'); }",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  const c = r.candidates.find((/** @type {any} */ x) => x.value === 'profile-key');
  assert.ok(c !== undefined);
  assert.equal(c.code, "export function q() { return useGetUserProfileByIdQueryV2Options('profile-key'); }");
  assert.ok(r.candidates.every((/** @type {any} */ x) => x.rule !== 'V-SECRET'));
});

test('data URIs and SRI hashes are not secrets; a bare PEM header can be accepted; placeholders in any case are', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/d.ts': [
        'declare function use(...a: string[]): void;',
        'use(',
        "  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg',",
        "  'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K3uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',",
        "  '-----BEGIN PRIVATE KEY-----', // magic-string-ok: header constant of the key parser",
        "  'sk-YOUR-API-KEY-0000000000000000',",
        "  'https://hooks.slack" + ".com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',",
        ');',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.rule !== 'V-SECRET'));
  assert.equal(r.summary.excluded['E-PLACEHOLDER'], 2);
});

test('a placeholder credential next to a real opaque token is still a secret', (t) => {
  const real = 'Q7fK2mZp9LxR4vT8nB3cW6yH1jD5gS0aE';
  const dir = makeRepo(t, {
    head: { 'src/x.ts': `export const C = 'sk_test_xxxxxxxxxxxxxxxxxxxx; backup=${real}';\n` },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET'],
  );
  assert.ok(!JSON.stringify(r).includes(real));
});

test('kebab-case sk- names are not keys; encrypted and split PEM keys are; masking keeps the rest of the line', (t) => {
  const dek = ['MIIEowIBAAKCAQEA7', 'xQ2mZp9LxR4vT8nB3cW'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/k.ts': [
        'declare function use(...a: string[]): void;',
        "use('sk-spinner-double-bounce-container');",
        `use('-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,3F17F5316E2BAC89\\n\\n${dek}');`,
        "const h = '-----BEGIN PRIVATE KEY-----'; use(h, 'after-header');",
        "use('sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K3uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC', 'sri-label');",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  const rules = byValue(r);
  assert.equal(rules['sk-spinner-double-bounce-container']?.rule === 'V-SECRET', false);
  assert.equal(r.candidates.filter((/** @type {any} */ c) => c.rule === 'V-SECRET').length, 2);
  assert.ok(!JSON.stringify(r).includes(dek));
  const after = r.candidates.find((/** @type {any} */ c) => c.value === 'after-header');
  // The bare header is reported (a suppressible secret) but holds no secret text: it stays readable.
  assert.equal(after?.code, "const h = '-----BEGIN PRIVATE KEY-----'; use(h, 'after-header');");
  const sri = r.candidates.find((/** @type {any} */ c) => c.value === 'sri-label');
  assert.ok(sri?.code.includes('sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K3uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC'));
});

test('lowercase hex sk- keys, tokens inside URLs and JSON are secrets', (t) => {
  const hex = 'sk-0123456789abcdef0123456789abcdef';
  const tok = 'Ab3dEf9hIj2lMn0pQr7tUv5xYz1AbC3dE';
  const dir = makeRepo(t, {
    head: {
      'src/u.ts': [
        'declare function use(...a: string[]): void;',
        `use('${hex}');`,
        `use('https://api.x.com/v1?key=${tok}');`,
        `use('{"apiKey":"${tok}"}');`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET', 'V-SECRET', 'V-SECRET'],
  );
  const out = JSON.stringify(r);
  assert.ok(!out.includes(hex) && !out.includes(tok));
});

test('a secret whose source spelling differs from its value is masked in the snippet', (t) => {
  const value = 'Zk3pQ9rT7vX2mN8bL4wY6h/J1cF5gD0sAqWeRtYu8Km3Np';
  const raw = value.replace('/', '\\/');
  const dir = makeRepo(t, { head: { 'src/e.ts': `export const k = '${raw}';\n` } });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.rule, c.code]),
    [['V-SECRET', 'export const k = [REDACTED];']],
  );
  assert.ok(!JSON.stringify(r).includes(value.slice(0, 22)));
});

test('the private-key pattern never backtracks on a long line of word: pieces', () => {
  const started = process.hrtime.bigint();
  const kind = secretKind(`-----BEGIN PRIVATE KEY-----\n${'a: '.repeat(2000)}!`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(kind, 'heuristic'); // a bare header: suppressible
  assert.ok(ms < 200, `took ${ms} ms`);
});

test('an SRI hash after a key is content, not a secret', (t) => {
  const sri = 'integrity=sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC';
  const dir = makeRepo(t, { head: { 'src/s.ts': `declare function use(s: string): void;\nuse('${sri}');\n` } });
  const r = scan(dir, '--no-types');
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.rule !== 'V-SECRET'));
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.value === sri));
});

test('an allowValues entry in a credential format is warned about, by position only', (t) => {
  const key = ['sk_live_', 'Ab12Cd34Ef56Gh78Ij90'].join('');
  const dir = makeRepo(t, {
    head: {
      '.claude/pr-review.json': JSON.stringify({ magicStrings: { allowValues: ['ok-value', key] } }),
      'src/a.ts': `export const K = '${key}';\n`,
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.warnings, ['magicStrings.allowValues[1] is in a credential format: it accepts a hardcoded credential (ADR-IN-007).']);
  assert.ok(!JSON.stringify(r).includes(key));
});

test('a base64 text payload or an over-long sha- value is not exempt as structured data', (t) => {
  const tok = 'Q7fK2mZp9LxR4vT8nB3cW6yH1jD5gS0aEk';
  const dir = makeRepo(t, {
    head: { 'src/d.ts': `declare function use(s: string): void;\nuse('Authorization: sha256-${tok}${tok}');\n` },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.rule),
    ['V-SECRET'],
  );
});

test('the private-key pattern is linear on a long whitespace run after the header', () => {
  const started = process.hrtime.bigint();
  secretKind(`-----BEGIN PRIVATE KEY-----${' '.repeat(100_000)}!`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 200, `took ${ms} ms`);
});

test('the allowValues credential warning appears even when nothing is scanned', (t) => {
  const key = ['sk_live_', 'Ab12Cd34Ef56Gh78Ij90'].join('');
  const dir = makeRepo(t, {
    head: { '.claude/pr-review.json': JSON.stringify({ magicStrings: { allowValues: [key] } }), 'README.md': '# x\n' },
  });
  const r = scan(dir);
  assert.equal(r.files.scanned, 0);
  assert.deepEqual(r.warnings, ['magicStrings.allowValues[0] is in a credential format: it accepts a hardcoded credential (ADR-IN-007).']);
});

test('the all-X AWS key is a placeholder', (t) => {
  const dir = makeRepo(t, { head: { 'src/aws.ts': "declare function use(s: string): void;\nuse('AKIAXXXXXXXXXXXXXXXX');\n" } });
  const r = scan(dir, '--no-types');
  assert.deepEqual(r.candidates, []);
  assert.equal(r.summary.excluded['E-PLACEHOLDER'], 1);
});

test('plain lines of a multi-line secret are not masked elsewhere in the file', (t) => {
  const key = ['-----BEGIN PRIVATE KEY-----\\n', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/sa.ts': [
        'declare function use(...a: string[]): void;',
        'export const sa = `{',
        '  "type": "service_account",',
        `  "private_key": "${key}"`,
        '}`;',
        'use(\'"type": "service_account",\', \'sa-label-value\');',
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  const c = r.candidates.find((/** @type {any} */ x) => x.value === 'sa-label-value');
  assert.ok(c !== undefined);
  assert.equal(c.code, 'use(\'"type": "service_account",\', \'sa-label-value\');');
  assert.ok(!JSON.stringify(r).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj'));
});

test('kebab-case sk- names with a digit are not keys; a token in a URL keeps the URL around it', (t) => {
  const tok = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vWxYz12345';
  const dir = makeRepo(t, {
    head: {
      'src/c.ts': [
        'declare function use(...a: string[]): void;',
        "use('sk-carousel-item-responsivecontainer2', 'sk-grid-2-autoplaceholdercolumns');",
        `use('https://cdn.example.com/assets/${tok}/img.png');`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  const secrets = r.candidates.filter((/** @type {any} */ c) => c.rule === 'V-SECRET');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].code, "use('https://cdn.example.com/assets/[REDACTED]/img.png');");
});

test('every piece of a private key split across literals is a secret, never printed', (t) => {
  const line = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7Vq2Hm4ZxPq1R';
  const tail = 'kq8Fz3PZ1xYw0Ab9Qe==';
  const dir = makeRepo(t, {
    head: {
      'src/split.ts': [
        "export const pem = '-----BEGIN PRIVATE KEY-----\\n' +",
        `  '${line}\\n' +`,
        `  '${tail}\\n' +`,
        "  '-----END PRIVATE KEY-----';",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  const out = JSON.stringify(r);
  assert.ok(!out.includes(tail) && !out.includes(line));
  assert.ok(r.candidates.filter((/** @type {any} */ c) => c.rule === 'V-SECRET').length >= 2);
});

test('a base64 key with a slash is masked whole; a token inside a webhook URL takes the URL with it', (t) => {
  const key = 'q7Rk2XmP9vLsT4wYb8NcZ1aHdE5fGj3K/Ab9xQ2r';
  const hook = 'https://hooks.slack.com/services/T0/B0/xoxb-1234567890-abcdefghij';
  const dir = makeRepo(t, {
    head: { 'src/b.ts': `export const K = '${key}';\ndeclare function use(s: string): void;\nuse('${hook}');\n` },
  });
  const r = scan(dir, '--no-types');
  const out = JSON.stringify(r);
  assert.ok(!out.includes('Ab9xQ2r') && !out.includes('T0/B0'));
});

test('a secret quoted in a detail is masked before the detail is shortened', (t) => {
  const tok = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5';
  const dir = makeRepo(t, {
    head: {
      'src/d.ts': [
        'declare function getMode(s: string): string;',
        `export const f = () => getMode("padding-padding-padding-padding:${tok}") === 'other-mode-value';`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.ok(!JSON.stringify(r).includes(tok.slice(0, 10)));
});

test('a large string array scans in linear time', (t) => {
  const items = Array.from({ length: 8000 }, (_, i) => `'item-value-${i}'`).join(',\n  ');
  const dir = makeRepo(t, { head: { 'src/big.ts': `declare function use(a: string[]): void;\nuse([\n  ${items},\n]);\n` } });
  const started = Date.now();
  scan(dir, '--no-types');
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test('a legacy base62 sk- key with only two digits is still a credential format', () => {
  assert.equal(secretKind('sk-AbCdEfGhIjKlMnOpQrStUvWxYz1AbCdEfGhIjKlMnOpQr2Stu'), 'format');
  assert.equal(secretKind('sk-carousel-item-responsivecontainer2'), null);
});

test('a base64 key line with several slashes is masked whole; a URL keeps its path words', () => {
  assert.equal(maskOpaqueTokens('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VxKqab/Zk8QwErTyUiOpAsDfGh2/Lz'), '[REDACTED]');
  assert.equal(
    maskOpaqueTokens('https://cdn.example.com/assets/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vWxYz12345/img.png'),
    'https://cdn.example.com/assets/[REDACTED]/img.png',
  );
});

test('existing definitions are reported with git line numbers', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/c.ts': "export const sep = 'a b';\nexport const MODE = 'shared-mode-value';\n" },
    head: { 'src/u.ts': "declare function f(s: string): void;\nexport const g = () => f('shared-mode-value');\n" },
  });
  const r = scan(dir, '--no-types');
  const c = r.candidates.find((/** @type {any} */ x) => x.value === 'shared-mode-value');
  assert.deepEqual(c?.existingDefinitions, [{ name: 'MODE', file: 'src/c.ts', line: 2 }]);
});

test('a key split across array elements that are + chains is linked to its header', (t) => {
  const tail = 'Xy9Qz2=';
  const dir = makeRepo(t, {
    head: {
      'src/arr.ts': [
        "export const pem = ['-----BEGIN PRIVATE KEY-----\\n',",
        "  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj' + '\\n',",
        `  '${tail}' + '\\n'].join('');`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.ok(!JSON.stringify(r).includes(tail));
});

test('capping a stored text never leaves a partial token', () => {
  const long = 'Zx9Qw2Er7Ty4Ui1Op6As3Df8Gh5Jk0LzMx'.repeat(9);
  const token = ['ghp_', 'Ab3dEf6hIj9kLm1nOp4qRs7tUv0wXy2zAb5c'].join('');
  const text = `${long} & ${'x'.repeat(390 - long.length - 3)} ${token}`;
  const capped = capText(text, 400);
  assert.ok(!capped.includes('ghp_'));
  assert.ok(capped.length <= 400);
});

test('--max-probes rejects empty and non-decimal values', () => {
  for (const v of ['', '1e3', '0x10', '-1']) assert.throws(() => run([`--max-probes=${v}`]), { code: 'USAGE' });
});

test('key-wrapping code: only the bare header is reported, the footer is not a key piece', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/wrap.ts': [
        "export const wrap = (body: string): string => '-----BEGIN PRIVATE KEY-----\\n' + body + '\\n-----END PRIVATE KEY-----\\n';",
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir, '--no-types');
  assert.equal(r.candidates.filter((/** @type {any} */ c) => c.rule === 'V-SECRET').length, 1);
});

test('a mixed-case route is a path, not a secret', () => {
  assert.equal(secretKind('/api/v2/Users/AbcDef12/Orders/XyZ987/Items'), null);
  assert.equal(secretKind('api/v2/Users/AbcDef12/Orders/XyZ987/Items/More'), null);
});

test('capping a text without separators keeps context and never a partial secret token', () => {
  const chain = Array.from({ length: 80 }, (_, i) => `seg${i}`).join('.');
  const capped = capText(chain, 400);
  assert.ok(capped.length > 300 && capped.endsWith('…'));
  // No separator at all: tokens are masked before the hard cut, so none is left partial.
  const token = 'Zx9Qw2Er7Ty4Ui1Op6As3Df8Gh5Jk0LzMx';
  const solid = `${'a'.repeat(380)}!${token}`;
  assert.ok(!capText(solid, 400).includes(token.slice(0, 10)));
});

test('a config file with a byte-order mark is read', (t) => {
  const dir = makeRepo(t, {
    head: { '.claude/pr-review.json': `﻿${JSON.stringify({ magicStrings: { allowValues: ['bom-value'] } })}`, 'src/a.ts': "declare function f(s: string): void;\nf('bom-value');\n" },
  });
  const r = scan(dir, '--no-types');
  assert.equal(r.summary.excluded['E-ALLOWLISTED'], 1);
});

test('capping never cuts a private key down to an unrecognisable header plus a few body characters', () => {
  // A PEM quoted in a detail, its line breaks collapsed to spaces by short(): 64-char body lines.
  const body = 'MIIEowIBAAKCAQEA7xQ2mZp9LxR4vT8nB3cW6yH1jD5gS0aEkQ7fK2mZp9LxR4vT8';
  const text = `${'word '.repeat(66)}-----BEGIN RSA PRIVATE KEY----- ${body} ${body} -----END RSA PRIVATE KEY-----`;
  const capped = capText(text, 400);
  assert.ok(!capped.includes(body.slice(0, 16)));
});
