// @ts-check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ScannerError } from './errors.mjs';

/**
 * @typedef {object} ChangedFile
 * @property {string} path Repo-relative path in the working tree (forward slashes).
 * @property {string | null} oldPath Repo-relative path at the base, or null for new files.
 * @property {'added' | 'modified' | 'renamed' | 'untracked'} status
 * @property {Set<number> | 'all'} addedLines 1-based line numbers added in the working tree.
 */

/**
 * The side of the comparison whose changes are reviewed: the working tree (committed, staged,
 * unstaged and untracked changes), the index (staged changes only) or a commit.
 * @typedef {{ kind: 'worktree' } | { kind: 'staged' } | { kind: 'commit', ref: string, sha: string }} Target
 */

/** @type {Target} */
export const WORKTREE = Object.freeze({ kind: 'worktree' });

/** @type {Target} */
const STAGED = Object.freeze({ kind: 'staged' });

/** Read-only: never let git take optional locks (index refresh) while we inspect the repo. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/**
 * Runs git and returns stdout. Throws on non-zero exit. Every git call of the scanners goes
 * through here, so flags, environment and limits stay the same everywhere.
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {{ input?: string }} [opts] `input` is written to git's stdin.
 * @returns {string}
 */
export function git(args, cwd, opts = {}) {
  return gitBuffer(args, cwd, opts).toString('utf8');
}

/**
 * Like `git`, but returns raw stdout bytes (for byte-counted protocols such as `cat-file --batch`).
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {{ input?: string }} [opts]
 * @returns {Buffer}
 */
export function gitBuffer(args, cwd, opts = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env: GIT_ENV,
    maxBuffer: 512 * 1024 * 1024,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(opts.input === undefined ? {} : { input: opts.input }),
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
 * The `--base` value that reviews whole files: every line of the reviewed files counts as added,
 * compared with git's empty tree instead of a merge-base. Reserved: it never names a ref.
 */
export const NO_BASE = 'none';

/**
 * Resolves the base ref to compare against. Explicit ref wins (`none`: whole files, no base);
 * otherwise origin/HEAD, then the fixed fallback list.
 * @param {string} root
 * @param {string | null} requested
 * @returns {string}
 */
export function resolveBaseRef(root, requested) {
  if (requested === NO_BASE) return NO_BASE;
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
 * @param {ReviewedTree} tree The merge-base is taken with the reviewed commit, or with HEAD.
 * @param {string} baseRef
 * @returns {string} Merge-base commit sha between HEAD (or the reviewed commit) and baseRef, or
 *   the empty tree's id when baseRef is `NO_BASE`.
 */
export function mergeBase(tree, baseRef) {
  // Whole files: git's empty tree (its id depends on the repository's hash algorithm).
  if (baseRef === NO_BASE) return git(['hash-object', '-t', 'tree', '--stdin'], tree.root, { input: '' }).trim();
  const out = tryGit(['merge-base', tree.headRev, baseRef], tree.root);
  if (out === null) {
    throw new ScannerError('NO_MERGE_BASE', `${tree.headName} and ${baseRef} share no history.`, 2);
  }
  return out.trim();
}

/**
 * Resolves the reviewed side from the scanner options: `--head <ref>` (a commit), `--staged`
 * (the index) or, by default, the working tree.
 * @param {string} root
 * @param {{ head: string | null, staged: boolean }} opts
 * @returns {Target}
 */
export function resolveTarget(root, opts) {
  if (opts.head !== null && opts.staged) {
    throw new ScannerError('USAGE', '--head and --staged cannot be combined.', 2, 'Pass one of them.');
  }
  if (opts.staged) return STAGED;
  if (opts.head === null) return WORKTREE;
  const sha = tryGit(['rev-parse', '--verify', '--quiet', `${opts.head}^{commit}`], root);
  if (sha === null) {
    throw new ScannerError('HEAD_NOT_FOUND', `Head ref not found: ${opts.head}`, 2, 'Fetch it first or pass another --head.');
  }
  return { kind: 'commit', ref: opts.head, sha: sha.trim() };
}

/**
 * The reviewed side of the comparison: the working tree, the index or a commit. Everything that
 * differs between the three lives here, so callers never branch on the target's kind.
 * @typedef {object} ReviewedTree
 * @property {string} root Repository root.
 * @property {Target} target
 * @property {string} headRev The commit the merge-base is taken with (HEAD, or the reviewed commit).
 * @property {string} headName How errors name that commit.
 * @property {() => { ref: string, sha: string, dirty: boolean }} head The `head` of a report.
 * @property {(base: string) => string[]} diffSides `git diff` arguments comparing the merge-base with this side.
 * @property {(pathspecs: readonly string[]) => string[]} untracked Untracked files (the working tree only).
 * @property {{ before: string[], after: string[], prefix: string }} grep `git grep` arguments before and
 *   after the patterns, and the prefix git puts before each matching path.
 * @property {(paths: readonly string[]) => { texts: Map<string, string>, unreadable: string[] }} readFiles
 * @property {(paths: readonly string[]) => (rel: string) => string | null} reader Reader of these
 *   files' texts, each handed out once: on disk one at a time (one file in memory), from git in one call.
 * @property {(rel: string) => string | null} readText One file's text, or null when it is missing.
 * @property {(rel: string) => boolean} exists Whether a file or directory exists.
 * @property {(dir: string) => string[]} subdirs Names of a directory's subdirectories (`''`: the root).
 */

/**
 * The working tree: committed, staged, unstaged and untracked changes, read from disk.
 * @param {string} root
 * @returns {ReviewedTree}
 */
export function worktreeTree(root) {
  /** @param {string} rel */
  const readText = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  /** @param {readonly string[]} paths */
  const readFiles = (paths) => {
    /** @type {Map<string, string>} */
    const texts = new Map();
    /** @type {string[]} */
    const unreadable = [];
    for (const p of paths) {
      const text = readText(p);
      if (text === null) unreadable.push(p);
      else texts.set(p, text);
    }
    return { texts, unreadable };
  };
  return {
    root,
    target: WORKTREE,
    headRev: 'HEAD',
    headName: 'HEAD',
    head: () => headInfo(root),
    diffSides: (base) => [base],
    untracked: (pathspecs) => splitZ(git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs], root)),
    grep: { before: ['--untracked', '--exclude-standard'], after: [], prefix: '' },
    readFiles,
    reader: () => readText,
    readText,
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    subdirs: (dir) => {
      try {
        return fs
          .readdirSync(path.join(root, dir), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
      } catch {
        return [];
      }
    },
  };
}

/**
 * A side read from git objects: the index (`rev` = `''`, git's `:<path>`) or a commit (`rev` = its
 * sha, `<sha>:<path>`). The file listing is read once, the first time it is needed.
 * @param {string} root
 * @param {string} rev
 * @param {string[]} listArgs The git command that lists every file of this side, NUL-separated.
 * @returns {Pick<ReviewedTree, 'readFiles' | 'reader' | 'readText' | 'exists' | 'subdirs'>}
 */
function objectSide(root, rev, listArgs) {
  /** @type {{ files: Set<string>, children: Map<string, Set<string>> } | null} */
  let listing = null;
  const list = () => {
    if (listing !== null) return listing;
    /** @type {Map<string, Set<string>>} */
    const children = new Map();
    const files = new Set(splitZ(git(listArgs, root)));
    for (const f of files) {
      const segments = f.split('/');
      for (let i = 1; i < segments.length; i += 1) {
        const parent = segments.slice(0, i - 1).join('/');
        const set = children.get(parent) ?? new Set();
        set.add(/** @type {string} */ (segments[i - 1]));
        children.set(parent, set);
      }
    }
    listing = { files, children };
    return listing;
  };
  /** @param {readonly string[]} paths */
  const readFiles = (paths) => readObjects(root, rev, paths);
  return {
    readFiles,
    reader: (paths) => {
      const { texts } = readFiles(paths);
      return (rel) => {
        const text = texts.get(rel) ?? null;
        texts.delete(rel);
        return text;
      };
    },
    readText: (rel) => readFiles([rel]).texts.get(rel) ?? null,
    exists: (rel) => list().files.has(rel) || list().children.has(rel),
    subdirs: (dir) => [...(list().children.get(dir) ?? [])].sort(),
  };
}

/**
 * The index: staged changes only.
 * @param {string} root
 * @returns {ReviewedTree}
 */
function indexTree(root) {
  return {
    root,
    target: STAGED,
    headRev: 'HEAD',
    headName: 'HEAD',
    head: () => headInfo(root),
    diffSides: (base) => ['--cached', base],
    untracked: () => [],
    grep: { before: ['--cached'], after: [], prefix: '' },
    ...objectSide(root, '', ['ls-files', '--cached', '-z']),
  };
}

/**
 * A commit, never the working tree.
 * @param {string} root
 * @param {Extract<Target, { kind: 'commit' }>} target
 * @returns {ReviewedTree}
 */
function commitTree(root, target) {
  return {
    root,
    target,
    headRev: target.sha,
    headName: target.ref,
    head: () => ({ ref: target.ref, sha: target.sha, dirty: false }),
    diffSides: (base) => [base, target.sha],
    untracked: () => [],
    // A revision goes after the patterns: git would read `-f` as one otherwise.
    grep: { before: [], after: [target.sha], prefix: `${target.sha}:` },
    ...objectSide(root, target.sha, ['ls-tree', '-r', '-z', '--name-only', target.sha]),
  };
}

/**
 * The reviewed side for a target.
 * @param {string} root
 * @param {Target} target
 * @returns {ReviewedTree}
 */
export function reviewedTree(root, target) {
  if (target.kind === 'commit') return commitTree(root, target);
  return target.kind === 'staged' ? indexTree(root) : worktreeTree(root);
}

/**
 * NUL-separated git output as a list, without empty entries.
 * @param {string} out
 * @returns {string[]}
 */
function splitZ(out) {
  return out.split('\0').filter((p) => p !== '');
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
 * Lists files changed between the merge-base and the reviewed side (the working tree: committed,
 * staged, unstaged and untracked; the index; or a commit), with the exact set of added line
 * numbers for each.
 * @param {ReviewedTree} tree
 * @param {string} base Merge-base sha.
 * @param {readonly string[]} [pathspecs] Git pathspecs that limit the files (none: every file).
 * @returns {ChangedFile[]} Sorted by path.
 */
export function changedFiles(tree, base, pathspecs = []) {
  const root = tree.root;
  const sides = [...tree.diffSides(base), '--', ...pathspecs];
  /** @type {Map<string, ChangedFile>} */
  const files = new Map();

  const nameStatus = git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--diff-filter=AMR', ...sides], root);
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
      ...sides,
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

  for (const p of tree.untracked(pathspecs)) {
    if (!files.has(p)) {
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
 * Files on the reviewed side whose content contains any of the given fixed strings: tracked and
 * untracked (non-ignored) files of the working tree, the index, or a commit. One `git grep` pass
 * with the needles on stdin (`-f -`), so neither the needle count nor their length meets a
 * command-line limit. Exit 1 (no match) is an empty result; any other failure throws
 * GIT_GREP_FAILED, so callers can say the search did not run.
 * @param {ReviewedTree} tree
 * @param {readonly string[]} needles Fixed strings without line breaks.
 * @param {readonly string[]} pathspecs
 * @returns {string[]} Sorted repo-relative paths.
 */
export function grepFiles(tree, needles, pathspecs) {
  // git grep -f rejects a pattern with a line break (it would split) or a NUL byte (fatal).
  const patterns = needles.filter((n) => n !== '' && !/[\n\r\0]/.test(n));
  if (patterns.length === 0) return [];
  const { before, after, prefix } = tree.grep;
  let out;
  try {
    out = git(['grep', '-l', '-z', '-F', ...before, '-f', '-', ...after, '--', ...pathspecs], tree.root, {
      input: `${patterns.join('\n')}\n`,
    });
  } catch (e) {
    const err = /** @type {{ status?: number | null, stderr?: string | Buffer, message?: string }} */ (e);
    if (err.status === 1) return [];
    const reason = String(err.stderr ?? '').trim() || String(err.message ?? e);
    throw new ScannerError('GIT_GREP_FAILED', `git grep failed (exit ${err.status ?? '?'}): ${reason.split('\n')[0]}`, 3);
  }
  return [...new Set(splitZ(out).map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)))].sort();
}

/**
 * Contents of several files at a commit in one `git cat-file --batch` call (one subprocess,
 * however many paths; a name with a line break, which the batch protocol cannot carry, is read on
 * its own). If the batch call itself fails, each file is read on its own. Every path asked for is
 * expected at the commit: one that cannot be read is listed in `unreadable`, never dropped silently.
 * @param {string} root
 * @param {string} commit
 * @param {readonly string[]} paths Repo-relative paths.
 * @returns {{ texts: Map<string, string>, unreadable: string[] }}
 */
export function filesAtCommit(root, commit, paths) {
  return readObjects(root, commit, paths);
}

/**
 * Like `filesAtCommit`, for a commit or the index.
 * @param {string} root
 * @param {string} rev A commit, or `''` for the index (git names an index entry `:<path>`).
 * @param {readonly string[]} paths Repo-relative paths.
 * @returns {{ texts: Map<string, string>, unreadable: string[] }}
 */
function readObjects(root, rev, paths) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @param {string} p */
  const readOne = (p) => {
    const text = fileAtCommit(root, rev, p);
    if (text !== null) out.set(p, text);
  };
  const done = () => ({ texts: out, unreadable: paths.filter((p) => !out.has(p)) });
  for (const p of paths) if (/[\n\r]/.test(p)) readOne(p);
  const wanted = paths.filter((p) => !/[\n\r]/.test(p));
  if (wanted.length === 0) return done();
  /** @type {Buffer} */
  let buf;
  try {
    buf = gitBuffer(['cat-file', '--batch'], root, { input: wanted.map((p) => `${rev}:${p}\n`).join('') });
  } catch {
    for (const p of wanted) readOne(p);
    return done();
  }
  let pos = 0;
  /** Paths git answered `missing` for: a final answer, not retried. */
  /** @type {Set<string>} */
  const missing = new Set();
  for (const p of wanted) {
    const eol = buf.indexOf(10, pos);
    if (eol < 0) break;
    const header = buf.toString('utf8', pos, eol);
    pos = eol + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    const size = m === null ? 0 : Number(m[2]);
    // `<object> missing`, a tree or a submodule commit: no previous text, a final answer.
    if (m === null || m[1] !== 'blob') {
      missing.add(p);
      pos += m === null ? 0 : size + 1;
      continue;
    }
    if (pos + size > buf.length) break; // output ends inside this blob: the rest is read one by one
    out.set(p, buf.toString('utf8', pos, pos + size));
    pos += size + 1;
  }
  // Output cut short: whatever the batch did not deliver is read on its own.
  for (const p of wanted) if (!out.has(p) && !missing.has(p)) readOne(p);
  return done();
}

/**
 * Whether a file or directory exists in a commit.
 * @param {string} root
 * @param {string} commit
 * @param {string} path Repo-relative path.
 * @returns {boolean}
 */
export function pathExistsAtCommit(root, commit, path) {
  return tryGit(['cat-file', '-e', `${commit}:${path}`], root) !== null;
}

/**
 * Files deleted between the merge-base and the reviewed side. Code moved out of them is not new.
 * Never limited by pathspecs: code moved from outside the reviewed paths is not new either.
 * @param {ReviewedTree} tree
 * @param {string} base Merge-base sha.
 * @param {{ renamedAwayCounts: boolean }} opts `renamedAwayCounts`: a file renamed away is listed
 *   as deleted too (`--no-renames`), for when its new path may lie outside the reviewed paths.
 * @returns {string[]} Sorted repo-relative paths at the base.
 */
export function deletedFiles(tree, base, { renamedAwayCounts }) {
  const renames = renamedAwayCounts ? '--no-renames' : '-M';
  return splitZ(git(['diff', '--name-only', '-z', renames, '--no-ext-diff', '--diff-filter=D', ...tree.diffSides(base)], tree.root)).sort();
}
