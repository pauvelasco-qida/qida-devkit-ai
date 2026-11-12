// @ts-check
/**
 * Report rendering shared by every reviewer agent: turns a scanner's JSON and the agent's row
 * judgments of its REVIEW candidates into the reviewer's final markdown report, result line
 * included. Every fixed text of a report lives here, so an agent never copies or formats one and
 * the same scan plus the same judgments always render the same bytes.
 *
 * The report shape is the contract with `/code-review:code-review` (commands/code-review.md, step 3):
 * a `## <Title> — <verdict>` heading, a summary list, findings as list items under `### Blocking`
 * and `### Advisory`, other sections, and the result line `<!-- code-review:<key> {...} -->`.
 */

import { CONFIG_RELATIVE_PATH } from './config.mjs';
import { NO_BASE, WORKTREE } from './git.mjs';

/** The config file as cited in report texts. */
const CONFIG_REF = `\`${CONFIG_RELATIVE_PATH}\``;

/** @typedef {'blocking' | 'advisory' | 'notFlagged'} Section */
/** @typedef {import('./git.mjs').Target} Target */

/**
 * The scanner fields a report reads. Candidates keep every other field of the scanner.
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} file
 * @property {number} line
 * @property {string} rule
 * @property {'VIOLATION' | 'REVIEW'} preclass
 * @property {'blocking' | 'advisory'} [severity]
 * @property {string} [value]
 * @property {string} [subject]
 * @property {string} [detail]
 * @property {string | null} [suggestion]
 * @property {number} [occurrencesInPr]
 * @property {{ name: string, file: string, line: number }[]} [existingDefinitions]
 */

/**
 * @typedef {object} Scan
 * @property {string} [tool]
 * @property {{ code: string, message: string, hint: string | null }} [error]
 * @property {{ ref: string, mergeBase: string }} base
 * @property {{ ref: string, dirty: boolean }} head
 * @property {{ changes: Target['kind'], paths: string[] }} [scope] Absent in older scans: the working tree, every path.
 * @property {{ typeInfo: string } | null} typescript
 * @property {{ disabledRules?: string[] }} [config]
 * @property {{ scanned: number, skipped: number }} files
 * @property {{ excluded: Record<string, number> }} summary
 * @property {Candidate[]} candidates
 * @property {string[]} [warnings]
 */

/**
 * One finding or not-flagged entry: the texts of its item.
 * @typedef {{ section: Section, why: string, fix: string | null }} Verdict
 */

/**
 * One row of a REVIEW decision table.
 * @typedef {{ section: Section, text: string, fix?: (c: Candidate) => string }} Row
 */

/**
 * @typedef {object} ReviewerSpec
 * @property {string} key Reviewer key, as in the orchestrator's table.
 * @property {string} tool The scanner's `tool` field.
 * @property {string} title Report title.
 * @property {string} noun What the Excluded line counts (`literals`, `items`).
 * @property {string} label Sub-item label of the code concerned (`Value`, `Subject`, `Call`).
 * @property {(c: Candidate) => string} code The code concerned, as inline code with its detail.
 * @property {string} noFiles Subject of the line written when no file was scanned (`<noFiles> changed.`, or `found.` for whole files).
 * @property {readonly string[]} typeNoteWhen `typescript.typeInfo` values that add the type Note.
 * @property {string} typeNote
 * @property {boolean} showDisabled Whether to list `config.disabledRules`.
 * @property {boolean} advisorySection Whether the report has an `### Advisory` section.
 * @property {(blocking: number, advisory: number) => boolean} acceptWhen
 * @property {string} accept The "To accept … deliberately" line.
 * @property {(c: Candidate) => Verdict} violation Texts of a VIOLATION candidate.
 * @property {Record<string, Record<string, Row>>} reviews REVIEW decision tables, by rule then row.
 * @property {(c: Candidate, row: string | null) => string} ruleLabel
 */

/**
 * A text as one line: line breaks and tabs written as escapes, so a list item never splits.
 * @param {string} s
 * @returns {string}
 */
export function oneLine(s) {
  return s.replace(/\r\n|[\r\n\t\u2028\u2029]/g, (m) =>
    m === '\r\n' ? '\\r\\n' : m === '\r' ? '\\r' : m === '\n' ? '\\n' : m === '\t' ? '\\t' : m === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/**
 * Markdown inline code. A text with backticks gets a longer fence and a space on each side.
 * @param {string} s
 * @returns {string}
 */
export function inlineCode(s) {
  const runs = s.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = runs.length > 0 ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * A text cut to `max` code points, followed by `…` when longer.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function cut(s, max) {
  const points = Array.from(s);
  return points.length > max ? `${points.slice(0, max).join('')}…` : s;
}

/** @param {string | undefined} detail */
const withDetail = (detail) => (detail === undefined || detail === '' ? '' : ` (${oneLine(detail)})`);

/** @param {Candidate} c */
const firstDefinition = (c) => {
  const d = c.existingDefinitions?.[0];
  if (d === undefined) throw new RenderError(`${c.id} (${c.rule}) has no existingDefinitions entry.`);
  return `\`${d.name}\` (\`${d.file}:${d.line}\`)`;
};

/**
 * A string field of a candidate, which its rule's text needs.
 * @param {Candidate} c
 * @param {'subject' | 'suggestion' | 'value'} field
 * @returns {string}
 */
const str = (c, field) => {
  const v = c[field];
  if (typeof v !== 'string') throw new RenderError(`${c.id} (${c.rule}) has no ${field}.`);
  return v;
};

const UI_TEXT_FIX =
  "Replace with `t('<namespace>:<key>')`, add the key to every locale file in this PR, and flag the proposed text for product review (ADR-FE-004 §5–§6).";
const UI_TEXT_WHY = 'Literal text shown to the user (ADR-FE-004).';

/** @type {Record<string, (c: Candidate) => { why: string, fix: string }>} */
const MAGIC_VIOLATIONS = {
  'V-SECRET': () => ({
    why: 'Looks like a credential; value redacted.',
    fix: 'Remove it from the code and rotate it; secrets live in AWS Secrets Manager (ADR-IN-007).',
  }),
  'V-FE002-INLINE-QUERY-KEY': (c) => ({
    why: 'Inline query key (ADR-FE-002 §3).',
    fix:
      (c.existingDefinitions ?? []).length > 0
        ? `Use ${firstDefinition(c)}.`
        : 'Add the key to the central query-key dictionary and use it.',
  }),
  'V-FE004-UI-TEXT': () => ({ why: UI_TEXT_WHY, fix: UI_TEXT_FIX }),
  'V-EXISTING-CONSTANT': (c) => ({ why: 'Same value as an existing named definition.', fix: `Use ${firstDefinition(c)}.` }),
  'V-DUPLICATED': (c) => ({
    why: `Same value ${c.occurrencesInPr ?? 1} times in this PR.`,
    fix: 'Extract one named constant, `as const` object or literal-union type, and use it in every occurrence.',
  }),
  'V-URL-OR-PATH': () => ({
    why: 'Inline URL or path.',
    fix: 'Move it to the routes/endpoints module (or the typed router), or to configuration if it is environment-specific.',
  }),
};

/** @type {Record<string, (c: Candidate) => { why: string, fix: string }>} */
const TS_VIOLATIONS = {
  'V-ANY': () => ({
    why: '`any` turns off type checking (ADR-FE-001 §2).',
    fix: 'Use a generic, `unknown` narrowed before use, or overloads; at a boundary, `as unknown as T`. Only an adapter around an untyped third-party library may keep it, with `// ts-conventions-ok: <reason>` on that line (ADR-FE-001 §2).',
  }),
  'V-CLASS': () => ({
    why: 'No classes in frontend application code (ADR-FE-001 §1).',
    fix: 'Use a factory function or a plain module; model data as a type plus pure functions.',
  }),
  'V-ENUM': () => ({
    why: 'Enums add reverse mappings and surprising `Object.keys` results.',
    fix: 'Replace with an `as const` object and derive its types with `keyof typeof` and `(typeof X)[keyof typeof X]`.',
  }),
  'V-DEFAULT-EXPORT': () => ({
    why: 'Default exports detach the imported name from its source.',
    fix: 'Use a named export. If the framework requires a default export in this file, add its path to ' + CONFIG_REF + ' → `tsConventions.defaultExportPaths`.',
  }),
  'V-INLINE-TYPE-IMPORT': (c) => ({
    why: 'Inline `type` specifiers can leave an empty side-effect import after transpilation.',
    fix:
      c.detail === 'all-type'
        ? `Write \`import type { ${str(c, 'subject')} } from …\`.`
        : `Move \`${str(c, 'subject')}\` to a separate \`import type { … }\` declaration.`,
  }),
  'V-INTERSECTION': (c) => ({
    why: '`&` is slower to check and gives worse errors than `interface extends`.',
    fix: `Declare \`interface ${str(c, 'subject')} extends …\` and move the object-literal members into its body.`,
  }),
  'V-RETURN-TYPE': (c) => ({
    why: 'Top-level function without an explicit return type.',
    fix: `Annotate the return type of \`${str(c, 'subject')}\`.`,
  }),
  'V-OPTIONAL-UNDEFINED': (c) => ({
    why: 'Required property typed `T | undefined` instead of an optional one.',
    fix: `Write \`${str(c, 'suggestion')}\`.`,
  }),
  'V-TYPE-PARAM-PREFIX': () => ({
    why: 'Type parameter without the `T` prefix.',
    fix: 'Rename it to `T` plus a descriptive name (e.g. `TItem`, `TKey`).',
  }),
  'V-TYPE-NAMING': (c) => ({ why: 'Types, interfaces, classes and enums are PascalCase.', fix: `Rename to \`${str(c, 'suggestion')}\`.` }),
  'V-VALUE-NAMING': (c) => ({
    why:
      c.detail === 'Zod schema'
        ? 'Zod schemas are PascalCase (`UserSchema`).'
        : 'Variables, functions and parameters are camelCase (components PascalCase, constants ALL_CAPS, Zod schemas PascalCase).',
    fix: `Rename to \`${str(c, 'suggestion')}\`.`,
  }),
  'V-CONST-NAMING': (c) => ({ why: 'Literal and `as const` constants are ALL_CAPS.', fix: `Rename to \`${str(c, 'suggestion')}\`.` }),
  'V-FILE-NAME': (c) => ({
    why: 'File and directory names are camelCase (a PascalCase file only when named after its export).',
    fix: `Rename to \`${str(c, 'suggestion')}\`.`,
  }),
};

/**
 * Looks a VIOLATION rule up in a catalogue.
 * @param {Record<string, (c: Candidate) => { why: string, fix: string }>} table
 * @param {Candidate} c
 * @param {Section} section
 * @returns {Verdict}
 */
function fromTable(table, c, section) {
  const entry = table[c.rule];
  if (entry === undefined) throw new RenderError(`${c.id}: rule ${c.rule} has no report text.`);
  return { section, ...entry(c) };
}

/** @type {ReviewerSpec} */
const MAGIC_STRINGS = {
  key: 'magic-strings',
  tool: 'find-magic-strings',
  title: 'Magic strings',
  noun: 'literals',
  label: 'Value',
  code: (c) => `${inlineCode(cut(oneLine(str(c, 'value')), 40))}${withDetail(c.detail)}`,
  noFiles: 'No TypeScript/JavaScript files',
  typeNoteWhen: ['none', 'partial'],
  typeNote: 'some files had no tsconfig coverage, so typed literals in them could not be proven safe.',
  showDisabled: false,
  advisorySection: false,
  acceptWhen: (blocking) => blocking > 0,
  accept:
    'To accept a literal deliberately: add `// magic-string-ok: <reason>` on its line (or on a comment-only line just above it), or list it in ' + CONFIG_REF + ' → `magicStrings.allowValues`. A `V-SECRET` in a known credential format cannot be accepted with the marker, only through `allowValues`; a real credential must be removed from the code.',
  violation: (c) => fromTable(MAGIC_VIOLATIONS, c, 'blocking'),
  reviews: {
    REVIEW: {
      R1: { section: 'blocking', text: UI_TEXT_WHY, fix: () => UI_TEXT_FIX },
      R2: { section: 'notFlagged', text: 'Developer-only text.' },
      R3: { section: 'notFlagged', text: 'Spelling imposed by an external spec or library API.' },
      R4: {
        section: 'blocking',
        text: 'Inline identifier without a compiler-checked name.',
        fix: () => 'Give it a compiler-checked name (constant, `as const` object or literal-union type) and use it at every occurrence.',
      },
    },
  },
  ruleLabel: (c, row) => row ?? c.rule,
};

/** @type {ReviewerSpec} */
const TS_CONVENTIONS = {
  key: 'ts-conventions',
  tool: 'find-ts-convention-issues',
  title: 'TypeScript conventions',
  noun: 'items',
  label: 'Subject',
  code: (c) => `${inlineCode(oneLine(str(c, 'subject')))}${withDetail(c.detail)}`,
  noFiles: 'No TypeScript files',
  typeNoteWhen: ['none', 'partial', 'disabled'],
  typeNote: 'some files had no type information, so intersections over union types may be over-reported.',
  showDisabled: true,
  advisorySection: true,
  acceptWhen: (blocking, advisory) => blocking + advisory > 0,
  accept:
    'To accept a case deliberately: add `// ts-conventions-ok: <reason>` on its line (or on a comment-only line just above it); to switch a rule off for the repository, list it in ' + CONFIG_REF + ' → `tsConventions.disabledRules`.',
  violation: (c) => fromTable(TS_VIOLATIONS, c, c.severity === 'blocking' ? 'blocking' : 'advisory'),
  reviews: {
    'REVIEW-DISCRIMINATED-UNION': {
      D1: {
        section: 'advisory',
        text: 'Bag of optionals: impossible states are representable.',
        fix: (c) => {
          // The scanner's detail starts with the literal-union property: `<name>: <type>; …`.
          const detail = c.detail ?? '';
          const name = detail.includes(': ') ? detail.slice(0, detail.indexOf(': ')) : detail;
          return `Model it as a discriminated union on \`${name}\`: one member per value, each with exactly its fields, and handle it with \`switch\`.`;
        },
      },
      D2: { section: 'notFlagged', text: 'Optional properties independent of the literal-union field.' },
    },
    'REVIEW-THROW': {
      T1: { section: 'notFlagged', text: 'Handled by the framework or an invariant guard.' },
      T2: {
        section: 'advisory',
        text: 'Predictable failure thrown to the caller.',
        fix: () => 'Return a `Result` (`{ ok: true; value: T } | { ok: false; error: E }`) and let callers branch on `ok`.',
      },
      T3: { section: 'notFlagged', text: 'Not clearly a predictable failure.' },
    },
  },
  ruleLabel: (c, row) => (row === null ? c.rule : `${c.rule} ${row}`),
};

/** @type {ReviewerSpec} */
const ZOD = {
  key: 'zod',
  tool: 'find-zod-issues',
  title: 'Zod validation',
  noun: 'items',
  label: 'Call',
  code: (c) => inlineCode(oneLine(str(c, 'subject'))),
  noFiles: 'No TypeScript files',
  typeNoteWhen: ['none', 'partial', 'disabled'],
  typeNote:
    "some files had no type information, so Zod schemas were recognised by their imports and names (see the README's design decisions): a schema from a published package with a neutral name may be missed, and a .parse call in a file that imports zod may be reported on a non-Zod local object.",
  showDisabled: false,
  advisorySection: false,
  acceptWhen: (blocking) => blocking > 0,
  accept:
    'To accept a case deliberately: add `// zod-ok: <reason>` on its line (or on a comment-only line just above it); to skip whole paths, list them in ' + CONFIG_REF + ' → `zod.ignorePaths`.',
  violation: (c) =>
    fromTable(
      {
        'V-ZOD-PARSE': () => ({
          why: '`parse` / `parseAsync` throw a `ZodError` on invalid input, so every caller needs a `try`/`catch`.',
          fix: `Use \`${str(c, 'suggestion')}\` and handle its \`success: false\` branch.`,
        }),
      },
      c,
      'blocking',
    ),
  reviews: {},
  ruleLabel: (c) => c.rule,
};

/** Every reviewer, in the orchestrator's table order. */
export const REVIEWERS = /** @type {const} */ ({
  'magic-strings': MAGIC_STRINGS,
  'ts-conventions': TS_CONVENTIONS,
  zod: ZOD,
});

/** A scan and judgments that cannot be rendered: the agent's input is wrong, not the scan. */
export class RenderError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

/**
 * Checks the judgments against the scan's REVIEW candidates: each one judged exactly once, with
 * a row of its rule's table, and nothing else judged. Every problem is reported at once.
 * @param {ReviewerSpec} spec
 * @param {readonly Candidate[]} candidates
 * @param {ReadonlyMap<string, string>} judgments Candidate id → row.
 */
function checkJudgments(spec, candidates, judgments) {
  /** @type {string[]} */
  const problems = [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const [id, row] of judgments) {
    const c = byId.get(id);
    if (c === undefined) problems.push(`${id} is not a candidate of this scan.`);
    else if (c.preclass !== 'REVIEW') problems.push(`${id} is a VIOLATION: it is reported as given and takes no judgment.`);
    else {
      const rows = Object.keys(spec.reviews[c.rule] ?? {});
      if (!rows.includes(row)) problems.push(`${id} (${c.rule}) has no row ${row}; use one of ${rows.join(', ')}.`);
    }
  }
  for (const c of candidates) {
    if (c.preclass === 'REVIEW' && !judgments.has(c.id)) {
      problems.push(`${c.id} (${c.rule}) is not judged; add --judge ${c.id}=<${Object.keys(spec.reviews[c.rule] ?? {}).join('|')}>.`);
    }
  }
  if (problems.length > 0) throw new RenderError(problems.join('\n'));
}

/**
 * @param {ReviewerSpec} spec
 * @param {Candidate} c
 * @param {string | null} row
 * @returns {Verdict}
 */
function verdictOf(spec, c, row) {
  if (row === null) return spec.violation(c);
  const r = /** @type {Row} */ (spec.reviews[c.rule]?.[row]);
  return { section: r.section, why: r.text, fix: r.fix === undefined ? null : r.fix(c) };
}

/**
 * The list item of one candidate.
 * @param {ReviewerSpec} spec
 * @param {Candidate} c
 * @param {string | null} row
 * @param {Verdict} v
 * @returns {string}
 */
function item(spec, c, row, v) {
  const at = c.line > 0 ? `${c.file}:${c.line}` : c.file;
  const lines = [`- **${c.id}** ${inlineCode(at)} — ${spec.key} · ${spec.ruleLabel(c, row)}`, `  - ${spec.label}: ${spec.code(c)}`];
  if (v.section === 'notFlagged') lines.push(`  - Reason: ${v.why}`);
  else lines.push(`  - Why: ${v.why}`, `  - Fix: ${v.fix ?? ''}`);
  return lines.join('\n');
}

/**
 * @param {string} key
 * @param {object} result
 */
const resultLine = (key, result) => `<!-- code-review:${key} ${JSON.stringify(result)} -->`;

/**
 * The reviewer's report for a scanner error.
 * @param {ReviewerSpec} spec
 * @param {{ code: string, message: string, hint: string | null }} error
 * @returns {string}
 */
function notRun(spec, error) {
  return [
    `## ${spec.title} — NOT RUN`,
    '',
    `- Error: \`${oneLine(String(error.code))}\` ${oneLine(String(error.message))}`,
    `- Fix: ${error.hint === null || error.hint === undefined ? 'Run the review again.' : oneLine(String(error.hint))}`,
    '',
    resultLine(spec.key, { verdict: 'NOT_RUN' }),
  ].join('\n');
}

/**
 * How the Scope line names the reviewed side, per kind of target.
 * @type {Readonly<Record<Target['kind'], (head: { ref: string, dirty: boolean }) => string>>}
 */
const SIDE_TEXT = Object.freeze({
  worktree: (head) => `\`${head.ref}\`${head.dirty ? ' + uncommitted changes' : ''}`,
  staged: () => 'staged changes',
  commit: (head) => `commit \`${head.ref}\``,
});

/**
 * Renders a reviewer's report.
 * @param {keyof typeof REVIEWERS} key
 * @param {Scan} scan The scanner's JSON.
 * @param {ReadonlyMap<string, string>} judgments REVIEW candidate id → decision-table row.
 * @returns {string} The report, ending with its result line (no trailing newline).
 */
export function renderReport(key, scan, judgments) {
  const spec = REVIEWERS[key];
  if (spec === undefined) throw new RenderError(`Unknown reviewer ${key}; use one of ${Object.keys(REVIEWERS).join(', ')}.`);
  if (scan.error !== undefined) {
    if (judgments.size > 0) throw new RenderError('The scan failed: it has no candidates to judge. Run it again without --judge.');
    return notRun(spec, scan.error);
  }
  if (scan.tool !== spec.tool) throw new RenderError(`This is a ${scan.tool ?? 'unknown'} scan, not a ${spec.tool} scan.`);
  checkJudgments(spec, scan.candidates, judgments);

  /** @type {Record<Section, { id: string, text: string }[]>} */
  const sections = { blocking: [], advisory: [], notFlagged: [] };
  for (const c of scan.candidates) {
    const row = c.preclass === 'REVIEW' ? (judgments.get(c.id) ?? null) : null;
    const v = verdictOf(spec, c, row);
    sections[v.section].push({ id: c.id, text: item(spec, c, row, v) });
  }
  const nBlocking = sections.blocking.length;
  const nAdvisory = sections.advisory.length;
  const verdict = nBlocking > 0 ? `FAIL (${nBlocking} blocking)` : nAdvisory > 0 ? `PASS (${nAdvisory} advisory)` : 'PASS';

  const { base, head, files, typescript } = scan;
  const paths = scan.scope?.paths ?? [];
  const side = SIDE_TEXT[scan.scope?.changes ?? WORKTREE.kind](head);
  const baseText = base.ref === NO_BASE ? 'whole files' : `\`${base.ref}\` (merge-base \`${base.mergeBase.slice(0, 7)}\`)`;
  const scope =
    `- Scope: ${baseText} → ${side}` +
    (paths.length === 0 ? '' : ` · paths ${paths.map((p) => `\`${oneLine(p)}\``).join(', ')}`) +
    ` · ${files.scanned} files scanned · ${files.skipped} skipped${typescript === null ? '' : ` · type info: ${typescript.typeInfo}`}`;
  const summary = [scope, ...(scan.warnings ?? []).map((w) => `- Note: ${oneLine(w)}`)];

  /** @type {string[]} */
  const blocks = [`## ${spec.title} — ${verdict}`];
  if (typescript === null) {
    blocks.push(summary.join('\n'), `${spec.noFiles} ${base.ref === NO_BASE ? 'found' : 'changed'}.`);
  } else {
    if (spec.typeNoteWhen.includes(typescript.typeInfo)) summary.push(`- Note: ${spec.typeNote}`);
    const disabled = scan.config?.disabledRules ?? [];
    if (spec.showDisabled && disabled.length > 0) summary.push(`- Disabled by configuration: ${disabled.join(', ')}`);
    const excluded = Object.entries(scan.summary.excluded);
    const total = excluded.reduce((n, [, k]) => n + k, 0);
    summary.push(
      `- Excluded by the scanner: ${total} ${spec.noun}${total === 0 ? '' : ` (${excluded.map(([rule, k]) => `${rule}: ${k}`).join(', ')})`}`,
    );
    blocks.push(summary.join('\n'));

    /** @param {string} heading @param {{ text: string }[]} list @param {boolean} always */
    const section = (heading, list, always) => {
      if (list.length === 0 && !always) return;
      blocks.push(heading, list.length === 0 ? 'None.' : list.map((i) => i.text).join('\n\n'));
    };
    section('### Blocking', sections.blocking, true);
    if (spec.advisorySection) section('### Advisory', sections.advisory, true);
    section('### Reviewed, not flagged', sections.notFlagged, false);
    if (spec.acceptWhen(nBlocking, nAdvisory)) blocks.push(spec.accept);
  }
  /** @param {{ id: string }[]} list */
  const ids = (list) => list.map((i) => i.id);
  blocks.push(
    resultLine(spec.key, {
      verdict: nBlocking > 0 ? 'FAIL' : 'PASS',
      blocking: ids(sections.blocking),
      advisory: ids(sections.advisory),
      notFlagged: ids(sections.notFlagged),
    }),
  );
  return blocks.join('\n\n');
}
