// @ts-check
/**
 * Rule catalogue and detector of the Zod scanner (find-zod-issues.mjs). Changing either changes
 * results: bump TOOL_VERSION in find-zod-issues.mjs and the plugin version.
 */
import { clip, rawItem } from './ts-scan.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Node} Node */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('typescript').TypeChecker} TypeChecker */

/** Reported rules, in report order. */
export const RULES = /** @type {const} */ ({
  'V-ZOD-PARSE': { preclass: 'VIOLATION', severity: 'blocking', adr: null },
});

/** @typedef {keyof typeof RULES} RuleId */
/** @typedef {import('./ts-scan.mjs').ScanItem<RuleId>} RawItem */

export const RULE_IDS = /** @type {RuleId[]} */ (Object.keys(RULES));

/** Line marker that accepts a finding deliberately (same line or a comment-only line above). */
export const SUPPRESSION_MARKER = 'zod-ok';

/** Zod methods that throw on invalid input, mapped to their non-throwing counterparts. */
export const SAFE_METHODS = new Map([
  ['parse', 'safeParse'],
  ['parseAsync', 'safeParseAsync'],
]);

/**
 * Finds every `.parse` / `.parseAsync` call on a Zod schema. Pure: depends only on the source
 * text and (when given) the type checker.
 *
 * With the checker, a receiver is a Zod schema when its type has `safeParse`. Without it, or when
 * the type is unresolved (`any`, e.g. `zod` not installed), the file must import `zod` or the
 * receiver must be named `…Schema`. `JSON.parse` is never a candidate.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {TypeChecker | null} checker
 * @returns {RawItem[]}
 */
export function detect(ts, sf, checker) {
  /** @type {RawItem[]} */
  const items = [];
  const importsZod = fileImportsZod(ts, sf);
  /** @param {Node} n */
  const text = (n) => n.getText(sf).replace(/\s+/g, ' ').trim();

  /** @param {Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const safe = SAFE_METHODS.get(method);
      const receiver = node.expression.expression;
      const receiverText = text(receiver);
      if (safe !== undefined && receiverText !== 'JSON') {
        const syntactic = importsZod || /schema$/i.test(receiverText);
        const type = checker === null ? null : checker.getTypeAtLocation(receiver);
        // An unresolved type (missing dependency) is `any`: fall back to syntax rather than guess.
        const isZod = type === null || (type.flags & ts.TypeFlags.Any) !== 0 ? syntactic : type.getProperty('safeParse') !== undefined;
        items.push(
          rawItem(sf, 'V-ZOD-PARSE', node.expression.name, node, {
            subject: `${clip(receiverText)}.${method}(…)`,
            sig: text(node.expression),
            detail: method,
            suggestion: `${clip(receiverText)}.${safe}(…)`,
            exempt: isZod ? null : 'E-NOT-ZOD',
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return items;
}

/**
 * @param {TS} ts
 * @param {SourceFile} sf
 * @returns {boolean}
 */
function fileImportsZod(ts, sf) {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      (s.moduleSpecifier.text === 'zod' || s.moduleSpecifier.text.startsWith('zod/')),
  );
}
