// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/find-zod-issues.mjs';
import { PLUGIN_DIR, TS_DIR, makeRepo, write } from './helpers.mjs';

const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'find-zod-issues.mjs');

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

const SCHEMAS = src([
  'export interface Schema<TOut> { parse(x: unknown): TOut; safeParse(x: unknown): { success: boolean } }',
  'export declare const userSchema: Schema<{ id: string }>;',
  'export declare const orderSchema: Schema<{ total: number }>;',
]);

test('.parse / .parseAsync on a Zod schema are blocking; JSON.parse and other parse methods are not', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/schemas.ts': SCHEMAS },
    head: {
      'src/validate.ts': src([
        "import { userSchema } from './schemas';",
        'declare const url: { parse(x: string): string };',
        'export const a = (x: unknown): unknown => userSchema.parse(x);',
        'export const b = (x: string): unknown => JSON.parse(x);',
        'export const c = (x: string): string => url.parse(x);',
        'export const d = (x: unknown): boolean => userSchema.safeParse(x).success;',
      ]),
      // `zod` is not installed here: the unresolved type falls back to the import.
      'src/unresolved.ts': src([
        "import { z } from 'zod';",
        'const schema = z.object({});',
        'export const v = (x: unknown): unknown => schema.parseAsync(x);',
      ]),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), [
    'src/unresolved.ts:3 V-ZOD-PARSE schema.parseAsync(…)',
    'src/validate.ts:3 V-ZOD-PARSE userSchema.parse(…)',
  ]);
  assert.deepEqual(
    r.candidates.map((/** @type {any} */ c) => [c.id, c.detail, c.suggestion, c.severity, c.preclass]),
    [
      ['ZOD-001', 'parseAsync', 'schema.safeParseAsync(…)', 'blocking', 'VIOLATION'],
      ['ZOD-002', 'parse', 'userSchema.safeParse(…)', 'blocking', 'VIOLATION'],
    ],
  );
  // `url.parse` is excluded as not Zod; `JSON.parse` is not even an item.
  assert.deepEqual(r.summary, { blocking: 2, advisory: 0, review: 0, excluded: { 'E-NOT-ZOD': 1 } });
  assert.equal(r.typescript.typeInfo, 'full');
  assert.equal(r.config.disabledRules, undefined);
});

test('without types, a receiver is a schema when the file imports zod or it is named …Schema', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/a.ts': src([
        'declare const url: { parse(x: string): string };',
        'declare const formSchema: { parse(x: unknown): unknown };',
        'export const a = (x: string): string => url.parse(x);',
        'export const b = (x: unknown): unknown => formSchema.parse(x);',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/a.ts:4 V-ZOD-PARSE formSchema.parse(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 1 });
  assert.equal(r.typescript.typeInfo, 'disabled');
});

test('moved calls, the zod-ok marker and the zod config section', (t) => {
  // Moved code is recognised by count: `orderSchema.parse` appears as often after the PR as before.
  const moved = "import { orderSchema } from './schemas';\nexport const load = (x: unknown): unknown => orderSchema.parse(x);\n";
  const dir = makeRepo(t, {
    base: { 'src/schemas.ts': SCHEMAS, 'src/old.ts': moved },
    head: {
      '.claude/code-review.json': JSON.stringify({ tsConventions: { disabledRules: ['V-ANY'] }, zod: { ignorePaths: ['src/legacy/**'], extra: 1 } }),
      'src/old.ts': null,
      'src/new.ts': src([
        ...moved.trimEnd().split('\n'),
        "import { userSchema } from './schemas';",
        'export const a = (x: unknown): unknown => userSchema.parse(x); // zod-ok: generated client validates upstream',
        '// zod-ok: generated client validates upstream',
        'export const b = (x: unknown): unknown => userSchema.parse(x);',
        'export const c = (x: unknown): unknown => userSchema.parseAsync(x);',
      ]),
      'src/legacy/x.ts': src(["import { userSchema } from '../schemas';", 'export const l = (x: unknown): unknown => userSchema.parse(x);']),
      'src/x.test.ts': src(["import { userSchema } from './schemas';", 'export const t = (x: unknown): unknown => userSchema.parse(x);']),
    },
  });
  const r = scan(dir);
  assert.deepEqual(found(r), ['src/new.ts:7 V-ZOD-PARSE userSchema.parseAsync(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-MOVED': 1, 'E-SUPPRESSED': 2 });
  assert.deepEqual(r.files.skippedByReason, { 'ignored-by-config': 1, test: 1 });
  assert.deepEqual(r.config.warnings, ['Unknown key "zod.extra" ignored.']);
});

test('a PR without TypeScript changes needs no compiler; output is stable; CLI errors are JSON with stable codes', (t) => {
  const noTs = makeRepo(t, { head: { 'README.md': '# hi\n', 'src/legacy.js': 'schema.parse(x);\n' } });
  const r = /** @type {any} */ (run(['--repo', noTs, '--base', 'main', '--typescript', path.join(noTs, 'missing')]));
  assert.deepEqual(r.candidates, []);
  assert.equal(r.files.otherFiles, 2);
  assert.equal(r.typescript, null);

  const dir = makeRepo(t, {
    commitHead: false,
    head: { 'src/a.ts': src(["import { z } from 'zod';", 'export const f = (x: unknown): unknown => z.string().parse(x);']) },
  });
  const first = JSON.stringify(scan(dir));
  assert.equal(JSON.stringify(scan(dir)), first);
  assert.equal(JSON.parse(first).head.dirty, true);

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
  assert.equal(JSON.parse(ok.stdout).candidates[0].subject, 'z.string().parse(…)');
});

test('an optional schema is still a schema for the type checker', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/schemas.ts': SCHEMAS },
    head: {
      'src/opt.ts': src([
        "import type { Schema } from './schemas';",
        'export const check = (x: unknown, schema?: Schema<string>): unknown => schema?.parse(x);',
      ]),
    },
  });
  const r = scan(dir);
  assert.equal(r.typescript.typeInfo, 'full');
  assert.deepEqual(found(r), ['src/opt.ts:2 V-ZOD-PARSE schema.parse(…)']);
});

test('without types, other parse methods in a file that imports zod are not Zod calls', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/a.ts': src([
        "import { z } from 'zod';",
        "import qs from 'qs';",
        "import * as yaml from 'yaml';",
        "import { userSchema } from './schemas';",
        'const local = z.object({});',
        'export const a = (s: string): unknown => [Date.parse(s), URL.parse(s), globalThis.JSON.parse(s), qs.parse(s), yaml.parse(s)];',
        'export const b = (x: unknown): unknown => [z.string().parse(x), local.parse(x), userSchema.parse(x)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), [
    'src/a.ts:7 V-ZOD-PARSE z.string().parse(…)',
    'src/a.ts:7 V-ZOD-PARSE local.parse(…)',
    'src/a.ts:7 V-ZOD-PARSE userSchema.parse(…)',
  ]);
  // Known globals (`Date`, `URL`, `globalThis`) are not items; `qs` and `yaml` are excluded.
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 2 });
});

test('without types, schemas imported from workspace or alias packages still count when the file imports zod', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/a.ts': src([
        "import { z } from 'zod';",
        "import { UserDto } from '@qida/contracts';",
        "import { Order } from 'src/models';",
        "import { parseISO } from 'date-fns';",
        'export const a = (x: unknown): unknown => [UserDto.parse(x), Order.parse(x), z.number().parse(x)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), [
    'src/a.ts:5 V-ZOD-PARSE UserDto.parse(…)',
    'src/a.ts:5 V-ZOD-PARSE Order.parse(…)',
    'src/a.ts:5 V-ZOD-PARSE z.number().parse(…)',
  ]);
});

test('a local binding named like a global, or a chain through a global, still reaches Zod', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/g.ts': src([
        "import { z } from 'zod';",
        'declare const holder: { bodySchema: z.ZodString };',
        'const self = holder;',
        'declare const cfg: { schema: z.ZodString };',
        'export const a = (x: unknown): unknown => [self.bodySchema.parse(x), (globalThis as any).cfg.schema.parse(x)];',
        'export const b = (s: string): unknown => [globalThis.JSON.parse(s), window.Date.parse(s)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), [
    'src/g.ts:5 V-ZOD-PARSE self.bodySchema.parse(…)',
    'src/g.ts:5 V-ZOD-PARSE (globalThis as any).cfg.schema.parse(…)',
  ]);
  assert.deepEqual(r.summary.excluded, {});
});

test('a global shadowed in another scope stays a global here; require() bindings count as imports', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/s.ts': src([
        "import { z } from 'zod';",
        "import yamlEq = require('js-yaml');",
        "const yaml = require('yaml');",
        'export function f(URL: { parse(x: string): unknown }) { return URL.parse("x"); }',
        'export const g = (href: string): unknown => [URL.parse(href), yaml.parse(href), yamlEq.load(href)];',
        'export const h = (x: unknown): unknown => z.string().parse(x);',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  // Line 4: the `URL` parameter is a local binding, judged by syntax (file imports zod).
  assert.deepEqual(found(r), ['src/s.ts:4 V-ZOD-PARSE URL.parse(…)', 'src/s.ts:6 V-ZOD-PARSE z.string().parse(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 1 });
});

test('secrets in the receiver text are masked in subject and suggestion', (t) => {
  const token = ['ghp_', 'W1e2R3t4Y5u6I7o8P9a0S1d2F3g4H5j6K7l8'].join('');
  const dir = makeRepo(t, {
    head: { 'src/z.ts': src(["import { z } from 'zod';", `export const v = (x: unknown): unknown => z.object({ k: z.literal('${token}') }).parse(x);`]) },
  });
  const r = scan(dir, '--no-types');
  assert.equal(r.candidates.length, 1);
  assert.ok(!JSON.stringify(r).includes(token));
});

test('hoisted var shadows a global; subpath imports of non-Zod packages are not Zod', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/h.ts': src([
        "import { z } from 'zod';",
        "import * as fp from 'date-fns/fp';",
        'export function f(strict: boolean, input: string): unknown {',
        '  if (strict) { var URL = z.string().url(); }',
        '  return [URL.parse(input), fp.parse(input)];',
        '}',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/h.ts:5 V-ZOD-PARSE URL.parse(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 1 });
});

test('a secret cut by the subject length limit is still masked', (t) => {
  const token = ['ghp_', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('');
  const dir = makeRepo(t, {
    head: {
      'src/long.ts': src([
        "import { z } from 'zod';",
        'declare const someVeryLongFunctionNameForTheTest: { call(...a: unknown[]): z.ZodString };',
        `export const v = (x: unknown): unknown => someVeryLongFunctionNameForTheTest.call(null, 'pre', '${token}').parse(x);`,
      ]),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.equal(r.candidates.length, 1);
  const out = JSON.stringify(r);
  assert.ok(!out.includes(token.slice(0, 12)));
});

test('a PEM key body in the receiver text is masked, not only its header', (t) => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
  const dir = makeRepo(t, {
    head: {
      'src/pem.ts': src([
        "import { z } from 'zod';",
        'declare const keyed: (k: string) => z.ZodString;',
        `export const v = (x: unknown): unknown => keyed("-----BEGIN PRIVATE KEY-----${body}").parse(x);`,
      ]),
    },
  });
  const r = scan(dir, '--no-types', '--verbose');
  assert.equal(r.candidates.length, 1);
  assert.ok(!JSON.stringify(r).includes(body));
});

test('a long receiver is shortened in the subject, which keeps the method; the suggestion is whole', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/l.ts': src([
        "import { z } from 'zod';",
        'declare const thisIsAVeryLongReceiverNameForTheConfigurationValidator: z.ZodString;',
        'export const v = (): unknown => thisIsAVeryLongReceiverNameForTheConfigurationValidator.parseAsync({});',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.equal(r.candidates.length, 1);
  assert.match(r.candidates[0].subject, /…\.parseAsync\(…\)$/);
  // The suggestion is pasted as the fix: never shortened.
  assert.equal(r.candidates[0].suggestion, 'thisIsAVeryLongReceiverNameForTheConfigurationValidator.safeParseAsync(…)');
  assert.ok(r.candidates[0].subject.length <= 60);
});

test('without types, names from unrelated packages are not schemas; schema-like packages are', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/p.ts': src([
        "import { z } from 'zod';",
        "import superjson from 'superjson';",
        "import { CronExpressionParser } from 'cron-parser';",
        "import { UserDto } from '@qida/contracts';",
        'export const a = (s: string): unknown => [superjson.parse(s), CronExpressionParser.parse(s), UserDto.parse(s)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/p.ts:5 V-ZOD-PARSE UserDto.parse(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 2 });
});

test('without types, a bare specifier no package.json declares is an alias into the project', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8', superjson: '2.2.1' } }),
      'src/f.ts': src([
        "import { z } from 'zod';",
        "import superjson from 'superjson';",
        "import { UserForm } from 'features/user';",
        "import qs from 'querystring';",
        'export const a = (s: string): unknown => [UserForm.parse(s), superjson.parse(s), qs.parse(s), z.string().parse(s)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/f.ts:5 V-ZOD-PARSE UserForm.parse(…)', 'src/f.ts:5 V-ZOD-PARSE z.string().parse(…)']);
  assert.deepEqual(r.summary.excluded, { 'E-NOT-ZOD': 2 });
});

test('without types, a workspace package is project code: its exports may be schemas', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8', '@qida/shared': 'workspace:*' } }),
      'src/w.ts': src([
        "import { z } from 'zod';",
        "import { userShape } from '@qida/shared';",
        'export const a = (x: unknown): unknown => [userShape.parse(x), z.string().parse(x)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/w.ts:3 V-ZOD-PARSE userShape.parse(…)', 'src/w.ts:3 V-ZOD-PARSE z.string().parse(…)']);
});

test('an imported global is judged the same with and without types', (t) => {
  const dir = makeRepo(t, {
    head: {
      'src/i.ts': src([
        "import { URL } from 'node:url';",
        'export const a = (s: string): unknown => URL.parse(s);',
      ]),
    },
  });
  const typed = scan(dir);
  const untyped = scan(dir, '--no-types');
  assert.deepEqual(found(typed), []);
  // Typed and untyped runs judge the imported `URL` the same way.
  assert.deepEqual(typed.summary.excluded, untyped.summary.excluded);
});

test('without types, an npm/yarn workspace member is project code whatever its range', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ workspaces: ['packages/*'], dependencies: { zod: '3.23.8', '@qida/shared': '*' } }),
      'packages/shared/package.json': JSON.stringify({ name: '@qida/shared', version: '1.0.0' }),
      'src/n.ts': src([
        "import { z } from 'zod';",
        "import { User } from '@qida/shared';",
        'export const a = (x: unknown): unknown => [User.parse(x), z.string().parse(x)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/n.ts:3 V-ZOD-PARSE User.parse(…)', 'src/n.ts:3 V-ZOD-PARSE z.string().parse(…)']);
});

test('pnpm workspace members come only from packages:, and ** finds nested packages', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8', '@acme/user': '^1.0.0', esb: '^1.0.0' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/**'\nonlyBuiltDependencies:\n  - tools\n",
      'packages/domain/user/package.json': JSON.stringify({ name: '@acme/user' }),
      'tools/package.json': JSON.stringify({ name: 'esb' }),
      'src/p.ts': src([
        "import { z } from 'zod';",
        "import { User } from '@acme/user';",
        "import esb from 'esb';",
        'export const a = (x: unknown): unknown => [User.parse(x), esb.parse(x), z.string().parse(x)];',
      ]),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/p.ts:4 V-ZOD-PARSE User.parse(…)', 'src/p.ts:4 V-ZOD-PARSE z.string().parse(…)']);
});

test('without types, an undeclared package installed in node_modules (hoisted) is a package', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8' } }),
      'src/y.ts': src([
        "import { z } from 'zod';",
        "import YAML from 'yaml';",
        'export const a = (s: string): unknown => [YAML.parse(s), z.string().parse(s)];',
      ]),
    },
  });
  // Installed but not committed: node_modules is ignored like in a real checkout.
  write(dir, { '.gitignore': 'node_modules/\n', 'node_modules/yaml/package.json': JSON.stringify({ name: 'yaml' }) });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/y.ts:3 V-ZOD-PARSE z.string().parse(…)']);
});

test('a packages/**/* workspace glob finds nested members', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8', '@qida/domain': '^1.0.0' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/**/*'\n",
      'packages/core/domain/package.json': JSON.stringify({ name: '@qida/domain' }),
      'src/g.ts': src(["import { z } from 'zod';", "import { User } from '@qida/domain';", 'export const a = (x: unknown): unknown => [User.parse(x), z.string().parse(x)];']),
    },
  });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/g.ts:3 V-ZOD-PARSE User.parse(…)', 'src/g.ts:3 V-ZOD-PARSE z.string().parse(…)']);
});

test('an undeclared workspace member linked into node_modules is project code; pnpm yaml comments and flow form', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ dependencies: { zod: '3.23.8' } }),
      'pnpm-workspace.yaml': "packages:\n# apps\n  - 'apps/*'\n# libs\n  - 'libs/*'\n",
      'libs/shared/package.json': JSON.stringify({ name: '@qida/shared' }),
      'src/m.ts': src(["import { z } from 'zod';", "import { User } from '@qida/shared';", 'export const a = (x: unknown): unknown => [User.parse(x), z.string().parse(x)];']),
    },
  });
  write(dir, { '.gitignore': 'node_modules/\n', 'node_modules/@qida/shared/package.json': JSON.stringify({ name: '@qida/shared' }) });
  const r = scan(dir, '--no-types');
  assert.deepEqual(found(r), ['src/m.ts:3 V-ZOD-PARSE User.parse(…)', 'src/m.ts:3 V-ZOD-PARSE z.string().parse(…)']);

  write(dir, { 'pnpm-workspace.yaml': "packages: ['libs/*']\n" });
  assert.deepEqual(found(scan(dir, '--no-types')), ['src/m.ts:3 V-ZOD-PARSE User.parse(…)', 'src/m.ts:3 V-ZOD-PARSE z.string().parse(…)']);
});

test('a schema imported under a global name is still a schema with types', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/contracts.ts': 'export interface S { parse(x: unknown): string; safeParse(x: unknown): { success: boolean } }\nexport declare const URL: S;\n' },
    head: { 'src/u.ts': src(["import { URL } from './contracts';", 'export const a = (x: unknown): string => URL.parse(x);']) },
  });
  assert.deepEqual(found(scan(dir)), ['src/u.ts:2 V-ZOD-PARSE URL.parse(…)']);
});

test('without types, z from a zod wrapper package builds schemas', (t) => {
  const dir = makeRepo(t, {
    head: { 'src/h.ts': src(["import { z } from '@hono/zod-openapi';", 'export const a = (x: unknown): unknown => z.object({}).parse(x);']) },
  });
  assert.deepEqual(found(scan(dir, '--no-types')), ['src/h.ts:2 V-ZOD-PARSE z.object({}).parse(…)']);
});
