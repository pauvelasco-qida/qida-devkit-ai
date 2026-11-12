// @ts-check
/**
 * Rule catalogue of the TypeScript-conventions scanner. Changing an entry changes results:
 * bump TOOL_VERSION in find-ts-convention-issues.mjs and the plugin version.
 */

/**
 * @typedef {'blocking' | 'advisory'} Severity
 * @typedef {'VIOLATION' | 'REVIEW'} Preclass
 * @typedef {{ id: string, preclass: Preclass, severity: Severity, adr: string | null }} RuleInfo
 */

/** Reported rules, in report order of precedence. */
export const RULES = /** @type {const} */ ({
  'V-ANY': { preclass: 'VIOLATION', severity: 'blocking', adr: 'ADR-FE-001 §2' },
  'V-CLASS': { preclass: 'VIOLATION', severity: 'blocking', adr: 'ADR-FE-001 §1' },
  'V-ENUM': { preclass: 'VIOLATION', severity: 'blocking', adr: null },
  'V-DEFAULT-EXPORT': { preclass: 'VIOLATION', severity: 'blocking', adr: null },
  'V-INLINE-TYPE-IMPORT': { preclass: 'VIOLATION', severity: 'blocking', adr: null },
  'V-INTERSECTION': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-RETURN-TYPE': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-OPTIONAL-UNDEFINED': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-TYPE-PARAM-PREFIX': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-TYPE-NAMING': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-VALUE-NAMING': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-CONST-NAMING': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'V-FILE-NAME': { preclass: 'VIOLATION', severity: 'advisory', adr: null },
  'REVIEW-DISCRIMINATED-UNION': { preclass: 'REVIEW', severity: 'advisory', adr: null },
  'REVIEW-THROW': { preclass: 'REVIEW', severity: 'advisory', adr: 'ADR-FE-005' },
});

/** @typedef {keyof typeof RULES} RuleId */

export const RULE_IDS = /** @type {RuleId[]} */ (Object.keys(RULES));

/** Line marker that accepts a finding deliberately (same line or the line above). */
export const SUPPRESSION_MARKER = 'ts-conventions-ok';

/**
 * Callees whose result may be bound to a PascalCase name: components, contexts, routes.
 * Matched against the last name of the callee (`React.memo` → `memo`, `styled.div` → `styled`).
 */
export const PASCAL_CASE_FACTORIES = new Set([
  'memo',
  'forwardRef',
  'lazy',
  'createContext',
  'styled',
  'observer',
  'createFileRoute',
  'createLazyFileRoute',
  'createRootRoute',
  'createRootRouteWithContext',
  'createRoute',
  'createLazyRoute',
]);

/** Object properties whose function value is run by a framework that catches what it throws. */
export const FRAMEWORK_THROW_PROPERTIES = new Set([
  'queryFn',
  'mutationFn',
  'loader',
  'beforeLoad',
  'action',
  'clientLoader',
  'clientAction',
]);

/** Callees whose thrown result a router turns into navigation (TanStack Router, React Router). */
export const FRAMEWORK_THROW_CALLEES = new Set(['redirect', 'notFound']);

export const CAMEL_CASE = /^[_$]*[a-z][a-zA-Z0-9]*$/;
export const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
export const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
export const UNDERSCORES = /^_+$/;
export const TYPE_PARAMETER = /^T(?:[A-Z0-9][a-zA-Z0-9]*)?$/;
export const HOOK_NAME = /^use[A-Z0-9]/;

/**
 * Splits an identifier into lower-case words: `maxCount` → max,count; `MAX_COUNT` → max,count;
 * `user-id` → user,id; `HTTPClient` → http,client.
 * @param {string} name
 * @returns {string[]}
 */
function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/**
 * @param {string} name
 * @param {'camelCase' | 'PascalCase' | 'ALL_CAPS'} style
 * @returns {string}
 */
export function toStyle(name, style) {
  const lead = /^[_$]*/.exec(name)?.[0] ?? '';
  const w = words(name.slice(lead.length));
  if (w.length === 0) return name;
  if (style === 'ALL_CAPS') return w.map((x) => x.toUpperCase()).join('_');
  const pascal = w.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('');
  return style === 'PascalCase' ? pascal : lead + pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
