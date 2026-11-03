// @ts-check
/**
 * Rule catalogue and detector of the Zod scanner (find-zod-issues.mjs). Changing either changes
 * results: bump TOOL_VERSION in find-zod-issues.mjs and the plugin version.
 */
import { builtinModules } from 'node:module';
import { rawItem } from './ts-scan.mjs';

/** @typedef {typeof import('typescript')} TS */
/** @typedef {import('typescript').Node} Node */
/** @typedef {import('typescript').SourceFile} SourceFile */
/** @typedef {import('typescript').TypeChecker} TypeChecker */
/**
 * Looks a package name up for a file, lazily: its declared version range (`workspace:` for a
 * workspace member, `installed` for an undeclared package found in node_modules, e.g. hoisted),
 * undefined when it is neither (a baseUrl alias), null when nothing is known (no package.json).
 * @typedef {(name: string) => string | null | undefined} PackageLookup
 */

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
 * Words that mark a package, alias or imported name as a source of schemas (`@qida/contracts`,
 * `UserDto`, `@/validators`). A name imported from any other package (`superjson`, `cron-parser`,
 * `date-fns`) is not a Zod schema.
 */
const SCHEMA_WORDS = /schema|contract|dto|validat|model|zod/i;

/** Globals whose `.parse` is not Zod's (`JSON.parse`, `Date.parse`, `URL.parse`, `globalThis.JSON.parse`…). */
const NON_ZOD_GLOBALS = new Set(['JSON', 'Date', 'URL', 'Intl', 'Math', 'Number', 'Reflect', 'globalThis', 'window', 'self', 'global']);

/**
 * Finds every `.parse` / `.parseAsync` call on a Zod schema. Pure: depends only on the source
 * text and (when given) the type checker.
 *
 * With the checker, a receiver is a Zod schema when its non-nullable type has `safeParse`.
 * Without it, or when the type is unresolved (`any`, e.g. `zod` not installed), the receiver is
 * judged by syntax (see `syntacticZod`), which never takes a known global such as `JSON` for a schema.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @param {TypeChecker | null} checker
 * @param {PackageLookup | null} [packages] Dependencies declared by the package.json files
 *   above the file (name → version range), to tell an npm package (`superjson`) from project code:
 *   a baseUrl alias (`features/user`) or a workspace package (`"@qida/shared": "workspace:*"`).
 *   null: unknown, every bare specifier is taken as a package.
 * @returns {RawItem[]}
 */
export function detect(ts, sf, checker, packages = null) {
  /** @type {RawItem[]} */
  const items = [];
  const imports = importSources(ts, sf);
  const importsZod = [...imports.values()].some(isZodModule);
  /** @param {Node} n */
  const text = (n) => n.getText(sf).replace(/\s+/g, ' ').trim();

  /** @param {Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const safe = SAFE_METHODS.get(method);
      const receiver = node.expression.expression;
      const receiverText = text(receiver);
      // A known global (`JSON.parse`, `globalThis.JSON.parse`…) is not even an item: no noise in
      // the counts. Only a chain made of global names alone, whose root the file does not declare.
      if (safe !== undefined && !isGlobalChain(ts, receiver, imports, checker)) {
        const type = checker === null ? null : checker.getNonNullableType(checker.getTypeAtLocation(receiver));
        // An unresolved type (missing dependency) is `any`: fall back to syntax rather than guess.
        const isZod =
          type === null || (type.flags & ts.TypeFlags.Any) !== 0
            ? syntacticZod(ts, receiver, receiverText, imports, importsZod, packages)
            : type.getProperty('safeParse') !== undefined;
        items.push(
          rawItem(sf, 'V-ZOD-PARSE', node.expression.name, node, {
            subject: `${receiverText}.${method}(…)`,
            sig: text(node.expression),
            detail: method,
            suggestion: `${receiverText}.${safe}(…)`,
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
 * Whether a receiver is a known global or a chain of them only (`JSON`, `globalThis.JSON`,
 * `window.Date`) whose root is the global itself. `self.bodySchema` or `globalThis.cfg.schema`
 * are not: they reach something else. With a type checker, the root is the global when every
 * declaration of its symbol lives in a declaration file (lib.d.ts, @types); without one, when no
 * import and no enclosing scope binds the name.
 * @param {TS} ts
 * @param {Node} node
 * @param {Map<string, string>} imports
 * @param {TypeChecker | null} checker
 * @returns {boolean}
 */
function isGlobalChain(ts, node, imports, checker) {
  let n = node;
  while (ts.isPropertyAccessExpression(n)) {
    if (!NON_ZOD_GLOBALS.has(n.name.text)) return false;
    n = n.expression;
  }
  if (!ts.isIdentifier(n) || !NON_ZOD_GLOBALS.has(n.text)) return false;
  // Imported from a module (`import { URL } from '@qida/contracts'`): the module decides, never
  // the global, even when its declaration lives in a .d.ts. `node:url` and the like are judged as
  // packages by the syntactic rule.
  if (imports.has(n.text) && !/^node:|^(?:url|util)$/.test(imports.get(n.text) ?? '')) return false;
  let symbol = checker === null ? undefined : checker.getSymbolAtLocation(n);
  // `import { URL } from 'node:url'`: judge the imported declaration, not the import specifier.
  if (checker !== null && symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const decls = symbol?.declarations ?? [];
  if (decls.length > 0) return decls.every((d) => d.getSourceFile().isDeclarationFile);
  return !imports.has(n.text) && !isLocallyBound(ts, n);
}

/**
 * Whether an identifier refers to a binding of an enclosing scope (parameter, variable, function,
 * class, catch or loop variable, or a `var` hoisted from anywhere in the enclosing function),
 * found by walking up from the use: a `URL` parameter of another function does not shadow the
 * global here.
 * @param {TS} ts
 * @param {import('typescript').Identifier} id
 * @returns {boolean}
 */
function isLocallyBound(ts, id) {
  const name = id.text;
  /** @param {Node} b @returns {boolean} */
  const binds = (b) =>
    ts.isIdentifier(b)
      ? b.text === name
      : (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) &&
        b.elements.some((el) => ts.isBindingElement(el) && binds(el.name));
  /** @param {import('typescript').VariableDeclarationList} list */
  const listBinds = (list) => list.declarations.some((d) => binds(d.name));
  /** @param {readonly import('typescript').Statement[]} statements */
  const statementsBind = (statements) =>
    statements.some(
      (st) =>
        (ts.isVariableStatement(st) && listBinds(st.declarationList)) ||
        ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name),
    );
  /** @param {Node} scope @returns {boolean} */
  const hoistedVar = (scope) => hoistedVarNames(ts, scope).has(name);
  for (let n = id.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => binds(p.name))) return true;
    if ((ts.isFunctionLike(n) || ts.isSourceFile(n)) && hoistedVar(n)) return true;
    if ((ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name?.text === name) return true;
    if ((ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) && statementsBind(n.statements)) return true;
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer !== undefined && ts.isVariableDeclarationList(n.initializer) && listBinds(n.initializer)) return true;
    if (ts.isCatchClause(n) && n.variableDeclaration !== undefined && binds(n.variableDeclaration.name)) return true;
  }
  return false;
}

/** Names declared with `var` per function or file, computed once per scope. */
/** @type {WeakMap<Node, Set<string>>} */
const HOISTED = new WeakMap();

/**
 * Every name declared with `var` anywhere in a function body or file, not inside nested functions.
 * @param {TS} ts
 * @param {Node} scope
 * @returns {Set<string>}
 */
function hoistedVarNames(ts, scope) {
  const cached = HOISTED.get(scope);
  if (cached !== undefined) return cached;
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {Node} b */
  const add = (b) => {
    if (ts.isIdentifier(b)) names.add(b.text);
    else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) {
      for (const el of b.elements) if (ts.isBindingElement(el)) add(el.name);
    }
  };
  /** @param {Node} node */
  const visit = (node) => {
    if (node !== scope && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const d of node.declarations) add(d.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  HOISTED.set(scope, names);
  return names;
}

/**
 * @param {string} spec Module specifier.
 * @returns {boolean}
 */
function isZodModule(spec) {
  // `zod` itself, or a package re-exporting it whose name has a `zod` segment
  // (`@hono/zod-openapi`, `nestjs-zod`, `zod-openapi`): its `z` builds Zod schemas.
  return spec === 'zod' || spec.startsWith('zod/') || /(?:^|[@/-])zod(?:$|[/-])/.test(spec);
}

/**
 * Local names bound by the file's imports, mapped to their module specifier: ES imports,
 * `import x = require('m')`, and `const x = require('m')` / `const { a } = require('m')`.
 * @param {TS} ts
 * @param {SourceFile} sf
 * @returns {Map<string, string>}
 */
function importSources(ts, sf) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @param {Node} name @param {string} spec */
  const bind = (name, spec) => {
    if (ts.isIdentifier(name)) out.set(name.text, spec);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (ts.isBindingElement(el)) bind(el.name, spec);
    }
  };
  // Module-scope requires only: a `require` inside a function binds a name in that scope alone,
  // and must not stand for every use of the name in the file.
  /** @param {Node} node */
  const visitRequires = (node) => {
    // Only the file's own top-level statements: a require inside a block, a function or a class
    // binds its name there alone.
    if (node !== sf && !ts.isVariableStatement(node) && !ts.isVariableDeclarationList(node) && !ts.isVariableDeclaration(node)) return;
    if (ts.isVariableStatement(node) && node.parent !== sf) return;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteralLike(node.initializer.arguments[0])
    ) {
      bind(node.name, node.initializer.arguments[0].text);
    }
    ts.forEachChild(node, visitRequires);
  };
  visitRequires(sf);
  for (const s of sf.statements) {
    if (
      ts.isImportEqualsDeclaration(s) &&
      ts.isExternalModuleReference(s.moduleReference) &&
      ts.isStringLiteralLike(s.moduleReference.expression)
    ) {
      out.set(s.name.text, s.moduleReference.expression.text);
      continue;
    }
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const spec = s.moduleSpecifier.text;
    const clause = s.importClause;
    // A side-effect import binds no name; keep it so `importsZod` still sees `import 'zod'`.
    if (clause === undefined) out.set(`\0${spec}`, spec);
    else {
      if (clause.name !== undefined) out.set(clause.name.text, spec);
      const nb = clause.namedBindings;
      if (nb !== undefined && ts.isNamespaceImport(nb)) out.set(nb.name.text, spec);
      else if (nb !== undefined) for (const el of nb.elements) out.set(el.name.text, spec);
    }
  }
  return out;
}

/**
 * Leftmost identifier of a receiver chain (`a` in `a.b().c`), or null (`this`, literals…).
 * @param {TS} ts
 * @param {Node} node
 * @returns {string | null}
 */
function rootName(ts, node) {
  let n = node;
  for (;;) {
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) n = n.expression;
    else if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n))
      n = n.expression;
    else return null;
  }
}

/**
 * Syntax-only verdict (known globals never reach it): a receiver named `…Schema` is a schema; one
 * rooted at a name imported from `zod` is; one rooted at a name imported from a declared package
 * (or a Node built-in) is only when the package or the name says schemas (`@qida/contracts`,
 * `UserDto`; see SCHEMA_WORDS) and the file imports `zod`; anything else (local, relative, alias,
 * baseUrl paths) when the file imports `zod`.
 * @param {TS} ts
 * @param {Node} receiver
 * @param {string} receiverText
 * @param {Map<string, string>} imports
 * @param {boolean} importsZod
 * @param {PackageLookup | null} packages
 * @returns {boolean}
 */
function syntacticZod(ts, receiver, receiverText, imports, importsZod, packages) {
  if (/schema$/i.test(receiverText)) return true;
  const root = rootName(ts, receiver);
  const spec = root === null ? undefined : imports.get(root);
  if (spec === undefined || /^(?:\.|@\/|~\/|#)/.test(spec)) return importsZod; // local, relative or alias
  if (isZodModule(spec)) return true;
  const pkg = packageName(spec);
  const range = packages === null ? null : packages(pkg);
  // Project code: a bare specifier no package.json declares (a baseUrl/paths alias), or a
  // workspace/local package. Its exports may be schemas, like any local module.
  const projectCode = /^(?:workspace|file|link|portal):/.test(range ?? '') || range === undefined;
  const isPackage = spec.startsWith('node:') || builtinModules.includes(pkg) || !projectCode;
  if (!isPackage) return importsZod;
  return SCHEMA_WORDS.test(spec) || SCHEMA_WORDS.test(root ?? '') ? importsZod : false;
}

/**
 * Package name of a module specifier: `date-fns/fp` → `date-fns`, `@iarna/toml/lib` → `@iarna/toml`.
 * @param {string} spec
 * @returns {string}
 */
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

