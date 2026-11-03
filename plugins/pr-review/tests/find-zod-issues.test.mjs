// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/find-zod-issues.mjs';
import { PLUGIN_DIR, TS_DIR, makeRepo } from './helpers.mjs';

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
      '.claude/pr-review.json': JSON.stringify({ tsConventions: { disabledRules: ['V-ANY'] }, zod: { ignorePaths: ['src/legacy/**'], extra: 1 } }),
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
