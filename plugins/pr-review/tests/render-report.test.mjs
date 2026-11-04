// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RenderError, cut, inlineCode, oneLine, renderReport } from '../scripts/lib/report.mjs';
import { PLUGIN_DIR, TS_DIR, makeRepo } from './helpers.mjs';

const RENDER = path.join(PLUGIN_DIR, 'scripts', 'render-report.mjs');

/**
 * A scan with the given candidates and overrides.
 * @param {string} tool
 * @param {any[]} candidates
 * @param {Record<string, unknown>} [over]
 * @returns {any}
 */
function scan(tool, candidates, over = {}) {
  return {
    tool,
    version: '0.2.0',
    base: { ref: 'origin/main', mergeBase: '1a2b3c4d5e6f' },
    head: { ref: 'feat/orders', sha: 'x', dirty: false },
    typescript: { version: '6.0.3', typeInfo: 'full' },
    config: { path: null, warnings: [] },
    files: { scanned: 3, skipped: 1, skippedByReason: {}, otherFiles: 0 },
    summary: { excluded: {} },
    candidates,
    ...over,
  };
}

/**
 * @param {string} id
 * @param {string} rule
 * @param {Record<string, unknown>} [over]
 */
const ms = (id, rule, over = {}) => ({
  id,
  file: 'src/a.ts',
  line: 3,
  preclass: rule === 'REVIEW' ? 'REVIEW' : 'VIOLATION',
  rule,
  value: 'v',
  detail: '',
  occurrencesInPr: 1,
  existingDefinitions: [],
  ...over,
});

/**
 * @param {string} id
 * @param {string} rule
 * @param {'blocking' | 'advisory'} severity
 * @param {Record<string, unknown>} [over]
 */
const tc = (id, rule, severity, over = {}) => ({
  id,
  file: 'src/a.ts',
  line: 3,
  preclass: rule.startsWith('REVIEW') ? 'REVIEW' : 'VIOLATION',
  rule,
  severity,
  subject: 's',
  detail: '',
  suggestion: null,
  ...over,
});

/** @param {Record<string, string>} o */
const judge = (o) => new Map(Object.entries(o));

/**
 * The orchestrator's consistency check (skills/review/SKILL.md, step 3a): the items under
 * `### Blocking` / `### Advisory` carry the result line's ids, and the heading gives their count.
 * @param {string} report
 */
function assertConsistent(report) {
  const result = /<!-- pr-review:[a-z-]+ (\{.*\}) -->$/.exec(report);
  assert.ok(result, 'ends with a result line');
  const json = JSON.parse(/** @type {string} */ (result[1]));
  /** @type {Record<string, string[]>} */
  const under = { blocking: [], advisory: [] };
  /** @type {string | null} */
  let section = null;
  for (const line of report.split('\n')) {
    if (line.startsWith('### ')) section = line === '### Blocking' ? 'blocking' : line === '### Advisory' ? 'advisory' : null;
    const id = /^- \*\*([A-Z]+-\d+)\*\*/.exec(line);
    if (id && section !== null) under[section]?.push(/** @type {string} */ (id[1]));
  }
  assert.deepEqual(under.blocking, json.blocking ?? []);
  assert.deepEqual(under.advisory, json.advisory ?? []);
  const heading = /^## .+ — (.+)$/m.exec(report)?.[1];
  const nb = under.blocking.length;
  const na = under.advisory.length;
  assert.equal(heading, nb > 0 ? `FAIL (${nb} blocking)` : na > 0 ? `PASS (${na} advisory)` : 'PASS');
  assert.equal(json.verdict, nb > 0 ? 'FAIL' : 'PASS');
}

test('oneLine, cut and inlineCode keep a value on one line and valid as inline code', () => {
  assert.equal(oneLine('a\nb\r\nc\rd\te f'), 'a\\nb\\r\\nc\\rd\\te\\u2028f');
  assert.equal(cut('x'.repeat(40), 40), 'x'.repeat(40));
  assert.equal(cut(`${'x'.repeat(40)}y`, 40), `${'x'.repeat(40)}…`);
  assert.equal(cut('😀'.repeat(41), 40), `${'😀'.repeat(40)}…`, 'cuts code points, not UTF-16 units');
  assert.equal(inlineCode('plain'), '`plain`');
  assert.equal(inlineCode('a`b'), '`` a`b ``');
  assert.equal(inlineCode('a``b'), '``` a``b ```');
});

test('magic-strings: every VIOLATION text, REVIEW rows, sections and the result line', () => {
  const report = renderReport(
    'magic-strings',
    scan(
      'find-magic-strings',
      [
        ms('MS-001', 'V-URL-OR-PATH', { value: '/api/orders', detail: 'fetch() arg 1' }),
        ms('MS-002', 'V-SECRET', { value: '[REDACTED: 40 chars]' }),
        ms('MS-003', 'V-FE002-INLINE-QUERY-KEY', { existingDefinitions: [{ name: 'orderKeys', file: 'src/keys.ts', line: 4 }] }),
        ms('MS-004', 'V-FE002-INLINE-QUERY-KEY'),
        ms('MS-005', 'V-EXISTING-CONSTANT', { existingDefinitions: [{ name: 'PAID', file: 'src/s.ts', line: 2 }] }),
        ms('MS-006', 'V-DUPLICATED', { occurrencesInPr: 3 }),
        ms('MS-007', 'V-FE004-UI-TEXT'),
        ms('MS-008', 'REVIEW', { value: `Hello\n${'x'.repeat(50)}`, detail: 'msg' }),
        ms('MS-009', 'REVIEW', { value: 'X-Request-Id' }),
        ms('MS-010', 'REVIEW', { value: 'a`b' }),
      ],
      { summary: { excluded: { 'E-MODULE': 30, 'E-TYPED': 11 } } },
    ),
    judge({ 'MS-008': 'R1', 'MS-009': 'R3', 'MS-010': 'R4' }),
  );
  assertConsistent(report);
  assert.ok(report.startsWith('## Magic strings — FAIL (9 blocking)\n\n- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/orders` · 3 files scanned · 1 skipped · type info: full\n'));
  assert.match(report, /^- Excluded by the scanner: 41 literals \(E-MODULE: 30, E-TYPED: 11\)$/m);
  assert.match(report, /- \*\*MS-001\*\* `src\/a.ts:3` — magic-strings · V-URL-OR-PATH\n {2}- Value: `\/api\/orders` \(fetch\(\) arg 1\)\n {2}- Why: Inline URL or path\.\n/);
  assert.match(report, /Fix: Remove it from the code and rotate it/);
  assert.match(report, /Fix: Use `orderKeys` \(`src\/keys.ts:4`\)\./);
  assert.match(report, /Fix: Add the key to the central query-key dictionary and use it\./);
  assert.match(report, /Fix: Use `PAID` \(`src\/s.ts:2`\)\./);
  assert.match(report, /Why: Same value 3 times in this PR\./);
  assert.match(report, /magic-strings · R1\n {2}- Value: `Hello\\nx{33}…` \(msg\)\n {2}- Why: Literal text shown to the user/);
  assert.match(report, /magic-strings · R4\n {2}- Value: `` a`b ``\n/);
  assert.match(report, /### Reviewed, not flagged\n\n- \*\*MS-009\*\* `src\/a.ts:3` — magic-strings · R3\n {2}- Value: `X-Request-Id`\n {2}- Reason: Spelling imposed/);
  assert.ok(!report.includes('### Advisory'));
  assert.match(report, /\n\nTo accept a literal deliberately: .+\n\n<!-- pr-review:magic-strings \{"verdict":"FAIL","blocking":\["MS-001",.*"MS-010"\],"advisory":\[\],"notFlagged":\["MS-009"\]\} -->$/);
});

test('magic-strings: a clean scan passes with None., notes, and no accept line', () => {
  const report = renderReport(
    'magic-strings',
    scan('find-magic-strings', [ms('MS-001', 'REVIEW')], {
      head: { ref: 'feat/x', dirty: true },
      typescript: { version: '6.0.3', typeInfo: 'partial' },
      warnings: ['Existing-constant search skipped (GIT): boom\nsecond line'],
    }),
    judge({ 'MS-001': 'R2' }),
  );
  assertConsistent(report);
  assert.equal(
    report,
    [
      '## Magic strings — PASS',
      '',
      '- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/x` + uncommitted changes · 3 files scanned · 1 skipped · type info: partial',
      '- Note: Existing-constant search skipped (GIT): boom\\nsecond line',
      '- Note: some files had no tsconfig coverage, so typed literals in them could not be proven safe.',
      '- Excluded by the scanner: 0 literals',
      '',
      '### Blocking',
      '',
      'None.',
      '',
      '### Reviewed, not flagged',
      '',
      '- **MS-001** `src/a.ts:3` — magic-strings · R2',
      '  - Value: `v`',
      '  - Reason: Developer-only text.',
      '',
      '<!-- pr-review:magic-strings {"verdict":"PASS","blocking":[],"advisory":[],"notFlagged":["MS-001"]} -->',
    ].join('\n'),
  );
});

test('every reviewer: no scanned files gives the short PASS report', () => {
  const report = renderReport(
    'magic-strings',
    scan('find-magic-strings', [], { typescript: null, files: { scanned: 0, skipped: 2 }, warnings: ['w'] }),
    new Map(),
  );
  assert.equal(
    report,
    [
      '## Magic strings — PASS',
      '',
      '- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/orders` · 0 files scanned · 2 skipped',
      '- Note: w',
      '',
      'No TypeScript/JavaScript files changed.',
      '',
      '<!-- pr-review:magic-strings {"verdict":"PASS","blocking":[],"advisory":[],"notFlagged":[]} -->',
    ].join('\n'),
  );
  assert.match(renderReport('zod', scan('find-zod-issues', [], { typescript: null }), new Map()), /\n\nNo TypeScript files changed\.\n\n<!-- pr-review:zod /);
  assert.match(
    renderReport('ts-conventions', scan('find-ts-convention-issues', [], { typescript: null }), new Map()),
    /\n\nNo TypeScript files changed\.\n\n<!-- pr-review:ts-conventions /,
  );
});

test('ts-conventions: severities, fix variants, file-name location, disabled rules and the type note', () => {
  const report = renderReport(
    'ts-conventions',
    scan(
      'find-ts-convention-issues',
      [
        tc('TC-001', 'V-INLINE-TYPE-IMPORT', 'blocking', { subject: 'User', detail: 'all-type' }),
        tc('TC-002', 'V-INLINE-TYPE-IMPORT', 'blocking', { subject: 'User', detail: 'mixed' }),
        tc('TC-003', 'V-OPTIONAL-UNDEFINED', 'advisory', { subject: 'name', suggestion: 'name?: string' }),
        tc('TC-004', 'V-FILE-NAME', 'advisory', { file: 'src/My-File.ts', line: 0, subject: 'My-File.ts', suggestion: 'myFile.ts' }),
        tc('TC-005', 'REVIEW-DISCRIMINATED-UNION', 'advisory', { subject: 'State', detail: "status: 'a' | 'b'; optional: data, error" }),
        tc('TC-006', 'REVIEW-THROW', 'advisory', { subject: "new Error('x')", detail: 'queryFn' }),
      ],
      {
        typescript: { version: '6.0.3', typeInfo: 'disabled' },
        config: { path: null, warnings: [], disabledRules: ['V-ENUM', 'V-CLASS'] },
        summary: { excluded: { 'E-MOVED': 2 } },
      },
    ),
    judge({ 'TC-005': 'D1', 'TC-006': 'T1' }),
  );
  assertConsistent(report);
  assert.ok(report.startsWith('## TypeScript conventions — FAIL (2 blocking)\n'));
  assert.match(report, /^- Note: some files had no type information, so intersections over union types may be over-reported\.\n- Disabled by configuration: V-ENUM, V-CLASS\n- Excluded by the scanner: 2 items \(E-MOVED: 2\)$/m);
  assert.match(report, /Fix: Write `import type \{ User \} from …`\./);
  assert.match(report, /Fix: Move `User` to a separate `import type \{ … \}` declaration\./);
  assert.match(report, /Why: Required property typed `T \| undefined` instead of an optional one\.\n {2}- Fix: Write `name\?: string`\./);
  assert.match(report, /- \*\*TC-004\*\* `src\/My-File.ts` — ts-conventions · V-FILE-NAME\n/);
  assert.match(report, /ts-conventions · REVIEW-DISCRIMINATED-UNION D1\n.*\n {2}- Why: Bag of optionals.*\n {2}- Fix: Model it as a discriminated union on `status`:/);
  assert.match(report, /### Reviewed, not flagged\n\n- \*\*TC-006\*\* .* REVIEW-THROW T1\n {2}- Subject: `new Error\('x'\)` \(queryFn\)\n {2}- Reason: Handled by the framework/);
  assert.match(report, /"advisory":\["TC-003","TC-004","TC-005"\],"notFlagged":\["TC-006"\]/);
});

test('ts-conventions: advisory findings alone pass, and keep the accept line', () => {
  const report = renderReport(
    'ts-conventions',
    scan('find-ts-convention-issues', [tc('TC-001', 'V-RETURN-TYPE', 'advisory', { subject: 'load' })]),
    new Map(),
  );
  assertConsistent(report);
  assert.ok(report.startsWith('## TypeScript conventions — PASS (1 advisory)\n'));
  assert.match(report, /### Blocking\n\nNone\.\n\n### Advisory\n\n- \*\*TC-001\*\*/);
  assert.match(report, /\n\nTo accept a case deliberately: /);
  assert.ok(!report.includes('Disabled by configuration'));
});

test('zod: blocking calls, and a clean scan with the type note', () => {
  const failing = renderReport(
    'zod',
    scan('find-zod-issues', [tc('ZOD-001', 'V-ZOD-PARSE', 'blocking', { subject: 'orderSchema.parse(…)', suggestion: 'orderSchema.safeParse(…)' })]),
    new Map(),
  );
  assertConsistent(failing);
  assert.match(failing, /- \*\*ZOD-001\*\* `src\/a.ts:3` — zod · V-ZOD-PARSE\n {2}- Call: `orderSchema.parse\(…\)`\n {2}- Why: `parse`.*\n {2}- Fix: Use `orderSchema.safeParse\(…\)` and handle its `success: false` branch\./);
  assert.match(failing, /To accept a case deliberately: add `\/\/ zod-ok: <reason>`/);

  const clean = renderReport('zod', scan('find-zod-issues', [], { typescript: { version: '6.0.3', typeInfo: 'none' } }), new Map());
  assertConsistent(clean);
  assert.match(clean, /^- Note: some files had no type information, so Zod schemas were recognised/m);
  assert.match(clean, /### Blocking\n\nNone\.\n\n<!-- pr-review:zod \{"verdict":"PASS","blocking":\[\],"advisory":\[\],"notFlagged":\[\]\} -->$/);
  assert.ok(!clean.includes('To accept'));
});

test('a scanner error renders the NOT RUN report', () => {
  assert.equal(
    renderReport('zod', /** @type {any} */ ({ error: { code: 'INTERNAL', message: 'boom', hint: null } }), new Map()),
    '## Zod validation — NOT RUN\n\n- Error: `INTERNAL` boom\n- Fix: Run the review again.\n\n<!-- pr-review:zod {"verdict":"NOT_RUN"} -->',
  );
  assert.match(
    renderReport('magic-strings', /** @type {any} */ ({ error: { code: 'BASE_NOT_FOUND', message: 'm', hint: 'Fetch it.' } }), new Map()),
    /- Fix: Fetch it\.\n/,
  );
});

test('judgments must cover exactly the REVIEW candidates, with rows of their rule', () => {
  const s = scan('find-ts-convention-issues', [
    tc('TC-001', 'V-ANY', 'blocking'),
    tc('TC-002', 'REVIEW-THROW', 'advisory'),
    tc('TC-003', 'REVIEW-DISCRIMINATED-UNION', 'advisory'),
  ]);
  assert.throws(
    () => renderReport('ts-conventions', s, judge({ 'TC-001': 'T1', 'TC-002': 'D1', 'TC-009': 'T1' })),
    (e) =>
      e instanceof RenderError &&
      e.message ===
        [
          'TC-001 is a VIOLATION: it is reported as given and takes no judgment.',
          'TC-002 (REVIEW-THROW) has no row D1; use one of T1, T2, T3.',
          'TC-009 is not a candidate of this scan.',
          'TC-003 (REVIEW-DISCRIMINATED-UNION) is not judged; add --judge TC-003=<D1|D2>.',
        ].join('\n'),
  );
  assert.throws(() => renderReport('zod', s, new Map()), /This is a find-ts-convention-issues scan, not a find-zod-issues scan\./);
  assert.throws(
    () => renderReport('zod', /** @type {any} */ ({ error: { code: 'X', message: 'm', hint: null } }), judge({ 'ZOD-001': 'R1' })),
    /The scan failed/,
  );
});

test('CLI: a scanner with --save feeds render-report end to end', (t) => {
  const dir = makeRepo(t, {
    base: { 'src/a.ts': 'export const a = 1;\n' },
    head: { 'src/b.ts': "export function f(x: any): void {\n  if (x === 'pending') throw new Error('bad');\n}\n" },
  });
  const scanner = (/** @type {string} */ name) =>
    spawnSync(process.execPath, [path.join(PLUGIN_DIR, 'scripts', name), '--repo', dir, '--base', 'main', '--typescript', TS_DIR, '--save'], {
      encoding: 'utf8',
    });

  const ms = scanner('find-magic-strings.mjs');
  assert.equal(ms.status, 0, ms.stderr);
  const msOut = JSON.parse(ms.stdout);
  t.after(() => fs.rmSync(path.dirname(msOut.savedTo), { recursive: true, force: true }));
  assert.deepEqual(Object.keys(msOut), ['savedTo', 'review']);
  assert.deepEqual(
    msOut.review.map((/** @type {any} */ c) => `${c.id} ${c.value}`),
    ['MS-001 pending'],
  );
  assert.equal(JSON.parse(fs.readFileSync(msOut.savedTo, 'utf8')).tool, 'find-magic-strings');

  const ok = spawnSync(process.execPath, [RENDER, '--reviewer', 'magic-strings', '--scan', msOut.savedTo, '--judge', 'MS-001=R4'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^## Magic strings — FAIL \(1 blocking\)\n[\s\S]*magic-strings · R4\n[\s\S]*<!-- pr-review:magic-strings \{"verdict":"FAIL","blocking":\["MS-001"\],"advisory":\[\],"notFlagged":\[\]\} -->\n$/);

  const missing = spawnSync(process.execPath, [RENDER, '--reviewer', 'magic-strings', '--scan', msOut.savedTo], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'render-report: MS-001 (REVIEW) is not judged; add --judge MS-001=<R1|R2|R3|R4>.\n');

  const ts = scanner('find-ts-convention-issues.mjs');
  const tsOut = JSON.parse(ts.stdout);
  t.after(() => fs.rmSync(path.dirname(tsOut.savedTo), { recursive: true, force: true }));
  const tsReport = spawnSync(process.execPath, [RENDER, '--reviewer', 'ts-conventions', '--scan', tsOut.savedTo, '--judge', `${tsOut.review[0].id}=T2`], {
    encoding: 'utf8',
  });
  assert.equal(tsReport.status, 0, tsReport.stderr);
  assertConsistent(tsReport.stdout.trimEnd());
  assert.match(tsReport.stdout, /^## TypeScript conventions — FAIL \(1 blocking\)\n/);

  const bad = spawnSync(
    process.execPath,
    [path.join(PLUGIN_DIR, 'scripts', 'find-zod-issues.mjs'), '--repo', dir, '--base', 'does-not-exist', '--typescript', TS_DIR, '--save'],
    { encoding: 'utf8' },
  );
  const badOut = JSON.parse(bad.stdout);
  t.after(() => fs.rmSync(path.dirname(badOut.savedTo), { recursive: true, force: true }));
  assert.equal(badOut.error.code, 'BASE_NOT_FOUND');
  const notRun = spawnSync(process.execPath, [RENDER, '--reviewer', 'zod', '--scan', badOut.savedTo], { encoding: 'utf8' });
  assert.equal(notRun.status, 0, notRun.stderr);
  assert.match(notRun.stdout, /^## Zod validation — NOT RUN\n\n- Error: `BASE_NOT_FOUND` /);

  const usage = spawnSync(process.execPath, [RENDER, '--reviewer', 'nope', '--scan', msOut.savedTo], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--reviewer must be one of magic-strings, ts-conventions, zod\./);
});
