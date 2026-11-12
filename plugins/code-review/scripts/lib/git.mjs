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
 * Tracked and untracked (non-ignored) files whose content contains any of the given fixed
 * strings. One `git grep` pass with the needles on stdin (`-f -`), so neither the needle count
 * nor their length meets a command-line limit. Exit 1 (no match) is an empty result; any other
 * failure throws GIT_GREP_FAILED, so callers can say the search did not run.
 * @param {string} root
 * @param {readonly string[]} needles Fixed strings without line breaks.
 * @param {readonly string[]} pathspecs
 * @returns {string[]} Sorted repo-relative paths.
 */
export function grepFiles(root, needles, pathspecs) {
  // git grep -f rejects a pattern with a line break (it would split) or a NUL byte (fatal).
  const patterns = needles.filter((n) => n !== '' && !/[\n\r\0]/.test(n));
  if (patterns.length === 0) return [];
  let out;
  try {
    out = git(['grep', '-l', '-z', '-F', '--untracked', '--exclude-standard', '-f', '-', '--', ...pathspecs], root, {
      input: `${patterns.join('\n')}\n`,
    });
  } catch (e) {
    const err = /** @type {{ status?: number | null, stderr?: string | Buffer, message?: string }} */ (e);
    if (err.status === 1) return [];
    const reason = String(err.stderr ?? '').trim() || String(err.message ?? e);
    throw new ScannerError('GIT_GREP_FAILED', `git grep failed (exit ${err.status ?? '?'}): ${reason.split('\n')[0]}`, 3);
  }
  return [...new Set(out.split('\0').filter((p) => p !== ''))].sort();
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
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @param {string} p */
  const readOne = (p) => {
    const text = fileAtCommit(root, commit, p);
    if (text !== null) out.set(p, text);
  };
  const done = () => ({ texts: out, unreadable: paths.filter((p) => !out.has(p)) });
  for (const p of paths) if (/[\n\r]/.test(p)) readOne(p);
  const wanted = paths.filter((p) => !/[\n\r]/.test(p));
  if (wanted.length === 0) return done();
  /** @type {Buffer} */
  let buf;
  try {
    buf = gitBuffer(['cat-file', '--batch'], root, { input: wanted.map((p) => `${commit}:${p}\n`).join('') });
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
 * Files deleted between the merge-base and the working tree. Code moved out of them is not new.
 * @param {string} root
 * @param {string} base Merge-base sha.
 * @returns {string[]} Sorted repo-relative paths at the base.
 */
export function deletedFiles(root, base) {
  return git(['diff', '--name-only', '-z', '-M', '--no-ext-diff', '--diff-filter=D', base], root)
    .split('\0')
    .filter((p) => p !== '')
    .sort();
}
