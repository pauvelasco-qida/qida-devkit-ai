// @ts-check
import {
  CAMEL_CASE,
  FRAMEWORK_THROW_CALLEES,
  FRAMEWORK_THROW_PROPERTIES,
  HOOK_NAME,
  PASCAL_CASE,
  TYPE_PARAMETER,
  UNDERSCORES,
  UPPER_SNAKE,
  toStyle,
} from './ts-rules.mjs';
import { rawItem } from './ts-scan.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Node} Node */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('typescript').TypeChecker} TypeChecker */
/** @typedef {import('./ts-rules.mjs').RuleId} RuleId */

/** @typedef {import('./ts-scan.mjs').ScanItem<RuleId>} RawItem */

/**
 * @typedef {object} DetectContext
 * @property {boolean} isTsx
 * @property {boolean} defaultExportAllowed The file matches `defaultExportPaths`.
 * @property {ReadonlySet<string>} pascalCaseFactories
 */

/** @type {Readonly<Record<string, string>>} */
const DEFAULT_DECLARATION_KIND = { FunctionDeclaration: 'function', ClassDeclaration: 'class', InterfaceDeclaration: 'interface' };

/**
 * Finds every potential convention breach in a file. Pure: depends only on the source text,
 * the context and (when given) the type checker.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {DetectContext} ctx
 * @param {TypeChecker | null} checker
 * @returns {RawItem[]}
 */
export function detect(ts, sf, ctx, checker) {
  /** @type {RawItem[]} */
  const items = [];

  /** @param {number} pos */
  const lc = (pos) => sf.getLineAndCharacterOfPosition(pos);
  /** @param {Node} n */
  const text = (n) => n.getText(sf).replace(/\s+/g, ' ').trim();

  /**
   * @param {RuleId} rule
   * @param {Node} anchor
   * @param {Node} span
   * @param {{ subject: string, sig: string, detail?: string, expected?: string | null, suggestion?: string | null, exempt?: string | null }} data
   */
  const add = (rule, anchor, span, data) => {
    items.push(rawItem(sf, rule, anchor, span, data));
  };

  /**
   * @param {string} name
   * @param {Node} fn
   * @returns {boolean}
   */
  const isComponent = (name, fn) => PASCAL_CASE.test(name) && (ctx.isTsx || containsJsx(ts, fn));

  /**
   * Whether a PascalCase name is legitimate for this initializer: a component or a known factory.
   * @param {string} name
   * @param {Node | undefined} init
   * @returns {boolean}
   */
  const pascalAllowed = (name, init) => {
    const e = init === undefined ? undefined : unwrapExpression(ts, init);
    if (e === undefined) return false;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return isComponent(name, e);
    return factoryNames(ts, e).some((n) => ctx.pascalCaseFactories.has(n));
  };

  /**
   * @param {RuleId} rule
   * @param {import('typescript').Identifier} id
   * @param {string} kind
   * @param {'camelCase' | 'PascalCase' | 'ALL_CAPS'} expected
   */
  const naming = (rule, id, kind, expected) => {
    add(rule, id, id, {
      subject: id.text,
      sig: `${kind}|${id.text}`,
      detail: kind,
      expected,
      suggestion: toStyle(id.text, expected),
    });
  };

  /** @param {Node} node */
  const visit = (node) => {
    // V-ANY
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const fnName = ts.isFunctionLike(parent) && parent.type === node ? functionName(ts, parent) : null;
      add('V-ANY', node, node, {
        subject: fnName !== null ? `return type of ${fnName}` : text(parent),
        sig: text(parent),
        detail: fnName !== null ? 'return type' : anyContext(ts, parent),
      });
    }

    // V-ENUM, V-TYPE-NAMING (enum)
    if (ts.isEnumDeclaration(node)) {
      add('V-ENUM', node.name, node.name, { subject: node.name.text, sig: text(node) });
      if (!PASCAL_CASE.test(node.name.text)) naming('V-TYPE-NAMING', node.name, 'enum', 'PascalCase');
    }

    // V-CLASS, V-TYPE-NAMING (class)
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const anchor = node.name ?? node;
      const heritage = (node.heritageClauses ?? [])
        .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap((h) => h.types.map((t) => t.expression.getText(sf)));
      const name = node.name?.text ?? '(anonymous)';
      add('V-CLASS', anchor, anchor, {
        subject: name,
        sig: `${name}|${heritage.join(',')}`,
        detail: heritage.length > 0 ? `extends ${heritage.join(', ')}` : '',
        exempt: hasModifier(ts, node, ts.SyntaxKind.DeclareKeyword)
          ? 'E-AMBIENT'
          : heritage.some((h) => /(?:Error|Exception)$/.test(h))
            ? 'E-ERROR-CLASS'
            : null,
      });
      if (node.name !== undefined && !PASCAL_CASE.test(node.name.text)) naming('V-TYPE-NAMING', node.name, 'class', 'PascalCase');
    }

    // V-DEFAULT-EXPORT
    if (ts.isExportAssignment(node)) {
      add('V-DEFAULT-EXPORT', node, node, {
        subject: text(node),
        sig: text(node),
        detail: node.isExportEquals === true ? 'export =' : 'export default',
        exempt: ctx.defaultExportAllowed ? 'E-FRAMEWORK-DEFAULT-EXPORT' : null,
      });
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      hasModifier(ts, node, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword)
    ) {
      const name = node.name?.text ?? '(anonymous)';
      add('V-DEFAULT-EXPORT', node, node.name ?? node, {
        subject: `export default ${DEFAULT_DECLARATION_KIND[ts.SyntaxKind[node.kind]] ?? 'declaration'} ${name}`,
        sig: `${node.kind}|${name}`,
        detail: 'export default',
        exempt: ctx.defaultExportAllowed ? 'E-FRAMEWORK-DEFAULT-EXPORT' : null,
      });
    } else if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        if (el.name.text !== 'default') continue;
        add('V-DEFAULT-EXPORT', el, node, {
          subject: text(node),
          sig: text(node),
          detail: 'export { … as default }',
          exempt: ctx.defaultExportAllowed ? 'E-FRAMEWORK-DEFAULT-EXPORT' : null,
        });
      }
    }

    // V-INLINE-TYPE-IMPORT
    if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly &&
      node.importClause.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      const elements = node.importClause.namedBindings.elements;
      const typed = elements.filter((e) => e.isTypeOnly);
      const first = typed[0];
      if (first !== undefined) {
        const allType = typed.length === elements.length && node.importClause.name === undefined;
        add('V-INLINE-TYPE-IMPORT', first, node, {
          subject: typed.map((e) => e.name.text).join(', '),
          sig: text(node),
          detail: allType ? 'all-type' : 'mixed',
        });
      }
    }

    // V-INTERSECTION
    if (ts.isTypeAliasDeclaration(node)) {
      const t = unwrapType(ts, node.type);
      if (ts.isIntersectionTypeNode(t)) {
        const params = new Set((node.typeParameters ?? []).map((p) => p.name.text));
        const extendable = t.types.every((op) => isExtendable(ts, unwrapType(ts, op), params, checker));
        add('V-INTERSECTION', node.name, node, {
          subject: node.name.text,
          sig: text(node),
          detail: t.types.map((op) => text(op)).join(' & '),
          exempt: extendable ? null : 'E-NOT-EXTENDABLE',
        });
      }
    }

    // V-RETURN-TYPE
    if (node.parent !== undefined && ts.isSourceFile(node.parent)) {
      for (const fn of topLevelFunctions(ts, node)) {
        if (fn.node.type !== undefined || fn.node.body === undefined) continue;
        const bodyStart = fn.node.body;
        const exempt = HOOK_NAME.test(fn.name) ? 'E-HOOK' : isComponent(fn.name, fn.node) ? 'E-COMPONENT' : null;
        add('V-RETURN-TYPE', fn.anchor, fn.node, {
          subject: fn.name,
          sig: `${fn.name}|${fn.node.parameters.map((p) => text(p)).join(',')}`,
          exempt,
        });
        // Only the signature counts as "introduced": a changed body does not ask for a return type.
        const last = items[items.length - 1];
        if (last !== undefined) last.endLine = Math.max(last.startLine, lc(bodyStart.getStart(sf)).line + 1);
      }
    }

    // V-OPTIONAL-UNDEFINED
    if (ts.isPropertySignature(node) && node.questionToken === undefined && node.type !== undefined) {
      const t = unwrapType(ts, node.type);
      if (ts.isUnionTypeNode(t) && t.types.some((m) => m.kind === ts.SyntaxKind.UndefinedKeyword)) {
        const rest = t.types.filter((m) => m.kind !== ts.SyntaxKind.UndefinedKeyword).map((m) => text(m));
        const name = node.name.getText(sf);
        add('V-OPTIONAL-UNDEFINED', node.name, node, {
          subject: name,
          sig: text(node),
          suggestion: `${name}?: ${rest.join(' | ')}`,
        });
      }
    }

    // V-TYPE-PARAM-PREFIX
    if (
      ts.isTypeParameterDeclaration(node) &&
      !ts.isMappedTypeNode(node.parent) &&
      !ts.isInferTypeNode(node.parent) &&
      !TYPE_PARAMETER.test(node.name.text)
    ) {
      const owner = 'name' in node.parent && node.parent.name !== undefined ? /** @type {Node} */ (node.parent.name).getText(sf) : '';
      add('V-TYPE-PARAM-PREFIX', node.name, node.name, {
        subject: node.name.text,
        sig: `${owner}|${node.name.text}`,
        detail: owner,
      });
    }

    // V-TYPE-NAMING (interface, type alias)
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && !PASCAL_CASE.test(node.name.text)) {
      naming('V-TYPE-NAMING', node.name, ts.isInterfaceDeclaration(node) ? 'interface' : 'type', 'PascalCase');
    }

    // V-CONST-NAMING, V-VALUE-NAMING
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      const moduleScope =
        ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent);
      const name = node.name.text;
      if (moduleScope && isConst && node.initializer !== undefined && isLiteralConstant(ts, node.initializer)) {
        if (!UPPER_SNAKE.test(name)) naming('V-CONST-NAMING', node.name, 'constant', 'ALL_CAPS');
      } else if (!valueNameOk(name, isConst, () => pascalAllowed(name, node.initializer))) {
        naming('V-VALUE-NAMING', node.name, 'variable', 'camelCase');
      }
    }
    if (ts.isBindingElement(node) && node.propertyName !== undefined && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const list = findAncestor(ts, node, ts.isVariableDeclarationList);
      const isConst = list !== undefined && (list.flags & ts.NodeFlags.Const) !== 0;
      // A renamed binding may be PascalCase to render it as a component: `{ icon: Icon }`.
      if (!valueNameOk(name, isConst, () => true)) naming('V-VALUE-NAMING', node.name, 'variable', 'camelCase');
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.text;
      if (!(CAMEL_CASE.test(name) || UNDERSCORES.test(name) || isComponent(name, node))) {
        naming('V-VALUE-NAMING', node.name, 'function', 'camelCase');
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text !== 'this') {
      const name = node.name.text;
      if (!(CAMEL_CASE.test(name) || UNDERSCORES.test(name) || (PASCAL_CASE.test(name) && !UPPER_SNAKE.test(name)))) {
        naming('V-VALUE-NAMING', node.name, 'parameter', 'camelCase');
      }
    }

    // REVIEW-DISCRIMINATED-UNION
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const members = ts.isInterfaceDeclaration(node)
        ? node.members
        : ts.isTypeLiteralNode(unwrapType(ts, node.type))
          ? /** @type {import('typescript').TypeLiteralNode} */ (unwrapType(ts, node.type)).members
          : undefined;
      if (members !== undefined) {
        const props = members.filter(ts.isPropertySignature);
        const discriminants = props.filter(
          (p) => p.questionToken === undefined && p.type !== undefined && isLiteralUnion(ts, unwrapType(ts, p.type)),
        );
        const optionals = props.filter((p) => p.questionToken !== undefined);
        if (discriminants.length > 0 && optionals.length >= 2) {
          add('REVIEW-DISCRIMINATED-UNION', node.name, node, {
            subject: node.name.text,
            sig: text(node),
            detail: `${discriminants.map((p) => `${p.name.getText(sf)}: ${text(/** @type {Node} */ (p.type))}`).join('; ')}; optional: ${optionals
              .map((p) => p.name.getText(sf))
              .join(', ')}`,
          });
        }
      }
    }

    // REVIEW-THROW
    if (ts.isThrowStatement(node)) {
      const fnName = enclosingFunctionName(ts, node);
      add('REVIEW-THROW', node, node, {
        subject: text(node.expression),
        sig: `${text(node)}|${fnName}`,
        detail: fnName,
        exempt: throwExemption(ts, node),
      });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return items;
}

/**
 * @param {string} name
 * @param {boolean} isConst
 * @param {() => boolean} pascalAllowed
 * @returns {boolean}
 */
function valueNameOk(name, isConst, pascalAllowed) {
  if (CAMEL_CASE.test(name) || UNDERSCORES.test(name)) return true;
  if (UPPER_SNAKE.test(name)) return isConst;
  if (PASCAL_CASE.test(name)) return pascalAllowed();
  return false;
}

/**
 * @param {TS} ts
 * @param {Node} node
 * @param {import('typescript').SyntaxKind} kind
 * @returns {boolean}
 */
function hasModifier(ts, node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/**
 * @template {Node} T
 * @param {TS} ts
 * @param {Node} node
 * @param {(n: Node) => n is T} test
 * @returns {T | undefined}
 */
function findAncestor(ts, node, test) {
  for (let cur = node.parent; cur !== undefined && !ts.isSourceFile(cur); cur = cur.parent) {
    if (test(cur)) return cur;
  }
  return undefined;
}

/**
 * @param {TS} ts
 * @param {import('typescript').TypeNode} t
 * @returns {import('typescript').TypeNode}
 */
function unwrapType(ts, t) {
  let cur = t;
  while (ts.isParenthesizedTypeNode(cur)) cur = cur.type;
  return cur;
}

/**
 * @param {TS} ts
 * @param {Node} e
 * @returns {Node}
 */
function unwrapExpression(ts, e) {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Names a factory call may be known by: `React.memo(…)` → memo, React; `styled.div\`…\`` → div, styled;
 * `createFileRoute('/x')({…})` → createFileRoute.
 * @param {TS} ts
 * @param {Node} e
 * @returns {string[]}
 */
function factoryNames(ts, e) {
  /** @type {Node | undefined} */
  let callee = ts.isCallExpression(e) ? e.expression : ts.isTaggedTemplateExpression(e) ? e.tag : undefined;
  /** @type {string[]} */
  const names = [];
  while (callee !== undefined) {
    if (ts.isIdentifier(callee)) {
      names.push(callee.text);
      callee = undefined;
    } else if (ts.isPropertyAccessExpression(callee)) {
      names.push(callee.name.text);
      callee = callee.expression;
    } else if (ts.isCallExpression(callee)) {
      callee = callee.expression;
    } else {
      callee = undefined;
    }
  }
  return names;
}

/**
 * A module-scope constant whose value is a literal or an `as const` expression.
 * @param {TS} ts
 * @param {Node} init
 * @returns {boolean}
 */
function isLiteralConstant(ts, init) {
  let e = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isAsExpression(e) && ts.isTypeReferenceNode(e.type) && ts.isIdentifier(e.type.typeName) && e.type.typeName.text === 'const') {
    return true;
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) e = e.operand;
  return (
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * Where an `any` keyword sits, in words.
 * @param {TS} ts
 * @param {Node} parent
 * @returns {string}
 */
function anyContext(ts, parent) {
  if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) return 'type assertion';
  if (ts.isParameter(parent)) return 'parameter';
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) return 'property';
  if (ts.isVariableDeclaration(parent)) return 'variable';
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent) || ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return 'type argument';
  }
  if (ts.isArrayTypeNode(parent)) return 'array element';
  if (ts.isUnionTypeNode(parent) || ts.isIntersectionTypeNode(parent)) return 'union/intersection member';
  return 'other';
}

/**
 * @param {TS} ts
 * @param {import('typescript').TypeNode} t
 * @returns {boolean}
 */
function isLiteralUnion(ts, t) {
  return ts.isUnionTypeNode(t) && t.types.length >= 2 && t.types.every((m) => ts.isLiteralTypeNode(m));
}

/**
 * Whether `interface X extends <operand>` is possible.
 * @param {TS} ts
 * @param {import('typescript').TypeNode} op
 * @param {ReadonlySet<string>} params Type parameters of the alias.
 * @param {TypeChecker | null} checker
 * @returns {boolean}
 */
function isExtendable(ts, op, params, checker) {
  if (mentionsAny(ts, op, params)) return false;
  if (ts.isTypeLiteralNode(op)) return true;
  if (!ts.isTypeReferenceNode(op)) return false;
  if (checker === null) return true;
  const type = checker.getTypeFromTypeNode(op);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
  /** @param {import('typescript').Type} t @returns {boolean} */
  const isObject = (t) =>
    (t.flags & ts.TypeFlags.Object) !== 0 ||
    ((t.flags & ts.TypeFlags.Intersection) !== 0 && /** @type {import('typescript').IntersectionType} */ (t).types.every(isObject));
  return isObject(type);
}

/**
 * @param {TS} ts
 * @param {Node} node
 * @param {ReadonlySet<string>} names
 * @returns {boolean}
 */
function mentionsAny(ts, node, names) {
  if (names.size === 0) return false;
  let found = false;
  /** @param {Node} n */
  const walk = (n) => {
    if (found) return;
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && names.has(n.typeName.text)) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * @param {TS} ts
 * @param {Node} node
 * @returns {boolean}
 */
function containsJsx(ts, node) {
  let found = false;
  /** @param {Node} n */
  const walk = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * Module-level functions declared by a top-level statement.
 * @param {TS} ts
 * @param {Node} statement
 * @returns {{ name: string, anchor: Node, node: import('typescript').SignatureDeclaration & { body?: Node } }[]}
 */
function topLevelFunctions(ts, statement) {
  if (ts.isFunctionDeclaration(statement)) {
    return [{ name: statement.name?.text ?? '(default)', anchor: statement.name ?? statement, node: statement }];
  }
  if (ts.isExportAssignment(statement)) {
    const e = unwrapExpression(ts, statement.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return [{ name: '(default)', anchor: statement, node: e }];
    return [];
  }
  if (!ts.isVariableStatement(statement)) return [];
  /** @type {ReturnType<typeof topLevelFunctions>} */
  const out = [];
  for (const d of statement.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || d.type !== undefined || d.initializer === undefined) continue;
    let init = d.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push({ name: d.name.text, anchor: d.name, node: init });
  }
  return out;
}

/**
 * @param {TS} ts
 * @param {import('typescript').SignatureDeclaration} fn
 * @returns {string}
 */
function functionName(ts, fn) {
  if (fn.name !== undefined) return fn.name.getText();
  const p = fn.parent;
  if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p !== undefined && ts.isPropertyAssignment(p)) return p.name.getText();
  return '(anonymous)';
}

/**
 * @param {TS} ts
 * @param {Node} node
 * @returns {string}
 */
function enclosingFunctionName(ts, node) {
  for (let cur = node.parent; cur !== undefined && !ts.isSourceFile(cur); cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return functionName(ts, cur);
  }
  return '(module)';
}

/**
 * Deterministic reasons a `throw` is not a candidate for a Result type.
 * @param {TS} ts
 * @param {import('typescript').ThrowStatement} node
 * @returns {string | null}
 */
function throwExemption(ts, node) {
  const e = unwrapExpression(ts, node.expression);
  if (ts.isIdentifier(e)) {
    const c = findAncestor(ts, node, ts.isCatchClause);
    const v = c?.variableDeclaration?.name;
    if (v !== undefined && ts.isIdentifier(v) && v.text === e.text) return 'E-RETHROW';
  }
  if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
    const callee = e.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (FRAMEWORK_THROW_CALLEES.has(name)) return 'E-FRAMEWORK-THROW';
  }
  for (let cur = node.parent; cur !== undefined && !ts.isSourceFile(cur); cur = cur.parent) {
    if (!ts.isFunctionLike(cur)) continue;
    const p = cur.parent;
    if (ts.isMethodDeclaration(cur) && FRAMEWORK_THROW_PROPERTIES.has(cur.name.getText())) return 'E-FRAMEWORK-THROW';
    if (p !== undefined && ts.isPropertyAssignment(p) && FRAMEWORK_THROW_PROPERTIES.has(p.name.getText())) return 'E-FRAMEWORK-THROW';
  }
  return null;
}

/**
 * Names a file exports (named or default declarations), used to validate PascalCase file names.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @returns {Set<string>}
 */
export function exportedNames(ts, sf) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression)) {
      names.add(s.expression.text);
      continue;
    }
    if (ts.isExportDeclaration(s) && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) names.add(el.name.text);
      continue;
    }
    if (!hasModifier(ts, s, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (
      (ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isEnumDeclaration(s)) &&
      s.name !== undefined
    ) {
      names.add(s.name.text);
    }
  }
  return names;
}

/**
 * Strips file-based-router decorations from one name segment: `$id`, `_layout`, `__root`,
 * `-components`, `+page`, `(group)`, `[id]`, `[...slug]`, `[[...slug]]`.
 * @param {string} segment
 * @returns {string}
 */
function stripRouterDecorations(segment) {
  return segment
    .replace(/^\[\[?(?:\.\.\.)?(.*?)\]?\]$/, '$1')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/^[$_+-]+/, '');
}

/**
 * @param {string} relPath Repo-relative path of a new TypeScript file.
 * @param {ReadonlySet<string>} exports Names the file exports.
 * @returns {{ subject: string, detail: string, expected: string, suggestion: string } | null}
 */
export function fileNameIssue(relPath, exports) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const stem = base.replace(/\.(?:d\.)?[mc]?tsx?$/, '');
  const ext = base.slice(stem.length);
  const parts = stem.split('.');
  const bad = parts.some((p) => {
    const s = stripRouterDecorations(p);
    return s !== '' && !CAMEL_CASE.test(s) && !PASCAL_CASE.test(s);
  });
  const camel = parts.map((p) => (stripRouterDecorations(p) === '' ? p : toStyle(p, 'camelCase'))).join('.') + ext;
  if (bad) return { subject: base, detail: 'not camelCase', expected: 'camelCase', suggestion: camel };
  const first = parts[0] ?? '';
  if (PASCAL_CASE.test(first) && !exports.has(first)) {
    return { subject: base, detail: `PascalCase but exports no \`${first}\``, expected: 'camelCase', suggestion: camel };
  }
  return null;
}

/**
 * @param {string} segment One directory name.
 * @returns {{ subject: string, detail: string, expected: string, suggestion: string } | null}
 */
export function directoryNameIssue(segment) {
  const s = stripRouterDecorations(segment);
  if (s === '' || CAMEL_CASE.test(s)) return null;
  return { subject: `${segment}/`, detail: 'directory not camelCase', expected: 'camelCase', suggestion: `${toStyle(segment, 'camelCase')}/` };
}
