// @ts-check
import { execFileSync } from 'node:child_process';
import { ScannerError } from './errors.mjs';

/**
 * @typedef {object} ChangedFile
 * @property {string} path Repo-relative path in the working tree (forward slashes).
 * @property {string | null} oldPath Repo-relative path at the base, or null for new files.
 * @property {'added' | 'modified' | 'renamed' | 'untracked'} status
 * @property {Set<number> | 'all'} addedLines 1-based line numbers added in the working tree.
 */

/** Read-only: never let git take optional locks (index refresh) while we inspect the repo. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/**
 * Runs git and returns stdout. Throws on non-zero exit.
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {string}
 */
export function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Runs git and returns stdout, or null when git exits non-zero.
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {string | null}
 */
export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @returns {string} Absolute path of the repository root.
 */
export function repoRoot(cwd) {
  const out = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (out === null) {
    throw new ScannerError('NOT_A_GIT_REPO', `Not inside a git repository: ${cwd}`, 3);
  }
  return out.trim();
}

/** Fallback base branches, tried in this exact order when origin/HEAD is not set. */
const BASE_FALLBACKS = /** @type {const} */ ([
  'origin/main',
  'origin/master',
  'origin/develop',
  'main',
  'master',
  'develop',
]);

/**
 * @param {string} root
 * @param {string} ref
 * @returns {boolean}
 */
function refExists(root, ref) {
  return tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root) !== null;
}

/**
 * Resolves the base ref to compare against. Explicit ref wins; otherwise origin/HEAD,
 * then the fixed fallback list.
 * @param {string} root
 * @param {string | null} requested
 * @returns {string}
 */
export function resolveBaseRef(root, requested) {
  if (requested !== null) {
    if (!refExists(root, requested)) {
      throw new ScannerError(
        'BASE_NOT_FOUND',
        `Base ref not found: ${requested}`,
        2,
        'Fetch it first (e.g. `git fetch origin <branch>`) or pass another --base.',
      );
    }
    return requested;
  }
  const originHead = tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
  if (originHead !== null && originHead.trim() !== '' && refExists(root, originHead.trim())) {
    return originHead.trim();
  }
  for (const candidate of BASE_FALLBACKS) {
    if (refExists(root, candidate)) return candidate;
  }
  throw new ScannerError(
    'BASE_NOT_FOUND',
    'Could not determine a base branch (no origin/HEAD, main, master or develop).',
    2,
    'Pass --base <ref> explicitly.',
  );
}

/**
 * @param {string} root
 * @param {string} baseRef
 * @returns {string} Merge-base commit sha between HEAD and baseRef.
 */
export function mergeBase(root, baseRef) {
  const out = tryGit(['merge-base', 'HEAD', baseRef], root);
  if (out === null) {
    throw new ScannerError('NO_MERGE_BASE', `HEAD and ${baseRef} share no history.`, 2);
  }
  return out.trim();
}

/**
 * @param {string} root
 * @returns {{ ref: string, sha: string, dirty: boolean }}
 */
export function headInfo(root) {
  const ref = (tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], root) ?? 'HEAD').trim();
  const sha = (tryGit(['rev-parse', 'HEAD'], root) ?? '').trim();
  const status = tryGit(['status', '--porcelain', '--untracked-files=normal'], root) ?? '';
  return { ref, sha, dirty: status.trim() !== '' };
}

/**
 * Decodes a path as printed by git in diff headers: optional C-style quoting,
 * optional trailing TAB (git appends it to names containing spaces).
 * @param {string} raw
 * @returns {string}
 */
function decodeDiffPath(raw) {
  let s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (s.startsWith('"') && s.endsWith('"')) {
    const body = s.slice(1, -1);
    /** @type {number[]} */
    const bytes = [];
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch !== '\\') {
        for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
        continue;
      }
      const next = body[i + 1];
      const simple = /** @type {Record<string, number>} */ ({ n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 });
      if (next !== undefined && next in simple) {
        bytes.push(simple[next]);
        i += 1;
      } else if (next !== undefined && /[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
        i += 3;
      }
    }
    s = Buffer.from(bytes).toString('utf8');
  }
  return s;
}

/**
 * Lists files changed between the merge-base and the working tree (committed, staged,
 * unstaged and untracked), with the exact set of added line numbers for each.
 * @param {string} root
 * @param {string} base Merge-base sha.
 * @returns {ChangedFile[]} Sorted by path.
 */
export function changedFiles(root, base) {
  /** @type {Map<string, ChangedFile>} */
  const files = new Map();

  const nameStatus = git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--diff-filter=AMR', base], root);
  const parts = nameStatus.split('\0').filter((p) => p !== '');
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (status.startsWith('R')) {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      files.set(newPath, { path: newPath, oldPath, status: 'renamed', addedLines: new Set() });
      i += 3;
    } else {
      const p = parts[i + 1];
      files.set(p, {
        path: p,
        oldPath: status === 'A' ? null : p,
        status: status === 'A' ? 'added' : 'modified',
        addedLines: new Set(),
      });
      i += 2;
    }
  }

  const diff = git(
    [
      'diff',
      '-U0',
      '-M',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--diff-filter=AMR',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
    ],
    root,
  );
  /** @type {ChangedFile | null} */
  let current = null;
  let remainingOld = 0;
  let remainingNew = 0;
  for (const line of diff.split('\n')) {
    if (remainingOld > 0 || remainingNew > 0) {
      if (line.startsWith('+')) remainingNew -= 1;
      else if (line.startsWith('-')) remainingOld -= 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = decodeDiffPath(line.slice(4));
      const p = raw.startsWith('b/') ? raw.slice(2) : null;
      current = p === null ? null : (files.get(p) ?? null);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null) {
      remainingOld = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      const count = hunk[3] === undefined ? 1 : Number(hunk[3]);
      remainingNew = count;
      if (current !== null && current.addedLines !== 'all') {
        for (let n = start; n < start + count; n += 1) current.addedLines.add(n);
      }
    }
  }

  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const p of untracked.split('\0')) {
    if (p !== '' && !files.has(p)) {
      files.set(p, { path: p, oldPath: null, status: 'untracked', addedLines: 'all' });
    }
  }
  for (const f of files.values()) {
    if (f.status === 'added') f.addedLines = 'all';
  }

  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Content of a file at a commit, or null if it does not exist there.
 * @param {string} root
 * @param {string} commit
 * @param {string} path
 * @returns {string | null}
 */
export function fileAtCommit(root, commit, path) {
  return tryGit(['show', `${commit}:${path}`], root);
}

/**
 * Tracked files (working tree) whose content contains any of the given fixed strings.
 * @param {string} root
 * @param {readonly string[]} needles
 * @param {readonly string[]} pathspecs
 * @returns {string[]} Sorted repo-relative paths.
 */
export function grepFiles(root, needles, pathspecs) {
  if (needles.length === 0) return [];
  const args = ['grep', '-l', '-z', '-F', '--untracked', '--exclude-standard'];
  for (const n of needles) args.push('-e', n);
  args.push('--', ...pathspecs);
  const out = tryGit(args, root);
  if (out === null) return [];
  return out
    .split('\0')
    .filter((p) => p !== '')
    .sort();
}
