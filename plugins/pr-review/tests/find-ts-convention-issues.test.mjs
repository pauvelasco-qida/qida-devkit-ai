// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/find-ts-convention-issues.mjs';
import { PLUGIN_DIR, TS_DIR, makeRepo } from './helpers.mjs';

const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'find-ts-convention-issues.mjs');

/**
 * @param {string} dir
 * @param {...string} extra
 * @returns {any}
 */
function scan(dir, ...extra) {
  return run(['--repo', dir, '--base', 'main', '--typescript', TS_DIR, ...extra]);
}

/**
 * One line per candidate, in report order: `file:line rule subject`.
 * @param {any} report
 * @returns {string[]}
 */
function found(report) {
  return report.candidates.map((/** @type {any} */ c) => `${c.file}:${c.line} ${c.rule} ${c.subject}`);
}

/** @param {string[]} lines */
const src = (lines) => `${lines.join('\n')}\n`;

test('blocking rules: any, enum, class (ADR-FE-001), default export, inline type import', (t) => {
  const dir = makeRepo(t, {
    base: {
      'src/types.ts': src(['export interface User { id: string }', "export type Role = 'admin' | 'user';"]),
      'src/helpers.ts': src(['export function helper(): number { return 1; }', 'export type Helper = number;']),
    },
    head: {
      'src/blocking.ts': src([
        "import { type User, type Role } from './types';",
        "import { helper, type Helper } from './helpers';",
        "export enum Size { Sm = 'sm' }",
        'export class UserService {}',
        'export class NotFoundError extends Error {}',
        'declare class Legacy {}',
        'export const load = (raw: string): unknown => raw as any;',
        'export function keep(x: any): void { void x; } // ts-conventions-ok: untyped vendor callback',
        'export default load;',
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), [
    'src/blocking.ts:1 V-INLINE-TYPE-IMPORT User, Role',
    'src/blocking.ts:2 V-INLINE-TYPE-IMPORT Helper',
    'src/blocking.ts:3 V-ENUM Size',
    'src/blocking.ts:4 V-CLASS UserService',
    'src/blocking.ts:7 V-ANY raw as any',
    'src/blocking.ts:9 V-DEFAULT-EXPORT export default load;',
  ]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.detail),
    ['all-type', 'mixed', '', '', 'type assertion', 'export default'],
  );
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.severity === 'blocking' && c.preclass === 'VIOLATION'));
  assert.equal(r.candidates[3].adr, 'ADR-FE-001 §1');
  assert.equal(r.candidates[4].adr, 'ADR-FE-001 §2');
  assert.deepEqual(r.summary, {
    blocking: 6,
    advisory: 0,
    review: 0,
    excluded: { 'E-AMBIENT': 1, 'E-ERROR-CLASS': 1, 'E-SUPPRESSED': 1 },
  });
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.id),
    ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005', 'TC-006'],
  );
});

test('framework default exports are allowed only where configured', (t) => {
  const dir = makeRepo(t, {
    head: {
      '.claude/pr-review.json': JSON.stringify({ tsConventions: { defaultExportPaths: ['src/pages/**'] } }),
      'src/pages/home.tsx': src(['export default function Home() { return <div />; }']),
      'src/widgets/card.tsx': src(['export default function Card() { return <div />; }']),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), ['src/widgets/card.tsx:1 V-DEFAULT-EXPORT export default function Card']);
  assert.equal(r.summary.excluded['E-FRAMEWORK-DEFAULT-EXPORT'], 1);
  assert.equal(r.summary.excluded['E-COMPONENT'], 2);
});

test('advisory rules: intersections, return types, optional props, type parameters, naming', (t) => {
  const files = {
    base: { 'src/types.ts': src(['export interface User { id: string }', "export type Role = 'admin' | 'user';"]) },
    head: {
      'src/model.ts': src([
        "import type { Role, User } from './types';",
        'export type Admin = User & { role: Role };',
        'export type Tagged<TBase> = TBase & { tag: string };',
        'export type RoleWithMeta = Role & { meta: string };',
        'export interface Opts { userId: string | undefined; name?: string }',
        'export const first = <K>(arr: K[]): K | undefined => arr[0];',
        'export type Flags<TKey extends string> = { [K in TKey]: boolean };',
        'export const parseInput = (raw: string) => raw.trim();',
        'export function formatName(user_id: string): string { return user_id; }',
        'export const maxCount = 10;',
        'export const MAX_SIZE = 20;',
        "export const SIZES = ['s'] as const;",
        'export const sizeMap = { s: 1 } as const;',
        'export type user_record = { id: string };',
        'export const { a: snake_name } = { a: 1 };',
      ]),
    },
  };
  const r = scan(makeRepo(t, files));
  assert.deepEqual(found(r), [
    'src/model.ts:2 V-INTERSECTION Admin',
    'src/model.ts:5 V-OPTIONAL-UNDEFINED userId',
    'src/model.ts:6 V-TYPE-PARAM-PREFIX K',
    'src/model.ts:8 V-RETURN-TYPE parseInput',
    'src/model.ts:9 V-VALUE-NAMING user_id',
    'src/model.ts:10 V-CONST-NAMING maxCount',
    'src/model.ts:13 V-CONST-NAMING sizeMap',
    'src/model.ts:14 V-TYPE-NAMING user_record',
    'src/model.ts:15 V-VALUE-NAMING snake_name',
  ]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => c.suggestion),
    [null, 'userId?: string', null, null, 'userId', 'MAX_COUNT', 'SIZE_MAP', 'UserRecord', 'snakeName'],
  );
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.severity === 'advisory'));
  assert.equal(r.summary.blocking, 0);
  assert.equal(r.summary.excluded['E-NOT-EXTENDABLE'], 2);

  // Without the checker, a union alias cannot be told from an object type.
  const untyped = scan(makeRepo(t, files), '--no-types');
  assert.ok(found(untyped).includes('src/model.ts:4 V-INTERSECTION RoleWithMeta'));
  assert.equal(untyped.typescript.typeInfo, 'disabled');
});

test('components, hooks, factories and renamed bindings may be PascalCase or skip return types', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/UserCard.tsx': src([
        'declare function memo<TProps>(c: (p: TProps) => unknown): unknown;',
        'declare function createContext<TValue>(v: TValue): unknown;',
        'export function UserCard() { return <div />; }',
        'export const useUser = () => 1;',
        'export const ThemeContext = createContext(null);',
        'export const Memoized = memo(() => <span />);',
        'export const BadName = 3 + 1;',
        'export const Row = ({ icon: Icon }: { icon: () => unknown }): unknown => <Icon />;',
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), ['src/UserCard.tsx:7 V-VALUE-NAMING BadName']);
  assert.equal(r.candidates[0].suggestion, 'badName');
  assert.deepEqual(r.summary.excluded, { 'E-COMPONENT': 1, 'E-HOOK': 1 });
});

test('Zod schemas are PascalCase; parsed data and other values stay camelCase', (t) => {
  const dir = makeRepo(t, {
    head: {
      // `zod` is not installed here: the unresolved type falls back to syntax.
      'src/untyped.ts': src([
        "import { z } from 'zod';",
        'export const UserSchema = z.object({ id: z.string() });',
        'export const userSchema = z.object({ id: z.string() });',
        'export const ADMIN_SCHEMA = UserSchema.extend({ admin: z.boolean() });',
        'export const NameSchema = z.string().min(1);',
        'export const user = UserSchema.parse({});',
        'export const jsonSchema = z.toJSONSchema(UserSchema);',
        'export const BadValue = Math.max(1, 2);',
      ]),
      // A local stand-in for `zod`: the checker sees a type with `safeParse`.
      'src/typed.ts': src([
        'interface ZodLike { safeParse(x: unknown): unknown; extend(s: object): ZodLike }',
        'declare const z: { object(s: object): ZodLike };',
        'export const BaseSchema = z.object({});',
        'export const extendedSchema = BaseSchema.extend({});',
        'export const result = BaseSchema.safeParse({});',
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), [
    'src/typed.ts:4 V-VALUE-NAMING extendedSchema',
    'src/untyped.ts:3 V-VALUE-NAMING userSchema',
    'src/untyped.ts:4 V-VALUE-NAMING ADMIN_SCHEMA',
    'src/untyped.ts:8 V-VALUE-NAMING BadValue',
  ]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.detail, c.expected, c.suggestion]),
    [
      ['Zod schema', 'PascalCase', 'ExtendedSchema'],
      ['Zod schema', 'PascalCase', 'UserSchema'],
      ['Zod schema', 'PascalCase', 'AdminSchema'],
      ['variable', 'camelCase', 'badValue'],
    ],
  );
});

test('file and directory names: only names the PR introduces', (t) => {
  const fn = src(['export function helper(): number { return 1; }']);
  const dir = makeRepo(t, {
    base: { 'src/existing-dir/old.ts': fn },
    head: {
      'src/existing-dir/newFile.ts': fn,
      'src/user-profile/api.ts': fn,
      'src/Helpers.ts': fn,
      'src/UserCard.tsx': src(['export function UserCard() { return <div />; }']),
      'src/date-utils.ts': fn,
      'src/user.schema.ts': fn,
      'src/routes/$postId.tsx': fn,
      'src/routes/__root.tsx': fn,
      'src/routes/(auth)/login.tsx': fn,
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), [
    'src/Helpers.ts:0 V-FILE-NAME Helpers.ts',
    'src/date-utils.ts:0 V-FILE-NAME date-utils.ts',
    'src/user-profile/:0 V-FILE-NAME user-profile/',
  ]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.detail, c.suggestion]),
    [
      ['PascalCase but exports no `Helpers`', 'helpers.ts'],
      ['not camelCase', 'dateUtils.ts'],
      ['directory not camelCase', 'userProfile/'],
    ],
  );
});

test('review candidates: bag-of-optionals types and throws the framework does not handle', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/state.ts': src([
        'declare function useQuery(o: { queryFn: () => Promise<unknown> }): unknown;',
        'declare function redirect(o: { to: string }): Error;',
        "export interface FetchState { status: 'idle' | 'loading' | 'success'; data?: string; error?: Error }",
        "export interface Filters { sort: 'asc' | 'desc'; page?: number }",
        'export function parseAge(raw: string): number {',
        '  const n = Number(raw);',
        "  if (Number.isNaN(n)) throw new Error('not a number');",
        '  return n;',
        '}',
        'export function useAge(): unknown {',
        "  return useQuery({ queryFn: async () => { throw new Error('boom'); } });",
        '}',
        'export function guard(): void {',
        "  try { parseAge('x'); } catch (e) { throw e; }",
        '}',
        "export function go(): never { throw redirect({ to: '/' }); }",
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), [
    'src/state.ts:3 REVIEW-DISCRIMINATED-UNION FetchState',
    "src/state.ts:7 REVIEW-THROW new Error('not a number')",
  ]);
  assert.equal(r.candidates[0].detail, "status: 'idle' | 'loading' | 'success'; optional: data, error");
  assert.equal(r.candidates[1].detail, 'parseAge');
  assert.ok(r.candidates.every((/** @type {any} */ c) => c.preclass === 'REVIEW' && c.severity === 'advisory'));
  assert.deepEqual(r.summary.excluded, { 'E-FRAMEWORK-THROW': 2, 'E-RETHROW': 1 });
  assert.equal(r.summary.review, 2);
});

test('moved code is not introduced; untouched lines and renamed files count only their added lines', (t) => {
  const moved = ["export enum Size { Sm = 'sm' }", 'export const load = (x: any): unknown => x;'];
  const keep = 'export const legacyThing = (z: any): unknown => z;';
  const dir = makeRepo(t, {
    base: { 'src/old.ts': src(moved), 'src/keep.ts': src([keep]) },
    head: { 'src/old.ts': null, 'src/keep.ts': src([keep, ...moved, 'export const more = (y: any): unknown => y;']) },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), ['src/keep.ts:4 V-ANY y: any']);
  assert.deepEqual(r.summary.excluded, { 'E-MOVED': 2 });

  const body = ['export function a(): number { return 1; }', 'export function b(): number { return 2; }', keep];
  const renamed = makeRepo(t, {
    base: { 'src/before.ts': src(body) },
    rename: ['src/before.ts', 'src/after.ts'],
    head: { 'src/after.ts': src([...body, "export enum Added { A = 'a' }"]) },
  });
  assert.deepEqual(found(scan(renamed)), ['src/after.ts:4 V-ENUM Added']);
});

test('the suppression marker covers its own line, or the next one from a comment-only line', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/a.ts': src([
        'export const a = (x: any): unknown => x; // ts-conventions-ok: vendor callback',
        'export const b = (x: any): unknown => x;',
        '// ts-conventions-ok: vendor callback',
        'export const c = (x: any): unknown => x;',
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), ['src/a.ts:2 V-ANY x: any']);
  assert.deepEqual(r.summary.excluded, { 'E-SUPPRESSED': 2 });
});

test('configuration: disabled rules, ignored paths, test files; unknown rules are rejected', (t) => {
  const dir = makeRepo(t, {
    head: {
      '.claude/pr-review.json': JSON.stringify({
        magicStrings: { allowValues: ['x'] },
        tsConventions: { disabledRules: ['V-RETURN-TYPE'], ignorePaths: ['src/legacy/**'] },
      }),
      'src/a.ts': src(['export const f = (s: string) => s;']),
      'src/legacy/b.ts': src(["export enum E { A = 'a' }"]),
      'src/a.test.ts': src(["export enum T { A = 'a' }"]),
    },
  });
  const r = scan(dir, '--verbose');
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.summary.excluded, { 'E-DISABLED': 1 });
  assert.deepEqual(r.config.disabledRules, ['V-RETURN-TYPE']);
  assert.deepEqual(r.config.warnings, []);
  assert.deepEqual(r.files.skippedByReason, { 'ignored-by-config': 1, test: 1 });

  const bad = makeRepo(t, {
    head: { '.claude/pr-review.json': JSON.stringify({ tsConventions: { disabledRules: ['V-NOPE'], extra: 1 } }), 'src/a.ts': src(['']) },
  });
  assert.throws(() => scan(bad), (/** @type {any} */ e) => e.code === 'CONFIG_INVALID' && /V-NOPE/.test(e.message));
});

test('the same repository state always produces byte-identical output, uncommitted changes included', (t) => {
  const dir = makeRepo(t, {
    commitHead: false,
    head: {
      'src/x.ts': src(['export const f = (s: any) => s;', "export enum Mode { A = 'a' }"]),
      'src/Y.tsx': src(['export const Y = () => <i />;', 'export default Y;']),
    },
  });
  const first = JSON.stringify(scan(dir));
  assert.equal(JSON.stringify(scan(dir)), first);
  assert.equal(JSON.parse(first).candidates.length, 4);
  assert.equal(JSON.parse(first).head.dirty, true);
});

test('a PR without TypeScript changes needs no compiler; CLI errors are JSON with stable codes', (t) => {
  const noTs = makeRepo(t, { head: { 'README.md': '# hi\n', 'src/legacy.js': 'export default 1;\n' } });
  const r = /** @type {any} */ (run(['--repo', noTs, '--base', 'main', '--typescript', path.join(noTs, 'missing')]));
  assert.deepEqual(r.candidates, []);
  assert.equal(r.files.otherFiles, 2);
  assert.equal(r.typescript, null);

  const dir = makeRepo(t, { head: { 'src/a.ts': src(['export const f = (s: any): unknown => s;']) } });
  const missingTs = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'main', '--typescript', path.join(dir, 'missing')], {
    encoding: 'utf8',
  });
  assert.equal(missingTs.status, 3);
  assert.equal(JSON.parse(missingTs.stdout).error.code, 'TYPESCRIPT_NOT_FOUND');

  const badBase = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'does-not-exist'], { encoding: 'utf8' });
  assert.equal(badBase.status, 2);
  assert.equal(JSON.parse(badBase.stdout).error.code, 'BASE_NOT_FOUND');

  const ok = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', 'main', '--typescript', TS_DIR], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).candidates[0].rule, 'V-ANY');
});

test('code snippets never show a secret', (t) => {
  const token = ['ghp_', 'T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c2'].join('');
  const dir = makeRepo(t, {
    head: { 'src/api.ts': `declare const Api: new (k: string) => unknown;\nexport const client: any = new Api('${token}');\n` },
  });
  const r = scan(dir);
  assert.ok(r.candidates.some((/** @type {any} */ c) => c.rule === 'V-ANY'));
  assert.ok(!JSON.stringify(r).includes(token));
});

test('file-name items are not masked: the rename suggestion stays usable', (t) => {
  const name = 'Ab3dEf9hIj2lMn0pQr7tUv5xYz1AbC3dEk';
  const dir = makeRepo(t, { head: { [`src/${name}.ts`]: 'export const x = 1;\n' } });
  const r = scan(dir);
  const c = r.candidates.find((/** @type {any} */ x) => x.rule === 'V-FILE-NAME');
  assert.ok(c !== undefined);
  assert.equal(c.subject, `${name}.ts`);
  assert.ok(typeof c.suggestion === 'string' && !c.suggestion.includes('[REDACTED]'));
});

test('snippets mask only the secret literals on the printed line', (t) => {
  const token = ['ghp_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/m.ts': [
        "export const header = '-----BEGIN PRIVATE KEY-----';",
        `export const t: any = ['${token}', header];`,
        '',
      ].join('\n'),
    },
  });
  const r = scan(dir);
  const c = r.candidates.find((/** @type {any} */ x) => x.rule === 'V-ANY');
  assert.ok(c !== undefined);
  assert.equal(c.code, "export const t: any = ['[REDACTED]', header];");
});
