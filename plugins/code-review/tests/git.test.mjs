// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { filesAtCommit, grepFiles } from '../scripts/lib/git.mjs';
import { makeRepo } from './helpers.mjs';

test('grepFiles passes any number of needles on stdin and finds every match', (t) => {
  const dir = makeRepo(t, { head: { 'src/a.ts': "export const A = 'needle-04999';\n", 'src/b.ts': "export const B = 'needle-00000';\n" } });
  // ~100 KB of needles: far beyond any command-line limit, fine on stdin.
  const needles = Array.from({ length: 5000 }, (_, i) => `'needle-${String(i).padStart(5, '0')}'`.padEnd(20, ' '));
  needles[0] = "'needle-00000'";
  needles[4999] = "'needle-04999'";
  assert.deepEqual(grepFiles(dir, needles, ['*.ts']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(grepFiles(dir, ["'no-such-value'"], ['*.ts']), []);
  assert.deepEqual(grepFiles(dir, [], ['*.ts']), []);
});

test('grepFiles fails loudly when git grep itself fails', (t) => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-norepo-'));
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  assert.throws(() => grepFiles(notRepo, ["'x'"], ['*.ts']), (/** @type {any} */ e) => {
    assert.equal(e.code, 'GIT_GREP_FAILED');
    // git's own reason, not node's "Command failed: …" header.
    assert.match(e.message, /not a git repository/i);
    return true;
  });
});

test('filesAtCommit reads many files in one call and lists the ones it cannot read', (t) => {
  const dir = makeRepo(t, { base: { 'src/a.ts': 'export const a = 1;\n', 'src/ü b.ts': 'export const é = "ñ";\n' }, head: { 'src/c.ts': '\n' } });
  const { texts, unreadable } = filesAtCommit(dir, 'main', ['src/a.ts', 'src/missing.ts', 'src/ü b.ts']);
  assert.deepEqual([...texts.entries()], [
    ['src/a.ts', 'export const a = 1;\n'],
    ['src/ü b.ts', 'export const é = "ñ";\n'],
  ]);
  assert.deepEqual(unreadable, ['src/missing.ts']);
  assert.equal(filesAtCommit(dir, 'main', []).texts.size, 0);
});

test('filesAtCommit lists a directory (or submodule) at the commit as unreadable, not as text', (t) => {
  const dir = makeRepo(t, { base: { 'src/d/a.ts': 'export const a = 1;\n' }, head: { 'src/c.ts': '\n' } });
  const { texts, unreadable } = filesAtCommit(dir, 'main', ['src/d']);
  assert.equal(texts.size, 0);
  assert.deepEqual(unreadable, ['src/d']);
});

test('grepFiles skips a needle with a NUL byte instead of failing the whole search', (t) => {
  const dir = makeRepo(t, { head: { 'src/a.ts': "export const A = 'found-value';\n" } });
  assert.deepEqual(grepFiles(dir, ["'a\0b'", "'found-value'"], ['*.ts']), ['src/a.ts']);
});
