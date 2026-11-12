// @ts-check
import * as R from './rules.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Node} TsNode */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('./config.mjs').MagicStringsConfig} MagicStringsConfig */

/**
 * A string literal occurrence in a source file.
 * @typedef {object} Literal
 * @property {TsNode} node
 * @property {'string' | 'template'} kind
 * @property {string} value Literal value; template substitutions are rendered as `${…}`.
 * @property {number} line 1-based start line.
 * @property {number} endLine 1-based end line.
 * @property {number} column 1-based start column.
 */

/**
 * Outcome of the syntax-only classification of a literal.
 * EXCLUDED and VIOLATION are final; PENDING continues to the cross-file rules.
 * @typedef {object} SyntaxVerdict
 * @property {'EXCLUDED' | 'VIOLATION' | 'PENDING'} verdict
 * @property {string} rule Stable rule id.
 * @property {string | null} adr ADR the rule enforces, if any.
 * @property {string} context Where the literal sits (for PENDING / VIOLATION).
 * @property {string} detail Short human hint about the context.
 */

/**
 * Where a literal ends up after climbing through value-transparent wrappers and data
 * containers (object/array literals).
 * @typedef {object} Anchor
 * @property {TsNode | undefined} anchor First ancestor that is not a wrapper or container.
 * @property {TsNode} child The node through which the anchor was reached.
 * @property {string[]} path Property names crossed, outermost first.
 * @property {boolean} inArray Whether an array literal was crossed.
 */

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
/** Longest detail kept on a work item: far above the printed length (120), so it bounds memory only. */
const MAX_STORED_DETAIL = 400;

/**
 * A detail quoting code, on one line, capped at MAX_STORED_DETAIL at a separator (`capText`), so
 * the cap never leaves a partial token; its printed form is masked, then shortened, at the report
 * boundary (`redactRecords`).
 * @param {string} s
 * @returns {string}
 */
function short(s) {
  return capText(s.replace(/\s+/g, ' ').trim(), MAX_STORED_DETAIL);
}

/**
 * Caps a stored text at `max` characters, cutting only at a separator (space, quote, comma,
 * bracket…): a token, URL or credential is kept whole or dropped whole, never cut to a prefix
 * that masking would no longer recognise.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function capText(s, max) {
  if (s.length <= max) return s;
  // A separator (space, quote, comma, bracket…) within the last quarter of the allowed length.
  // `.`, `/` and `:` are not separators: they occur inside tokens (a JWT, a base64 line, a URL).
  for (let cut = max - 1; cut >= Math.floor(max * 0.75); cut -= 1) {
    if (!/[\s'"`,;()[\]{}<>]/.test(s[cut])) continue;
    const kept = s.slice(0, cut);
    // A cut inside a private key would leave a header with too little body to be recognised (and
    // masked) as a key: cut before the header instead.
    const header = kept.search(R.PRIVATE_KEY_HEADER);
    if (header !== -1 && R.PRIVATE_KEY.test(s) && !R.PRIVATE_KEY.test(kept)) return `${s.slice(0, header)}…`;
    return `${kept}…`;
  }
  // None: mask every token first, so the hard cut cannot leave a partial one.
  const masked = maskOpaqueTokens(secretFormatRanges(s).reduceRight((acc, [from, to]) => `${acc.slice(0, from)}[REDACTED]${acc.slice(to)}`, s));
  return masked.length <= max ? masked : `${masked.slice(0, max - 1)}…`;
}

/**
 * @param {string} rule
 * @param {string} [detail]
 * @returns {SyntaxVerdict}
 */
function excluded(rule, detail = '') {
  return { verdict: 'EXCLUDED', rule, adr: null, context: '', detail };
}

/**
 * Collects every string literal and template literal in a file, in source order.
 * Bare JSX text is not a string literal and is not collected.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @returns {Literal[]}
 */
export function collectLiterals(ts, sf) {
  /** @type {Literal[]} */
  const out = [];
  /**
   * @param {TsNode} node
   * @param {'string' | 'template'} kind
   * @param {string} value
   */
  const add = (node, kind, value) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.end);
    out.push({ node, kind, value, line: start.line + 1, endLine: end.line + 1, column: start.character + 1 });
  };
  /** @param {TsNode} node */
  const visit = (node) => {
    if (ts.isStringLiteral(node)) {
      add(node, 'string', node.text);
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, 'template', node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      add(node, 'template', node.head.text + node.templateSpans.map((s) => R.PLACEHOLDER + s.literal.text).join(''));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Normalised textual form of a callee expression, e.g. `queryClient.invalidateQueries`.
 * @param {TS} ts
 * @param {TsNode} expr
 * @returns {string}
 */
export function calleeText(ts, expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (expr.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (expr.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isMetaProperty(expr)) return `${ts.tokenToString(expr.keywordToken) ?? '?'}.${expr.name.text}`;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeText(ts, expr.expression)}.${expr.name.text}`;
  if (ts.isElementAccessExpression(expr)) return `${calleeText(ts, expr.expression)}[]`;
  if (ts.isCallExpression(expr)) return `${calleeText(ts, expr.expression)}()`;
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return calleeText(ts, expr.expression);
  return '?';
}

/**
 * @param {string} callee
 * @returns {string}
 */
function lastSegment(callee) {
  const i = callee.lastIndexOf('.');
  return i === -1 ? callee : callee.slice(i + 1);
}

/**
 * @param {string} callee
 * @returns {string}
 */
function objectSegment(callee) {
  const parts = callee.split('.');
  return parts.length < 2 ? '' : parts[parts.length - 2];
}

/**
 * @param {TS} ts
 * @param {TsNode} name
 * @returns {string}
 */
function propertyName(ts, name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return '[…]';
}

/**
 * Wrappers that pass a value through unchanged (for the purpose of "where does this literal go").
 * @param {TS} ts
 * @param {TsNode} parent
 * @param {TsNode} child
 * @returns {boolean}
 */
function isTransparent(ts, parent, child) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isNonNullExpression(parent)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition !== child;
  if (ts.isBinaryExpression(parent)) {
    const k = parent.operatorToken.kind;
    return (
      k === ts.SyntaxKind.QuestionQuestionToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.AmpersandAmpersandToken
    );
  }
  return false;
}

/**
 * @param {TS} ts
 * @param {TsNode} node
 * @returns {Anchor}
 */
export function anchorOf(ts, node) {
  /** @type {string[]} */
  const path = [];
  let inArray = false;
  let child = node;
  let parent = node.parent;
  while (parent !== undefined) {
    if (
      isTransparent(ts, parent, child) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent)
    ) {
      // keep climbing: a literal inside `${…}` goes wherever its template goes
    } else if (ts.isArrayLiteralExpression(parent)) {
      inArray = true;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
      path.push(propertyName(ts, parent.name));
    } else {
      break;
    }
    child = parent;
    parent = parent.parent;
  }
  return { anchor: parent, child, path: path.reverse(), inArray };
}

/**
 * @param {TS} ts
 * @param {TsNode} node
 * @returns {boolean}
 */
function isModuleSpecifier(ts, node) {
  const p = node.parent;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isModuleDeclaration(p) && p.name === node) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if (p.kind === ts.SyntaxKind.ImportAttribute) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (R.MODULE_FUNCTIONS.has(calleeText(ts, p.expression))) return true;
  }
  return false;
}

/**
 * @param {TS} ts
 * @param {TsNode} node
 * @returns {boolean}
 */
function isPropertyNamePosition(ts, node) {
  const p = node.parent;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === node
  ) {
    return true;
  }
  if (ts.isComputedPropertyName(p)) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  return false;
}

/**
 * @param {TS} ts
 * @param {TsNode} expr
 * @returns {TsNode}
 */
function unwrap(ts, expr) {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * If the literal is part of a named definition, returns the access path to it
 * (e.g. `ROUTES.users`, `Status.Active`, `userKeys.detail()`), otherwise null.
 *
 * A literal is a definition when it is reachable from a declaration initializer only through
 * data containers (object/array literals, `as`/`satisfies`, parentheses), call arguments and
 * expression-bodied arrow functions, and the declaration is one of:
 *  - an `enum` member;
 *  - a `static readonly` class property;
 *  - a `const` named in UPPER_SNAKE_CASE (any scope; not through arrow functions);
 *  - a module-scope `const`. Through an arrow function only when the const is an object/array
 *    dictionary (key factories such as `userKeys.detail()`); through a call only when the const is
 *    at module scope (a configured singleton).
 * Block-bodied functions always stop the search: code inside them is usage, not definition.
 * @param {TS} ts
 * @param {TsNode} node
 * @returns {{ name: string } | null}
 */
export function definitionOf(ts, node) {
  const parent = node.parent;
  if (ts.isEnumMember(parent) && parent.initializer === node) {
    return { name: `${parent.parent.name.text}.${propertyName(ts, parent.name)}` };
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = calleeText(ts, parent.expression);
    if (callee === 'Symbol' || callee === 'Symbol.for') return { name: `${callee}()` };
  }

  /** @type {string[]} */
  const segments = [];
  let crossedFunction = false;
  let crossedCall = false;
  let child = node;
  let p = node.parent;
  while (p !== undefined) {
    if (
      isTransparent(ts, p, child) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p)
    ) {
      // container
    } else if (ts.isArrayLiteralExpression(p)) {
      const info = arrayInfo(ts, p);
      if (!info.hasSpread) segments.push(`[${info.index.get(child) ?? -1}]`);
    } else if (ts.isPropertyAssignment(p) && p.initializer === child) {
      segments.push(`.${propertyName(ts, p.name)}`);
    } else if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.arguments ?? []).some((a) => a === child)) {
      crossedCall = true;
    } else if (ts.isArrowFunction(p) && p.body === child) {
      crossedFunction = true;
      segments.push('()');
    } else if (ts.isPropertyDeclaration(p) && p.initializer === child) {
      const mods = ts.getCombinedModifierFlags(p);
      const isStaticReadonly = (mods & ts.ModifierFlags.Static) !== 0 && (mods & ts.ModifierFlags.Readonly) !== 0;
      const cls = p.parent;
      if (!isStaticReadonly || crossedFunction || !ts.isClassDeclaration(cls) || cls.name === undefined) return null;
      return { name: `${cls.name.text}.${propertyName(ts, p.name)}${segments.reverse().join('')}` };
    } else if (ts.isVariableDeclaration(p) && p.initializer === child) {
      const list = p.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
      if (!ts.isIdentifier(p.name)) return null;
      const name = p.name.text;
      const root = unwrap(ts, p.initializer);
      const isDictionary = ts.isObjectLiteralExpression(root) || ts.isArrayLiteralExpression(root);
      const isModuleScope = ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent);
      const access = `${name}${segments.reverse().join('')}`;
      if (crossedFunction) return isModuleScope && isDictionary ? { name: access } : null;
      if (crossedCall) return isModuleScope || UPPER_SNAKE.test(name) ? { name: access } : null;
      return isModuleScope || UPPER_SNAKE.test(name) ? { name: access } : null;
    } else {
      return null;
    }
    child = p;
    p = p.parent;
  }
  return null;
}

/**
 * @param {TS} ts
 * @param {Anchor} a
 * @param {SourceFile} sf
 * @returns {{ attr: string, element: string, intrinsic: boolean } | null}
 */
function jsxAttributeOf(ts, a, sf) {
  let attrNode = a.anchor;
  if (attrNode !== undefined && ts.isJsxExpression(attrNode)) attrNode = attrNode.parent;
  if (attrNode === undefined || !ts.isJsxAttribute(attrNode)) return null;
  const opening = attrNode.parent.parent;
  const element = ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName.getText(sf) : '?';
  return { attr: attrNode.name.getText(sf), element, intrinsic: /^[a-z][a-z0-9-]*$/.test(element) };
}

/**
 * @param {TS} ts
 * @param {Anchor} a
 * @returns {boolean}
 */
function isJsxChild(ts, a) {
  const n = a.anchor;
  return n !== undefined && ts.isJsxExpression(n) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent));
}

/**
 * @param {TS} ts
 * @param {import('typescript').SyntaxKind} kind
 * @returns {boolean}
 */
function isEquality(ts, kind) {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

/**
 * @param {string} callee
 * @param {MagicStringsConfig} cfg
 * @returns {boolean}
 */
function isI18nCallee(callee, cfg) {
  const last = lastSegment(callee);
  if (/^t[A-Z][A-Za-z0-9]*$/.test(callee)) return true; // aliased t, e.g. `const { t: tCatalog } = useTranslation()`
  return R.I18N_FUNCTIONS.has(last) || cfg.i18nFunctions.includes(callee) || cfg.i18nFunctions.includes(last);
}

/**
 * @param {string} callee
 * @param {MagicStringsConfig} cfg
 * @returns {boolean}
 */
function isLogCallee(callee, cfg) {
  if (callee.startsWith('console.')) return true;
  if (R.LOG_FUNCTIONS.has(callee) || cfg.logFunctions.includes(callee)) return true;
  const obj = objectSegment(callee);
  return R.LOG_OBJECTS.has(obj) && R.LOG_METHODS.has(lastSegment(callee));
}

/**
 * Whether the node sits inside a class that extends `…Error` / `…Exception`.
 * @param {TS} ts
 * @param {TsNode} node
 * @returns {boolean}
 */
function insideErrorClass(ts, node) {
  let cur = node.parent;
  while (cur !== undefined && !ts.isClassDeclaration(cur) && !ts.isClassExpression(cur)) cur = cur.parent;
  if (cur === undefined) return false;
  for (const clause of cur.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of clause.types) {
      if (/(?:Error|Exception)$/.test(lastSegment(calleeText(ts, t.expression)))) return true;
    }
  }
  return false;
}

/**
 * Syntax-only classification. Rules are evaluated in a fixed order; the first match wins.
 * @param {TS} ts
 * @param {Literal} lit
 * @param {SourceFile} sf
 * @param {MagicStringsConfig} cfg
 * @returns {SyntaxVerdict}
 */
export function classifySyntax(ts, lit, sf, cfg) {
  const node = lit.node;
  const parent = node.parent;

  if (ts.isLiteralTypeNode(parent)) return excluded('E-TYPE-POSITION');
  if (isModuleSpecifier(ts, node)) return excluded('E-MODULE');
  if (ts.isExpressionStatement(parent) && /^use [a-z]+$/.test(lit.value)) return excluded('E-DIRECTIVE');
  if (isPropertyNamePosition(ts, node)) return excluded('E-PROPERTY-NAME');
  if (ts.isTaggedTemplateExpression(parent) && parent.template === node) return excluded('E-TAGGED-TEMPLATE');

  const def = definitionOf(ts, node);
  if (def !== null) return excluded('E-DEFINITION', def.name);

  const a = anchorOf(ts, node);
  const anchor = a.anchor;
  const jsx = jsxAttributeOf(ts, a, sf);
  const jsxChild = isJsxChild(ts, a);

  /** @type {{ callee: string, argIndex: number } | null} */
  let call = null;
  if (anchor !== undefined && (ts.isCallExpression(anchor) || ts.isNewExpression(anchor))) {
    const args = anchor.arguments ?? [];
    call = { callee: calleeText(ts, anchor.expression), argIndex: args.findIndex((x) => x === a.child) };
  }

  // Exclusions that depend on where the literal goes.
  if (call !== null) {
    const last = lastSegment(call.callee);
    if (R.STYLING_FUNCTIONS.has(last)) return excluded('E-STYLING', `${call.callee}()`);
    if (R.ROUTE_DEFINITION_FUNCTIONS.has(last)) return excluded('E-ROUTE-DEFINITION', `${call.callee}()`);
    if (isI18nCallee(call.callee, cfg)) return excluded('E-I18N', `${call.callee}()`);
    if (isLogCallee(call.callee, cfg)) return excluded('E-LOG', `${call.callee}()`);
    if (/(?:Error|Exception)$/.test(last)) return excluded('E-DEV-MESSAGE', `${call.callee}()`);
    if (call.callee === 'super' && insideErrorClass(ts, node)) return excluded('E-DEV-MESSAGE', 'super()');
    if (R.ASSERT_FUNCTIONS.has(last) && call.argIndex >= 1) return excluded('E-DEV-MESSAGE', `${call.callee}()`);
    if (
      (last === 'addEventListener' || last === 'removeEventListener') &&
      call.argIndex === 0 &&
      R.DOM_EVENTS.has(lit.value)
    ) {
      return excluded('E-STANDARD-VALUE', `${call.callee}()`);
    }
  }
  if (jsx !== null) {
    if (R.STYLING_ATTRIBUTES.has(jsx.attr)) return excluded('E-STYLING', jsx.attr);
    if (R.I18N_ATTRIBUTES.has(jsx.attr)) return excluded('E-I18N', jsx.attr);
    if (jsx.element === R.ROUTE_ELEMENT && jsx.attr === 'path') return excluded('E-ROUTE-DEFINITION', '<Route path>');
    const uiText = R.UI_TEXT_ATTRIBUTES.has(jsx.attr) || cfg.uiTextAttributes.includes(jsx.attr);
    if (!uiText && (R.MARKUP_ATTRIBUTES.has(jsx.attr) || jsx.attr.startsWith('data-') || jsx.attr.startsWith('aria-'))) {
      return excluded('E-MARKUP-ATTRIBUTE', jsx.attr);
    }
  }
  if (anchor !== undefined && ts.isBinaryExpression(anchor)) {
    const k = anchor.operatorToken.kind;
    if (isEquality(ts, k)) {
      const other = anchor.left === a.child ? anchor.right : anchor.left;
      if (ts.isTypeOfExpression(unwrap(ts, other))) return excluded('E-STANDARD-VALUE', 'typeof');
    }
    if (k === ts.SyntaxKind.InKeyword && anchor.left === a.child) return excluded('E-PROPERTY-NAME', 'in');
    if (
      k === ts.SyntaxKind.EqualsToken &&
      anchor.right === a.child &&
      calleeText(ts, anchor.left) === 'this.name' &&
      insideErrorClass(ts, node)
    ) {
      return excluded('E-DEV-MESSAGE', 'this.name =');
    }
  }

  // Deterministic violations.
  const queryKeyByProperty = a.path.includes(R.QUERY_KEY_PROPERTY);
  const queryKeyByArgument =
    call !== null &&
    call.argIndex === 0 &&
    a.inArray &&
    a.path.length === 0 &&
    R.QUERY_KEY_ARGUMENT_METHODS.has(lastSegment(call.callee));
  if (queryKeyByProperty || queryKeyByArgument) {
    return {
      verdict: 'VIOLATION',
      rule: 'V-FE002-INLINE-QUERY-KEY',
      adr: 'ADR-FE-002',
      context: 'query-key',
      detail: call !== null ? `${call.callee}()` : 'queryKey',
    };
  }

  if (jsx !== null && a.path.length === 0 && (R.UI_TEXT_ATTRIBUTES.has(jsx.attr) || cfg.uiTextAttributes.includes(jsx.attr))) {
    return uiText(`<${jsx.element} ${jsx.attr}>`);
  }
  if (jsxChild) return uiText('JSX child');
  if (call !== null && (R.UI_TEXT_FUNCTIONS.has(call.callee) || cfg.uiTextFunctions.includes(call.callee))) {
    const direct = call.argIndex === 0 && a.path.length === 0;
    const option = call.argIndex >= 0 && a.path.length === 1 && R.UI_TEXT_OPTION_KEYS.has(a.path[0]);
    if (direct || option) return uiText(`${call.callee}()`);
  }
  if (
    anchor !== undefined &&
    ts.isBinaryExpression(anchor) &&
    anchor.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    anchor.right === a.child &&
    calleeText(ts, anchor.left) === 'document.title'
  ) {
    return uiText('document.title =');
  }

  if (R.STANDARD_VALUES.has(lit.value)) return excluded('E-STANDARD-VALUE');

  const { context, detail } = describe(ts, a, jsx, call, sf);
  return { verdict: 'PENDING', rule: 'REVIEW', adr: null, context, detail };
}

/**
 * @param {string} detail
 * @returns {SyntaxVerdict}
 */
function uiText(detail) {
  return { verdict: 'VIOLATION', rule: 'V-FE004-UI-TEXT', adr: 'ADR-FE-004', context: 'ui-text', detail };
}

/**
 * Human-readable context for literals that need judgement.
 * @param {TS} ts
 * @param {Anchor} a
 * @param {{ attr: string, element: string } | null} jsx
 * @param {{ callee: string, argIndex: number } | null} call
 * @param {SourceFile} sf
 * @returns {{ context: string, detail: string }}
 */
function describe(ts, a, jsx, call, sf) {
  const n = a.anchor;
  const via = a.path.length > 0 ? ` → ${a.path.join('.')}` : '';
  if (jsx !== null) return { context: 'jsx-attribute', detail: short(`<${jsx.element} ${jsx.attr}>${via}`) };
  if (call !== null) return { context: 'call-argument', detail: short(`${call.callee}() arg ${call.argIndex + 1}${via}`) };
  if (n === undefined) return { context: 'other', detail: '' };
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    const op = ts.tokenToString(k) ?? '?';
    if (isEquality(ts, k)) {
      const other = n.left === a.child ? n.right : n.left;
      return { context: 'comparison', detail: short(`${op} ${other.getText(sf)}`) };
    }
    if (k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken || k === ts.SyntaxKind.BarBarEqualsToken) {
      return { context: 'assignment', detail: short(`${n.left.getText(sf)} ${op}${via}`) };
    }
    if (k === ts.SyntaxKind.PlusToken) return { context: 'concatenation', detail: '' };
    return { context: 'binary-operand', detail: op };
  }
  if (ts.isCaseClause(n)) return { context: 'switch-case', detail: short(`switch (${n.parent.parent.expression.getText(sf)})`) };
  if (ts.isElementAccessExpression(n)) return { context: 'element-access', detail: short(`${n.expression.getText(sf)}[…]`) };
  if (ts.isVariableDeclaration(n)) return { context: 'variable', detail: short(`${n.name.getText(sf)}${via}`) };
  if (ts.isPropertyDeclaration(n)) return { context: 'class-field', detail: short(`${n.name.getText(sf)}${via}`) };
  if (ts.isReturnStatement(n) || ts.isArrowFunction(n)) return { context: 'return-value', detail: short(via) };
  if (ts.isParameter(n) || ts.isBindingElement(n)) return { context: 'default-value', detail: short(n.name.getText(sf)) };
  if (ts.isTemplateSpan(n)) return { context: 'template-substitution', detail: '' };
  if (ts.isPropertyAccessExpression(n)) return { context: 'member-access', detail: short(`.${n.name.text}`) };
  if (ts.isJsxExpression(n)) return { context: 'jsx-expression', detail: '' };
  return { context: 'other', detail: ts.SyntaxKind[n.kind] };
}

/** Per array literal: whether it has a spread, and each element's index (computed once). */
/** @type {WeakMap<import('typescript').ArrayLiteralExpression, { hasSpread: boolean, index: Map<import('typescript').Node, number> }>} */
const ARRAYS = new WeakMap();

/**
 * @param {TS} ts
 * @param {import('typescript').ArrayLiteralExpression} arr
 * @returns {{ hasSpread: boolean, index: Map<import('typescript').Node, number> }}
 */
function arrayInfo(ts, arr) {
  const hit = ARRAYS.get(arr);
  if (hit !== undefined) return hit;
  const info = { hasSpread: arr.elements.some((e) => ts.isSpreadElement(e)), index: new Map(arr.elements.map((e, i) => [/** @type {import('typescript').Node} */ (e), i])) };
  ARRAYS.set(arr, info);
  return info;
}

/**
 * Named definitions (see `definitionOf`) in a file, by literal value.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @returns {Map<string, { name: string, line: number }[]>}
 */
export function collectDefinitions(ts, sf) {
  /** @type {Map<string, { name: string, line: number }[]>} */
  const defs = new Map();
  for (const lit of collectLiterals(ts, sf)) {
    if (lit.kind === 'template' && lit.value.includes(R.PLACEHOLDER)) continue;
    const def = definitionOf(ts, lit.node);
    if (def === null) continue;
    const list = defs.get(lit.value) ?? [];
    list.push({ name: def.name, line: lit.line });
    defs.set(lit.value, list);
  }
  return defs;
}

/**
 * Shape of a value, used for the URL/path rule and as a hint for the reviewer.
 * @param {string} value
 * @returns {'url' | 'path' | 'text' | 'identifier' | 'other'}
 */
export function shapeOf(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:mailto|tel):/i.test(value)) return 'url';
  if (/^\/[^\s]+$/.test(value)) return 'path';
  if (/\s/.test(value.trim())) return 'text';
  if (/^[A-Za-z_$][\w$.:/-]*$/.test(value)) return 'identifier';
  return 'other';
}

/**
 * @param {string} value
 * @returns {number}
 */
function entropy(value) {
  /** @type {Map<string, number>} */
  const freq = new Map();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * SECRET_PATTERNS compiled once with the `g` flag, for `matchAll`. `matchAll` clones the regex but
 * copies its `lastIndex` into the clone (ECMAScript RegExp.prototype[@@matchAll], step 7), so a
 * shared global regex must be reset before each use: without it, a second call starts mid-text.
 */
const SECRET_PATTERNS_G = R.SECRET_PATTERNS.map((re) => new RegExp(re.source, `${re.flags.replace('g', '')}g`));

/**
 * Every substring of a text that matches a known credential format (AWS key, private key, JWT,
 * GitHub/Slack/Stripe/OpenAI/Google token…).
 * @param {string} text
 * @returns {string[]}
 */
export function secretFormatMatches(text) {
  return secretFormatRanges(text).map(([from, to]) => text.slice(from, to));
}

/**
 * Character ranges of a text's known-format credentials, `[from, to)`, sorted, with overlapping or
 * nested matches merged (a token inside a webhook URL): masking them never leaves part of one.
 * @param {string} text
 * @returns {[number, number][]}
 */
export function secretFormatRanges(text) {
  /** @type {[number, number][]} */
  const all = [];
  for (const re of SECRET_PATTERNS_G) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) all.push([m.index, m.index + m[0].length]);
  }
  all.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * How a value looks like a secret: `format` (a known credential format, never acceptable inline),
 * `heuristic` (an opaque high-entropy token anywhere in it, or a bare private-key header such as
 * the first piece of a key split across literals; the marker may accept it), or null.
 * @param {string} value
 * @returns {'format' | 'heuristic' | null}
 */
export function secretKind(value) {
  return secretInfo(value).kind;
}

/**
 * `secretKind` with the known-format matches it found, for callers that need both.
 * @param {string} value
 * @returns {{ kind: 'format' | 'heuristic' | null, matches: string[] }}
 */
export function secretInfo(value) {
  const matches = secretFormatMatches(value);
  if (matches.length > 0) return { kind: 'format', matches };
  if (R.PRIVATE_KEY_HEADER.test(value)) return { kind: 'heuristic', matches };
  return { kind: maskOpaqueTokens(value) === value ? null : 'heuristic', matches };
}

/** Splits a text around its structured data (data URIs, SRI hashes). */
const STRUCTURED_SPLIT = new RegExp(`(${R.STRUCTURED_DATA.source})`);

/**
 * A plain path segment: a lowercase word, possibly with digits or `-`/`_` (`assets`, `v1`,
 * `user-avatars`), or a capitalised word (`Images`). Random base64 is mixed case.
 * @param {string} piece
 * @returns {boolean}
 */
function isPathWord(piece) {
  return piece.length <= 32 && (/^[a-z0-9][a-z0-9_-]*$/.test(piece) || /^[A-Z][a-z0-9_-]*$/.test(piece));
}

/**
 * A text with every opaque secret token replaced by `[REDACTED]`. The single token scan behind
 * both `secretKind` and redaction, so what is masked is exactly what is reported. Data URIs and
 * SRI hashes are content and stay. A run is judged piece by piece between `/` first (a token in
 * a URL or path keeps its context), then whole (a base64 key body line, `/` included).
 * @param {string} text
 * @returns {string}
 */
export function maskOpaqueTokens(text) {
  // Odd parts are structured data, wherever it starts (`integrity=sha384-…`): kept as is.
  return text
    .split(STRUCTURED_SPLIT)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/[A-Za-z0-9+/=_-]{32,}/g, (run) => {
            // Piece by piece between `/` first. Once a piece is secret, the other pieces decide:
            // when each is a plain path word (`assets`, `v1`, `img`), the run is a URL or path and
            // keeps them; when any is not (`Zk8QwErTyUiOpAsDfGh2`), the run is one base64 key and
            // is masked whole, so no fragment of it survives.
            const pieces = run.replace(/[A-Za-z0-9+=_-]{32,}/g, (t) => (isOpaqueSecret(t) ? '[REDACTED]' : t));
            if (pieces !== run) {
              const others = pieces.split('/').filter((p) => p !== '[REDACTED]' && p !== '');
              return others.every(isPathWord) ? pieces : '[REDACTED]';
            }
            return isOpaqueSecret(run) ? '[REDACTED]' : run;
          }),
    )
    .join('');
}

/**
 * Whether a token looks like an opaque credential: 32+ base64/base62-like characters, mixed case
 * with a digit, high entropy, and not an identifier. An identifier (`useGetUserProfileByIdQueryV2Options`)
 * is mostly made of words; a random token almost never is.
 * @param {string} token
 * @returns {boolean}
 */
export function isOpaqueSecret(token) {
  // A token, or a base64 line (`/` allowed, 40+ characters, as in a PEM body).
  if (!/^[A-Za-z0-9+=_-]{32,}$/.test(token) && !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  const wordChars = (token.match(/[A-Z]?[a-z]{3,}/g) ?? []).reduce((n, w) => n + w.length, 0);
  if (wordChars / token.length >= 0.6) return false;
  // With `/`: a key body line, never a route or path. Those start with `/`, have empty segments,
  // or are largely made of words (`/api/v2/Users/AbcDef12/Orders`); random base64 is not.
  if (token.includes('/') && (token.startsWith('/') || token.includes('//') || wordChars / token.length >= 0.3)) return false;
  return entropy(token) >= 4.2;
}

/**
 * Static text length of a value, ignoring `${…}` placeholders and whitespace.
 * @param {string} value
 * @returns {number}
 */
export function staticLength(value) {
  return value.split(R.PLACEHOLDER).join('').replace(/\s/g, '').length;
}

/**
 * Span where the compiler reports an error caused by changing this literal: the JSX attribute,
 * call, comparison, case clause, declaration or return it flows into; otherwise its statement.
 * @param {TS} ts
 * @param {TsNode} node
 * @param {SourceFile} sf
 * @returns {[number, number]}
 */
export function probeRegion(ts, node, sf) {
  const a = anchorOf(ts, node);
  let n = a.anchor;
  if (n !== undefined && ts.isJsxExpression(n) && ts.isJsxAttribute(n.parent)) n = n.parent;
  if (n !== undefined && ts.isArrowFunction(n)) return [a.child.getStart(sf), a.child.end];
  if (
    n !== undefined &&
    (ts.isJsxAttribute(n) ||
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isBinaryExpression(n) ||
      ts.isCaseClause(n) ||
      ts.isVariableDeclaration(n) ||
      ts.isReturnStatement(n) ||
      ts.isParameter(n) ||
      ts.isBindingElement(n) ||
      ts.isElementAccessExpression(n) ||
      ts.isPropertyDeclaration(n))
  ) {
    return [n.getStart(sf), n.end];
  }
  return enclosingStatementSpan(ts, node, sf);
}

/**
 * Source span ([start, end) offsets) of the statement or class member that encloses a node.
 * New compiler errors inside it are attributed to a change in the literal.
 * @param {TS} ts
 * @param {TsNode} node
 * @param {SourceFile} sf
 * @returns {[number, number]}
 */
export function enclosingStatementSpan(ts, node, sf) {
  let cur = node;
  while (cur.parent !== undefined) {
    const p = cur.parent;
    if (
      ts.isSourceFile(p) ||
      ts.isBlock(p) ||
      ts.isModuleBlock(p) ||
      ts.isCaseClause(p) ||
      ts.isDefaultClause(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p)
    ) {
      if (!(ts.isCaseClause(p) && p.expression === cur)) break;
    }
    cur = p;
  }
  return [cur.getStart(sf), cur.end];
}
