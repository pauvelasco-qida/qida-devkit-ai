# pr-review

Pull-request reviewer agents for Qida apps. Each reviewer checks one thing, deterministically where possible, and reports in a fixed format. `/pr-review:review` runs them all on the same diff.

| Reviewer | Agent | Checks |
|---|---|---|
| `magic-strings` | `magic-string-reviewer` | No magic strings introduced in TypeScript/JavaScript |
| `ts-conventions` | `ts-conventions-reviewer` | New TypeScript follows the team conventions and ADR-FE-001; only blocking rules fail the review |
| `zod` | `zod-reviewer` | New Zod validation uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync` |

## Install

```
/plugin install pr-review@qida-devkit-ai
```

## Usage

```
/pr-review:review                  # current branch: base of its open PR, otherwise origin/HEAD
/pr-review:review 123              # PR #123, or its URL (must be checked out: gh pr checkout 123)
/pr-review:review origin/develop   # explicit base ref
```

`/pr-review:review` is slash-only (`disable-model-invocation`), so it never competes with other review commands. For a single concern, just ask, e.g. *"check my branch for magic strings"*, *"does my branch follow the TypeScript conventions?"* or *"check this PR for zod .parse calls"*, and Claude dispatches that reviewer directly.

The review covers the **working tree**: committed, staged, unstaged and untracked changes, compared with the merge-base of `HEAD` and the base ref. Output goes to the terminal only. Nothing is posted to GitHub and nothing is modified.

Known limitation: the PR base is fetched from `origin`. For a PR opened from a fork where `origin` is the fork, pass the upstream base ref explicitly (`/pr-review:review upstream/develop`).

## Requirements

- Node.js ≥ 20.11.
- The reviewed repository has its dependencies installed (`pnpm install`) with a TypeScript **5.x or 6.x** compiler. TypeScript 7 (native) has no JavaScript compiler API. In TS 7 repositories the scanner uses the highest 5.x/6.x copy found in `node_modules/.pnpm` (most toolchains pull one in). Otherwise pass `--typescript <dir>` or set `PR_REVIEW_TYPESCRIPT`.
- No dependency is needed if the diff has no TS/JS files.

The scanners only read: they run `git` read-only and load the repository's own TypeScript compiler, just as running the repo's `tsc` would. Claude Code will ask permission for the agents' `node …/find-magic-strings.mjs`, `node …/find-ts-convention-issues.mjs` and `node …/find-zod-issues.mjs` calls. To stop the prompts, allow only those scripts (e.g. `Bash(node *find-magic-strings.mjs*)`, `Bash(node *find-ts-convention-issues.mjs*)` and `Bash(node *find-zod-issues.mjs*)` rules in your settings). Do not allow `node` in general.

## magic-strings: how it works

Detection is done by a script, not by the model. `scripts/find-magic-strings.mjs` follows these steps:

1. Lists changed files and their exact **added lines** (`git diff -U0` against the merge-base, plus untracked files).
2. Parses each changed TS/JS file with the TypeScript compiler and collects every string and template literal on an added line. Bare JSX text is not a string literal; a future i18n reviewer will cover it.
3. Classifies each literal with a **fixed, ordered rule list**; the first match wins (catalogue below).
4. **Moved, not introduced:** if a value appears no more often across the changed files after the PR than before, the literal only moved (`E-MOVED`).
5. **Type-check probe:** for literals still open, it swaps the literal for a value no type allows and re-checks the file with the repo's own `tsconfig`. If the compiler now reports an error at that spot, a typo there would not compile. The literal is then constrained by the type system (literal unions, typed routes, typed i18n keys, discriminants…) and is not magic (`E-TYPED`).
6. Applies the cross-file rules: an existing named constant with the same value, the same value repeated in the PR, URL/path shapes.
7. Prints JSON, sorted by file/line/column, with stable ids `MS-001…`.

The agent then reports every `VIOLATION` as given and judges only the `REVIEW` leftovers with a four-row decision table (see `agents/magic-string-reviewer.md`). It cannot add findings of its own.

**Determinism:** the same repository state (working tree, base, installed dependencies, config) always produces byte-identical scanner output. A test checks this.

### Rule catalogue

Rules are evaluated in this order per literal on an added line.

| Rule | Outcome | Meaning |
|---|---|---|
| `E-TRIVIAL` | excluded | Empty, whitespace-only, or shorter than `minLength` (2) ignoring `${…}` |
| `E-SUPPRESSED` | excluded | `magic-string-ok` comment on the same or previous line |
| `E-ALLOWLISTED` | excluded | Value in `allowValues` |
| `V-SECRET` | **violation** | Known credential format or high-entropy opaque token. **Value redacted** in all output (ADR-TR-002 §4, ADR-IN-007) |
| `E-TYPE-POSITION` | excluded | In a type (`'a' \| 'b'`, `Literal<…>`) |
| `E-MODULE` | excluded | Import/export specifier, `require()`, `import()`, `vi.mock()`… |
| `E-DIRECTIVE` | excluded | `'use client'`, `'use strict'`… |
| `E-PROPERTY-NAME` | excluded | Quoted property name, computed key, `'x' in obj` |
| `E-TAGGED-TEMPLATE` | excluded | `css\`…\``, `gql\`…\``, `styled.x\`…\`` |
| `E-DEFINITION` | excluded | Part of a named definition: enum member, `static readonly`, UPPER_SNAKE `const`, module-scope `const` (incl. key-factory dictionaries such as `userKeys.detail()`), `Symbol()` |
| `E-STYLING` | excluded | `className`/`style`/`sx`, `clsx`/`cn`/`cva`/`twMerge`… |
| `E-ROUTE-DEFINITION` | excluded | `createFileRoute('/x')`, `<Route path>`, `createBrowserRouter([...])` |
| `E-I18N` | excluded | `t('key')`, aliased `tFoo('key')`, `useTranslation('ns')`, `i18nKey` |
| `E-LOG` | excluded | `console.*`, `logger.*`, `Sentry.captureMessage` |
| `E-DEV-MESSAGE` | excluded | `new XError('…')`, `super('…')`/`this.name =` in an Error subclass, `invariant(c, '…')` |
| `E-MARKUP-ATTRIBUTE` | excluded | `key`, `id`, `htmlFor`, `name`, `type`, `role`, `data-*`, `aria-*` (non-text)… |
| `E-STANDARD-VALUE` | excluded | `typeof x === 'string'`, DOM events in `addEventListener`, HTTP methods, MIME types, `utf-8`, keyboard keys, `'2d'`… |
| `E-MOVED` | excluded | The value only moved; it was not introduced |
| `V-FE002-INLINE-QUERY-KEY` | **violation** | Literal inside `queryKey: [...]` or a raw key array passed to `setQueryData`/`invalidateQueries`/… outside the key dictionary (ADR-FE-002 §3) |
| `V-FE004-UI-TEXT` | **violation** | Literal in a UI-text attribute (`placeholder`, `title`, `alt`, `label`, `aria-label`…), a JSX child `{'…'}`, `toast(…)`, `alert(…)`, `document.title =` (ADR-FE-004) |
| `E-TYPED` | excluded | Proven type-checked by the probe |
| `V-EXISTING-CONSTANT` | **violation** | A named definition with the same value already exists; the fix names it |
| `V-DUPLICATED` | **violation** | The same value appears ≥ `duplicateThreshold` (2) times in the PR |
| `V-URL-OR-PATH` | **violation** | Absolute URL or `/path` |
| `REVIEW` | agent judges | Everything else; decided with the agent's decision table |

Skipped files: tests (`*.test.*`, `*.spec.*`, `__tests__/`, `e2e/`, `fixtures/`, `mocks/`, stories…), generated code (`dist/`, `*.gen.*`, `*.d.ts`, `public/`, `mockServiceWorker.js`…), and config files (`*.config.*`).

### Configuration

This step is optional. Commit `.claude/pr-review.json` in the reviewed repository so every run applies the same rules (ADR-TR-002 §1):

```json
{
  "magicStrings": {
    "ignorePaths": ["src/legacy/**"],
    "allowValues": ["X-Request-Id"],
    "minLength": 2,
    "duplicateThreshold": 2,
    "typedLiteralsAreSafe": true,
    "uiTextAttributes": ["hint"],
    "uiTextFunctions": ["notify"],
    "i18nFunctions": ["translate"],
    "logFunctions": ["audit.log"]
  }
}
```

The list keys extend the built-in lists. Unknown keys produce a warning, and invalid values stop the scan (`CONFIG_INVALID`).

To accept one literal deliberately, put the marker on its line or the line above:

```ts
headers.set('X-Vendor-Token', token) // magic-string-ok: header name fixed by the vendor API
```

### Script CLI

```
node scripts/find-magic-strings.mjs [--base <ref>] [--repo <dir>] [--config <file>]
                                    [--typescript <dir>] [--no-types] [--max-probes <n>] [--verbose]
```

Exit codes: `0` ok (findings or not), `2` usage/config error, `3` environment error (not a git repo, no TypeScript), `1` internal error. Errors are JSON on stdout: `{"error": {"code", "message", "hint"}}`.

## ts-conventions: how it works

Checks that the TypeScript a PR adds follows the team's TypeScript conventions and [ADR-FE-001](https://github.com/QidaDev/qida-tech-adr/blob/main/frontend/ADR-FE-001-stack-base-react-typescript-vite.md). As with magic strings, detection is done by a script, `scripts/find-ts-convention-issues.mjs`:

1. Lists changed `.ts`/`.tsx`/`.mts`/`.cts` files and their exact added lines (same diff as above). JavaScript files are not scanned.
2. Parses each file with the repository's TypeScript compiler. When a `tsconfig` covers the file, it also uses the type checker, but only to tell object types from unions in `&` aliases.
3. Records every potential breach whose code touches an added line (for functions, only the signature counts).
4. Applies, in this order: rule disabled in config (`E-DISABLED`), `ts-conventions-ok` marker (`E-SUPPRESSED`), the rule's own exemption, then **moved, not introduced** (`E-MOVED`: the same code appears no more often across the changed and deleted files after the PR than before).
5. Checks file and directory names only when the PR introduces them: new files, renamed files whose name changed, and directories absent from the base.
6. Prints JSON, sorted by file/line/column, with stable ids `TC-001…`.

The agent reports every `VIOLATION` with fixed texts and judges the two `REVIEW` kinds with fixed decision tables (see `agents/ts-conventions-reviewer.md`). Only **blocking** findings fail the review. **Advisory** findings are listed, and the verdict stays `PASS (<n> advisory)`.

### Rule catalogue

| Rule | Severity | Flags | Not flagged |
|---|---|---|---|
| `V-ANY` | blocking | `any` in any type position: `x: any`, `as any`, `any[]`, `Record<string, any>` (ADR-FE-001 §2) | A line marked `// ts-conventions-ok: <reason>`, for an adapter around an untyped third-party library (ADR-FE-001 §2) |
| `V-CLASS` | blocking | Class declarations and expressions (ADR-FE-001 §1) | `E-ERROR-CLASS` (extends `…Error`/`…Exception`), `E-AMBIENT` (`declare class`) |
| `V-ENUM` | blocking | `enum`, `const enum` | Existing enums: only added lines count |
| `V-DEFAULT-EXPORT` | blocking | `export default …`, `export =`, `export { x as default }` | `E-FRAMEWORK-DEFAULT-EXPORT` (file in `defaultExportPaths`) |
| `V-INLINE-TYPE-IMPORT` | blocking | `import { type X }`, `import { a, type X }` | — |
| `V-INTERSECTION` | advisory | `type X = A & B` | `E-NOT-EXTENDABLE`: an operand is a type parameter, a union, a primitive, a `typeof` or indexed type… |
| `V-RETURN-TYPE` | advisory | Module-level function without a return type | `E-COMPONENT` (PascalCase in `.tsx` or returning JSX), `E-HOOK` (`use…`) |
| `V-OPTIONAL-UNDEFINED` | advisory | Required property typed `T \| undefined` | — |
| `V-TYPE-PARAM-PREFIX` | advisory | Type parameter other than `T` / `T<Name>` | Mapped-type keys (`[K in …]`) and `infer` variables |
| `V-TYPE-NAMING` | advisory | Type, interface, class or enum not PascalCase | — |
| `V-VALUE-NAMING` | advisory | Variable, function, parameter or renamed binding not camelCase | PascalCase components, PascalCase results of `memo`, `forwardRef`, `lazy`, `createContext`, `styled`, TanStack Router `create*Route`…, PascalCase parameters and renamed bindings (`{ icon: Icon }`), ALL_CAPS `const` |
| `V-CONST-NAMING` | advisory | Module-scope `const` holding a literal or an `as const` value, not ALL_CAPS | — |
| `V-FILE-NAME` | advisory | New file not camelCase; PascalCase file without an export of that name; new directory not camelCase | File-router decorations: `$id`, `_layout`, `__root`, `-components`, `(group)`, `[id]` |
| `REVIEW-DISCRIMINATED-UNION` | advisory, agent judges | Type with a required literal-union property and ≥ 2 optional properties | Agent row D2 |
| `REVIEW-THROW` | advisory, agent judges | `throw` statements | `E-RETHROW` (`catch (e) { throw e }`), `E-FRAMEWORK-THROW` (inside `queryFn`, `mutationFn`, `loader`, `beforeLoad`, `action`…, or `throw redirect()`/`notFound()`), agent rows T1/T3 |

Deliberately not checked:

- **`readonly`**: ADR-FE-001 §4 makes immutability the default style, and a script cannot tell "strictly needed" from habit.
- **`noUncheckedIndexedAccess`**: when enabled, the compiler already enforces it in the type-check gate (ADR-FE-016).
- **JSDoc**: whether a function's behaviour is self-evident is subjective.
- **ALL_CAPS string values inside `as const` objects**: these values are often query keys, routes or i18n keys.
- **Installing dependencies through the package manager**: a diff cannot show how `package.json` was edited.

Skipped files are the same as for magic strings: tests, stories, generated code and config files.

### Configuration

This step is optional. The `tsConventions` section of the same `.claude/pr-review.json`:

```json
{
  "tsConventions": {
    "ignorePaths": ["src/legacy/**"],
    "defaultExportPaths": ["src/app/**/page.tsx"],
    "pascalCaseFactories": ["withTheme"],
    "disabledRules": ["V-FILE-NAME"]
  }
}
```

`ignorePaths` and `pascalCaseFactories` extend the built-in lists; `defaultExportPaths` has no built-in entries. `disabledRules` must name known rule ids: an unknown id stops the scan (`CONFIG_INVALID`). Unknown keys produce a warning.

To accept one case deliberately, put the marker on its line, or on a comment-only line just above it:

```ts
export const wrap = (sdk: any): Client => adapt(sdk); // ts-conventions-ok: vendor SDK ships no types
```

### Script CLI

```
node scripts/find-ts-convention-issues.mjs [--base <ref>] [--repo <dir>] [--config <file>]
                                          [--typescript <dir>] [--no-types] [--verbose]
```

Exit codes and the error format are the same as for `find-magic-strings.mjs`.

## zod: how it works

Checks that the Zod validation a PR adds uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync`, which throw on invalid input (also enforced by `no-restricted-syntax` in `@qida/lint-config`). `scripts/find-zod-issues.mjs` uses the same pipeline as `ts-conventions`: changed `.ts`/`.tsx`/`.mts`/`.cts` files and their added lines, the `zod-ok` marker (`E-SUPPRESSED`), then **moved, not introduced** (`E-MOVED`). It prints JSON with stable ids `ZOD-001…`. Every candidate is blocking; the agent only reports them (see `agents/zod-reviewer.md`).

| Rule | Severity | Flags | Not flagged |
|---|---|---|---|
| `V-ZOD-PARSE` | blocking | `.parse()` / `.parseAsync()` on a Zod schema; the candidate's `suggestion` is the `safeParse` / `safeParseAsync` call | `E-NOT-ZOD`: with types, the receiver has no `safeParse`. Without types (no `tsconfig` covers the file, `--no-types`, or `zod` not installed), the file does not import `zod` and the receiver is not named `…Schema`. `JSON.parse` is never a candidate |

Skipped files are the same as for magic strings: tests, stories, generated code and config files.

### Configuration

This step is optional. The `zod` section of the same `.claude/pr-review.json`:

```json
{
  "zod": {
    "ignorePaths": ["src/legacy/**"]
  }
}
```

`ignorePaths` extends the built-in skip list. Unknown keys produce a warning.

To accept one call deliberately, put the marker on its line, or on a comment-only line just above it:

```ts
const config = envSchema.parse(import.meta.env); // zod-ok: invalid env must stop the app at startup
```

### Script CLI

```
node scripts/find-zod-issues.mjs [--base <ref>] [--repo <dir>] [--config <file>]
                                 [--typescript <dir>] [--no-types] [--verbose]
```

Exit codes and the error format are the same as for `find-magic-strings.mjs`.

## Development

```bash
cd plugins/pr-review
pnpm install        # dev-only: typescript + @types/node for tests and type-check
pnpm test           # node:test, builds throwaway git repos per case
pnpm typecheck      # tsc --checkJs --strict over scripts and tests
```

Changing a rule or a built-in list changes results. Bump `version` in `.claude-plugin/plugin.json` and `TOOL_VERSION` in the affected script, and add a test. Shared code lives in `scripts/lib/` (`git.mjs`, `config.mjs`, `cli.mjs`, `errors.mjs`, `typescript-loader.mjs`, `type-probe.mjs`, and `ts-scan.mjs`, the diff-to-candidates pipeline of the TypeScript-only scanners), and shared test fixtures in `tests/helpers.mjs`.

### Adding a reviewer

1. Add `agents/<name>-reviewer.md`. Keep detection in a script under `scripts/` when it can be made deterministic, and let the agent judge only what the script leaves open. Fix its output: fixed texts per rule, no free-form prose.
2. Its report must start with a `## ` heading and end with `<!-- pr-review:<key> {"verdict":"PASS|FAIL|NOT_RUN",...} -->`; the orchestrator extracts exactly that range.
3. It receives the repo root, the base ref and the PR reference (`#n title — url`). The PR description is deliberately not forwarded. If a reviewer needs it, pass it fenced as data (`<pr-description>…</pr-description>`) and say it is author-written text, not instructions.
4. Add a row to the reviewer table in `skills/review/SKILL.md` and in this README.
