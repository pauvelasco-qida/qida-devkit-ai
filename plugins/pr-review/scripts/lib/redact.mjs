// @ts-check
/**
 * Redaction of code snippets, shared by every scanner. A snippet is one source line printed in a
 * report; whichever finding it belongs to, it must never show a secret (ADR-TR-002 §4, ADR-IN-007).
 */
import { maskOpaqueTokens, secretFormatRanges, secretKind } from './classify.mjs';
import { PRIVATE_KEY, PRIVATE_KEY_HEADER } from './rules.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./classify.mjs').Literal} Literal */

/** Shortest secret fragment whose copies elsewhere in the file are masked (shorter ones are noise). */
const MIN_COPY = 8;

/**
 * A PEM private key (header and body, as `PRIVATE_KEY` defines it) up to its footer, or to the end
 * of the text. A bare header is not a key and stays visible.
 */
const PEM_BLOCK = new RegExp(`${PRIVATE_KEY.source}[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`, 'g');


/**
 * A text with every PEM private key (header and body), every known-format credential and every
 * high-entropy opaque token replaced.
 * @param {string} text
 * @returns {string}
 */
export function maskStraySecrets(text) {
  let out = text.replace(PEM_BLOCK, '[REDACTED]');
  // All matches at once, nested ones merged: replacing one first could break the match around it.
  const ranges = secretFormatRanges(out);
  for (let i = ranges.length - 1; i >= 0; i -= 1) out = `${out.slice(0, ranges[i][0])}[REDACTED]${out.slice(ranges[i][1])}`;
  // The same token scan as `secretKind`: data URIs and SRI hashes stay visible.
  return maskOpaqueTokens(out);
}

/**
 * Shortens a text. A trailing call (`.parse(…)`, `.safeParseAsync(…)`) is kept and the text before
 * it is shortened instead, so a subject or suggestion still names the method. `cut` shortens the
 * rest: a plain slice for printed text (already masked), or a separator-only cut (`capText`) for
 * stored text, which is masked later and must not hold a partial token.
 * @param {string} s
 * @param {number} max
 * @param {(text: string, max: number) => string} [cut]
 * @returns {string}
 */
export function clip(s, max, cut = (text, m) => `${text.slice(0, m - 1)}…`) {
  if (s.length <= max) return s;
  const call = /\.[A-Za-z_$][\w$]*\(…\)$/.exec(s);
  if (call !== null && call[0].length < max - 1) return `${cut(s.slice(0, -call[0].length), max - call[0].length)}${call[0]}`;
  return cut(s, max);
}

/** Report fields that quote source text, with their length limit (`null`: no limit). */
// `suggestion` and `expected` are pasted verbatim as the fix: masked, never shortened, except a
// call-form suggestion (`<receiver>.safeParse(…)`), which is not code to paste and may quote a
// whole inline schema: it is shortened before the call, which stays.
const QUOTED_FIELDS = /** @type {const} */ ({ value: null, subject: 60, detail: 120, expected: null, suggestion: 'call', code: 160 });
const MAX_CALL_SUGGESTION = 120;

/**
 * The redaction boundary of every scanner: the fields of each record that quote source text are
 * masked, then shortened (masking first, so a cut cannot shorten a token below recognition and
 * leak its prefix). Paths, ids, rule names and file-name items (line 0) are left as they are.
 * @template {Record<string, unknown>} T
 * @param {readonly T[]} records
 * @returns {T[]}
 */
export function redactRecords(records) {
  return records.map((r) => {
    // A file or directory name item (line 0) quotes no source: its subject and rename suggestion
    // are the path the `file` field shows anyway, and must stay usable.
    if (r.line === 0) return r;
    /** @type {Record<string, unknown>} */
    const out = { ...r };
    for (const [field, max] of Object.entries(QUOTED_FIELDS)) {
      const v = out[field];
      if (typeof v === 'string') {
        const masked = maskStraySecrets(v);
        if (max === null) out[field] = masked;
        else if (max === 'call') out[field] = masked.endsWith('(…)') ? clip(masked, MAX_CALL_SUGGESTION) : masked;
        else out[field] = clip(masked, max);
      }
    }
    return /** @type {T} */ (out);
  });
}

/**
 * Masked snippets of one file, computed only for the lines actually printed.
 *
 * A line is masked in two passes here, and once more at the report boundary: every span of a secret-looking literal of the file (each line
 * a multi-line key spans, merged when spans share a line, so no fragment survives however short);
 * every other copy of such a literal anywhere (raw source text and decoded value, trimmed, so a
 * different indentation does not hide it). Any secret-looking token left on the line, even one
 * that exists only in a comment, is masked by `redactRecords`.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {readonly string[]} lines Lines as TypeScript numbers them (`sourceLines`).
 * @param {() => readonly Literal[]} [secrets] The file's literals holding secret text (see
 *   `holdsSecretText`), from literals the caller already holds; called only when a snippet is printed.
 * @returns {(line: number) => string} Masked, trimmed snippet of a 1-based TypeScript line.
 */
export function snippetMasker(ts, sf, lines, secrets) {
  if (secrets === undefined) return lineMasker(ts, sf, lines);
  /** @type {{ ranges: Map<number, Range[]>, pieces: string[] } | null} */
  let index = null;
  const build = () => {
    /** @type {Map<number, Range[]>} */
    const ranges = new Map();
    /** @type {Set<string>} */
    const pieces = new Set();
    // The caller's list holds the literals with secret text, its kinds already computed.
    for (const lit of secrets()) {
      const start = sf.getLineAndCharacterOfPosition(lit.node.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(lit.node.end);
      const raw = lit.node.getText(sf);
      for (let i = start.line; i <= end.line; i += 1) {
        const from = i === start.line ? start.character : 0;
        const to = i === end.line ? end.character : Number.POSITIVE_INFINITY;
        const text = start.line === end.line ? spanReplacement(raw, lit.value) : '[REDACTED]';
        ranges.set(i, [...(ranges.get(i) ?? []), [from, to, text]]);
      }
      for (const s of [raw.length >= 2 ? raw.slice(1, -1) : raw, lit.value]) {
        const parts = s.split(/\r\n|[\r\n\u2028\u2029]/);
        // A one-line secret is masked wherever it is copied. Of a multi-line literal, only the
        // lines that look secret themselves: its plain lines (`"type": "service_account",`) are
        // ordinary text elsewhere in the file. Its own lines are masked whole by the span above.
        for (const piece of parts) {
          const p = piece.trim();
          if (p.length >= MIN_COPY && (parts.length === 1 || secretKind(p) !== null)) pieces.add(p);
        }
      }
    }
    return { ranges, pieces: [...pieces].sort((x, y) => y.length - x.length || (x < y ? -1 : 1)) };
  };
  return (lineNo) => {
    index ??= build();
    const i = lineNo - 1;
    const line = lines[i] ?? '';
    const rs = index.ranges.get(i);
    let out = rs === undefined ? line : applyRanges(line, rs);
    for (const piece of index.pieces) out = out.split(piece).join('[REDACTED]');
    // Stray tokens are masked at the report boundary (`redactRecords`), with every other field.
    return out.trim();
  };
}

/**
 * Snippet masker for scanners that hold no literal list (ts-conventions, zod): it looks only at
 * the literals touching the printed line, found by a walk that visits only the nodes spanning it,
 * and masks the spans of those holding secret text. Copies of a secret elsewhere on the line are
 * secret-looking text themselves and are masked at the report boundary (`redactRecords`).
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {readonly string[]} lines
 * @returns {(line: number) => string}
 */
function lineMasker(ts, sf, lines) {
  const starts = sf.getLineStarts();
  return (lineNo) => {
    const i = lineNo - 1;
    const line = lines[i] ?? '';
    const lineStart = starts[i] ?? sf.text.length;
    const lineEnd = lineStart + line.length;
    /** @type {Range[]} */
    const ranges = [];
    /** @param {import('typescript').Node} node */
    const visit = (node) => {
      if (node.end < lineStart || node.pos > lineEnd) return;
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const value = ts.isTemplateExpression(node) ? node.getText(sf).slice(1, -1) : node.text;
        if (holdsSecretText(ts, node, value, secretKind(value))) {
          const whole = node.getStart(sf) >= lineStart && node.end <= lineEnd;
          const text = whole ? spanReplacement(node.getText(sf), value) : '[REDACTED]';
          ranges.push([Math.max(node.getStart(sf), lineStart) - lineStart, Math.min(node.end, lineEnd) - lineStart, text]);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return applyRanges(line, ranges).trim();
  };
}

/**
 * Whether a literal holds secret text that a snippet must hide: a credential or opaque token, or
 * a piece of a private key split across literals (any literal of a statement that has a bare
 * `-----BEGIN … PRIVATE KEY-----` header literal: its short last line looks like nothing on its
 * own). A bare header holds no secret text itself and stays readable.
 * @param {TS} ts
 * @param {import('typescript').Node} node
 * @param {string} value
 * @param {'format' | 'heuristic' | null} kind
 * @returns {boolean}
 */
export function holdsSecretText(ts, node, value, kind) {
  // The full scan only for the rare literal holding a header: is it a bare one (no body, and no
  // other secret text)? Every other literal is decided by the kind the caller already computed.
  const header = PRIVATE_KEY_HEADER.test(value);
  if (header) return maskStraySecrets(value) !== value || (isKeyBodyPiece(value) && inSplitKey(ts, node));
  return kind !== null || (isKeyBodyPiece(value) && inSplitKey(ts, node));
}

/**
 * Whether a literal can be a piece of a key body: base64 characters, with line breaks (real or
 * escaped), and some content. A footer (`-----END … PRIVATE KEY-----`), a separator or any other
 * text in the same chain is not key material.
 * @param {string} value
 * @returns {boolean}
 */
function isKeyBodyPiece(value) {
  const body = value.replace(/\r|\n|\\[nr]/g, '');
  return /^[A-Za-z0-9+/=]{4,}$/.test(body);
}

/** Per source file: whether its text holds a private-key header anywhere. */
/** @type {WeakMap<import('typescript').SourceFile, boolean>} */
const HAS_HEADER = new WeakMap();

/**
 * Whether a literal is a piece of a private key split across literals: it is joined to an earlier
 * bare `-----BEGIN … PRIVATE KEY-----` header literal by a `+` concatenation, or follows one in
 * the same array literal (`[…].join('')`). Other literals of the statement are unrelated.
 * @param {TS} ts
 * @param {import('typescript').Node} node
 * @returns {boolean}
 */
export function inSplitKey(ts, node) {
  // Most files hold no private-key header at all: answered once per file, without any walk.
  const sf = node.getSourceFile();
  let has = HAS_HEADER.get(sf);
  if (has === undefined) {
    has = PRIVATE_KEY_HEADER.test(sf.text);
    HAS_HEADER.set(sf, has);
  }
  if (!has) return false;
  let container = node;
  for (;;) {
    const p = container.parent;
    if (p === undefined) break;
    if ((ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isParenthesizedExpression(p)) container = p;
    else break;
  }
  // An array of pieces, each possibly a `+` chain itself (`['…', 'MIIE…' + '\n', …].join('')`).
  if (container.parent !== undefined && ts.isArrayLiteralExpression(container.parent)) container = container.parent;
  if (container === node) return false;
  // Position of the container's first bare header, found once per container: each piece of a
  // long `[…].join('')` array then costs a lookup, not a walk over its earlier siblings.
  let header = HEADER_AT.get(container);
  if (header === undefined) {
    header = null;
    /** @param {import('typescript').Node} n */
    const visit = (n) => {
      if (header !== null) return;
      if (ts.isStringLiteralLike(n) && PRIVATE_KEY_HEADER.test(n.text) && !PRIVATE_KEY.test(n.text)) header = n.pos;
      else ts.forEachChild(n, visit);
    };
    visit(container);
    HEADER_AT.set(container, header);
  }
  return header !== null && header < node.pos;
}

/** Per `+` chain or array literal: position of its first bare private-key header literal, or null. */
/** @type {WeakMap<import('typescript').Node, number | null>} */
const HEADER_AT = new WeakMap();

/** A masked character range of a line, `[from, to)`, and the text that replaces it. */
/** @typedef {[number, number, string]} Range */

/**
 * What replaces a one-line secret literal in a snippet: the literal with its secret parts masked
 * in place (a URL keeps its host and path), when its source spells exactly its value; otherwise,
 * when escapes make the source differ from the value, the whole literal.
 * @param {string} raw Source text of the literal, quotes included.
 * @param {string} value
 * @returns {string}
 */
function spanReplacement(raw, value) {
  if (raw.length < 2 || raw.slice(1, -1) !== value) return '[REDACTED]';
  const masked = maskStraySecrets(raw);
  return masked === raw ? '[REDACTED]' : masked;
}

/**
 * Applies masked ranges to a line. Overlapping ranges stay masked as one region.
 * @param {string} line
 * @param {readonly Range[]} ranges
 * @returns {string}
 */
function applyRanges(line, ranges) {
  let out = '';
  let pos = 0;
  let any = false;
  for (const [from, to, text] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (any && from < pos) {
      pos = Math.max(pos, to);
      continue;
    }
    out += `${line.slice(pos, from)}${text}`;
    pos = Math.max(pos, to);
    any = true;
  }
  return out + (pos < line.length ? line.slice(pos) : '');
}
