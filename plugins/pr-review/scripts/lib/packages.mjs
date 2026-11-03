// @ts-check
/**
 * Package resolution for the untyped Zod fallback: which dependencies the package.json files above
 * a file declare, which packages are workspace members (project code), and which undeclared ones
 * are installed in node_modules. Everything is read lazily and cached.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp as configGlob, readJson } from './config.mjs';

/**
 * Parent of a repo-relative POSIX directory (or a file's directory), `''` for the root.
 * @param {string} p
 * @returns {string}
 */
export function parentDir(p) {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
}

/**
 * Dependencies declared by the package.json files from a file's directory up to the repository
 * root (dependencies, devDependencies, peerDependencies, optionalDependencies), cached per directory.
 * Everything is read lazily, the first time a receiver without type information needs it.
 * @param {string} root
 * @returns {(rel: string) => import('./zod-detect.mjs').PackageLookup}
 */
export function declaredPackages(root) {
  /**
   * Per directory: its own package.json entries and the nearest ancestor scope. Nothing is
   * copied: a lookup walks up the chain. null: no package.json on the path (unknown).
   * `unknown`: a package.json there or above cannot be parsed, so nothing is known below it
   * (inherited from the parent when the scope is built).
   * @typedef {{ own: Map<string, string>, parent: Scope | null, unknown: boolean }} Scope
   */
  /** @type {Map<string, Scope | null>} */
  const cache = new Map();
  /** @type {Set<string> | null} */
  let membersCache = null;
  const members = () => (membersCache ??= workspaceMembers(root));
  /** @param {string} dir Repo-relative directory ('' for the root). @returns {Scope | null} */
  const forDir = (dir) => {
    const hit = cache.get(dir);
    if (hit !== undefined) return hit;
    const parent = dir === '' ? null : forDir(parentDir(dir));
    /** @type {Scope | null} */
    let scope = parent;
    const file = path.join(root, dir, 'package.json');
    if (fs.existsSync(file)) try {
      const pkg = readJson(file);
      /** @type {Map<string, string>} */
      const own = new Map();
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (pkg !== null && typeof pkg[key] === 'object' && pkg[key] !== null) for (const [name, range] of Object.entries(pkg[key])) {
          // A workspace member is project code whatever its range (npm/yarn use `*` or `^1.0.0`).
          own.set(name, members().has(name) ? 'workspace:' : String(range));
        }
      }
      scope = { own, parent, unknown: parent?.unknown ?? false };
    } catch {
      // Present but unparseable (a trailing comma…): its dependencies are unknown, so are those of
      // every file below it; never mistaken for "declares nothing".
      scope = { own: new Map(), parent, unknown: true };
    }
    cache.set(dir, scope);
    return scope;
  };
  /** @param {Scope} scope @param {string} name @returns {string | undefined} */
  const lookup = (scope, name) => {
    for (let s = /** @type {Scope | null} */ (scope); s !== null; s = s.parent) {
      const range = s.own.get(name);
      if (range !== undefined) return range;
    }
    return undefined;
  };
  /** `installed` answers per directory and package, so each pair touches the disk once. */
  /** @type {Map<string, boolean>} */
  const installedCache = new Map();
  /** @param {string} dir @param {string} name @returns {boolean} */
  const installed = (dir, name) => {
    const key = `${dir}\0${name}`;
    const hit = installedCache.get(key);
    if (hit !== undefined) return hit;
    const here = fs.existsSync(path.join(root, dir, 'node_modules', name, 'package.json'));
    const result = here || (dir !== '' && installed(parentDir(dir), name));
    installedCache.set(key, result);
    return result;
  };
  return (rel) => {
    const dir = parentDir(rel.replace(/\\/g, '/'));
    return (name) => {
      const declared = forDir(dir);
      if (declared === null) return null;
      if (declared.unknown) return null; // inherited when each scope is built
      // An undeclared package installed in node_modules (hoisted through another dependency) is
      // a package, not project code.
      // A workspace member is linked into node_modules by npm/yarn: still project code.
      return lookup(declared, name) ?? (members().has(name) ? 'workspace:' : installed(dir, name) ? 'installed' : undefined);
    };
  };
}

/** Directory names never descended into when expanding workspace globs. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'lib-cov', 'tmp']);

/**
 * A workspace glob as a regular expression over repo-relative directories: the plugin's one glob
 * dialect (`config.globToRegExp`: `*` within a segment, `?` one character, `**` any depth), after
 * dropping a leading `./` and trailing `/`.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  return configGlob(pattern.replace(/^\.\//, '').replace(/\/+$/, ''));
}

/**
 * Names of the repository's workspace packages: the `workspaces` of the root package.json (npm,
 * yarn; an array or `{ packages }`) and the `packages` of pnpm-workspace.yaml (block or flow
 * list). Patterns are globs (`packages/*`, `apps/*-service`, `packages/**`); `!` patterns remove
 * matches; `{a,b}` braces expand. Candidate directories are those below each pattern's fixed prefix,
 * as deep as the pattern reaches (8 levels for `**`), skipping build output and dependencies.
 * @param {string} root
 * @returns {Set<string>}
 */
export function workspaceMembers(root) {
  /** @type {string[]} */
  const patterns = [];
  try {
    const pkg = readJson(path.join(root, 'package.json'));
    const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    if (Array.isArray(ws)) patterns.push(...ws.filter((w) => typeof w === 'string'));
  } catch {
    // No root package.json.
  }
  patterns.push(...pnpmPatterns(root));
  const expanded = patterns.flatMap(expandBraces);
  const include = expanded.filter((p) => !p.startsWith('!'));
  const exclude = expanded.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  /** @type {Map<string, string>} directory → package name */
  const found = new Map();
  for (const pattern of include) {
    const re = globToRegExp(pattern);
    const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
    const firstWild = segments.findIndex((s) => /[*?]/.test(s));
    const prefix = firstWild === -1 ? segments.join('/') : segments.slice(0, firstWild).join('/');
    const maxDepth = pattern.includes('**') ? 8 : segments.length - (firstWild === -1 ? segments.length : firstWild);
    /** @param {string} dir @param {number} depth */
    const visit = (dir, depth) => {
      // Every directory up to the pattern's depth is a candidate, packages included: members can
      // sit below another package (`apps/*/packages/*`), and the root can be the prefix (`*`).
      const name = packageName(root, dir);
      // The root package is the workspace itself, never one of its members.
      if (name !== null && dir !== '' && re.test(dir)) found.set(dir, name);
      if (depth >= maxDepth) return;
      /** @type {import('node:fs').Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const sub = dir === '' ? d.name : `${dir}/${d.name}`;
        // A build-output or dependency folder is not walked, but it can still be a package itself
        // (`tools/build` named `@qida/build`).
        if (SKIP_DIRS.has(d.name)) {
          const name = packageName(root, sub);
          if (name !== null && re.test(sub)) found.set(sub, name);
        } else visit(sub, depth + 1);
      }
    };
    if (firstWild === -1) {
      const name = packageName(root, prefix);
      if (name !== null) found.set(prefix, name);
    } else visit(prefix, 0);
  }
  /** @type {Set<string>} */
  const names = new Set();
  for (const [dir, name] of found) if (!exclude.some((re) => re.test(dir))) names.add(name);
  return names;
}

/**
 * Expands `{a,b}` brace groups of a glob into separate patterns (`packages/{core,web}`).
 * @param {string} pattern
 * @returns {string[]}
 */
function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (m === null) return [pattern];
  return m[1].split(',').flatMap((alt) => expandBraces(`${pattern.slice(0, m.index)}${alt}${pattern.slice(m.index + m[0].length)}`));
}

/**
 * The `packages` list of pnpm-workspace.yaml (block or flow form; comments and blank lines skipped).
 * @param {string} root
 * @returns {string[]}
 */
function pnpmPatterns(root) {
  /** @type {string[]} */
  const out = [];
  let yaml;
  try {
    yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return out;
  }
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    // A block item of the list, indented or at column 0 (`packages:` then `- 'packages/*'`).
    const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (item !== null && inPackages) {
      out.push(item[1]);
      continue;
    }
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line);
      const flow = /^packages\s*:\s*\[(.*)\]/.exec(line);
      if (flow !== null) {
        for (const item of flow[1].split(',')) {
          const v = item.trim().replace(/^['"]|['"]$/g, '');
          if (v !== '') out.push(v);
        }
      }
    }
  }
  return out;
}

/**
 * The `name` of a directory's package.json, or null.
 * @param {string} root
 * @param {string} dir
 * @returns {string | null}
 */
function packageName(root, dir) {
  const file = path.join(root, dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    const name = readJson(file)?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}
