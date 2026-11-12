// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worktreeTree } from '../scripts/lib/git.mjs';
import { declaredPackages, globToRegExp, workspaceMembers } from '../scripts/lib/packages.mjs';
import { makeRepo } from './helpers.mjs';

test('workspace globs: * within a segment, ** at any depth', () => {
  /** @param {string} p @param {string} d */
  const m = (p, d) => globToRegExp(p).test(d);
  assert.ok(m('apps/*-service', 'apps/a-service'));
  assert.ok(!m('apps/*-service', 'apps/web'));
  assert.ok(m('packages/**/*', 'packages/x'));
  assert.ok(m('packages/**/*', 'packages/a/b'));
  assert.ok(!m('packages/*', 'packages/a/b'));
});

test('workspace members apply negations and stop at package directories', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ workspaces: ['packages/*', '!packages/legacy-sdk', 'apps/*-service'] }),
      'packages/core/package.json': JSON.stringify({ name: '@qida/core' }),
      'packages/core/fixtures/package.json': JSON.stringify({ name: 'fixture-pkg' }),
      'packages/legacy-sdk/package.json': JSON.stringify({ name: 'legacy-sdk' }),
      'apps/billing-service/package.json': JSON.stringify({ name: 'billing' }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
    },
  });
  assert.deepEqual([...workspaceMembers(worktreeTree(dir))].sort(), ['@qida/core', 'billing']);
});

test('pnpm items at column 0 are read; a package folder named build is still a member', (t) => {
  const dir = makeRepo(t, {
    head: {
      'pnpm-workspace.yaml': 'packages:\n- "packages/*"\n- tools/*\n',
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'tools/build/package.json': JSON.stringify({ name: '@qida/build' }),
    },
  });
  assert.deepEqual([...workspaceMembers(worktreeTree(dir))].sort(), ['@qida/build', '@x/a']);
});

test('root, nested and brace workspace patterns', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['*', 'apps/*/packages/*', 'libs/{core,web}'] }),
      'a/package.json': JSON.stringify({ name: 'pkg-a' }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/packages/ui/package.json': JSON.stringify({ name: '@x/ui' }),
      'libs/core/package.json': JSON.stringify({ name: '@x/core' }),
      'libs/web/package.json': JSON.stringify({ name: '@x/web' }),
      'libs/other/package.json': JSON.stringify({ name: '@x/other' }),
    },
  });
  assert.deepEqual([...workspaceMembers(worktreeTree(dir))].sort(), ['@x/core', '@x/ui', '@x/web', 'pkg-a']);
});

test('? in a workspace glob matches one character', () => {
  assert.ok(globToRegExp('apps/app?').test('apps/app1'));
  assert.ok(!globToRegExp('apps/app?').test('apps/app12'));
});

test('a package.json with a BOM is read; an unparseable one makes the dependencies unknown', (t) => {
  const dir = makeRepo(t, {
    head: {
      'package.json': '﻿' + JSON.stringify({ dependencies: { superjson: '2.2.1' } }),
      'apps/bad/package.json': '{ "dependencies": { "x": "1" }, }',
    },
  });
  const lookup = declaredPackages(worktreeTree(dir));
  assert.equal(lookup('src/a.ts')('superjson'), '2.2.1');
  assert.equal(lookup('apps/bad/src/a.ts')('superjson'), null);
});
