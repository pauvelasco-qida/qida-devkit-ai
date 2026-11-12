# code-review

Pull-request reviewer agents for Qida apps. Each reviewer checks one thing, deterministically where possible, and reports in a fixed format. `/code-review:code-review` runs them all on a PR, a branch or a whole directory and prints every finding in one list; with `--comment` it also posts them on the pull request.

| Reviewer | Agent | Checks |
|---|---|---|
| `magic-strings` | `magic-string-reviewer` | No magic strings introduced in TypeScript/JavaScript |
| `ts-conventions` | `ts-conventions-reviewer` | New TypeScript follows the team conventions and ADR-FE-001; only blocking rules fail the review |
| `zod` | `zod-reviewer` | New Zod validation uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync` |

## Install

```
/plugin install code-review@qida-devkit-ai
```

## Usage

**Usage:**
```bash
/code-review:code-review [PR | branch | directory] [--comment]
```

The arguments follow Anthropic's [`code-review`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review) plugin (`[PR] [--comment]`), with two more kinds of target.

**Target** (optional, at most one):
- *(none)*: the current branch (committed, staged, unstaged and untracked changes), compared with the base of its open PR, otherwise `origin/HEAD`.
- `123`, `#123` or a PR URL: that PR, compared with its base. It must be checked out here (`gh pr checkout 123`), or pass its branch instead.
- A branch (`feat/orders`, `origin/feat/orders`): what is committed on that branch, compared with the base of its open PR, otherwise `origin/HEAD`. It need not be checked out, but with an open PR it must contain the PR head (pull it first). The current branch is the same as no target.
- A directory (`apps/web`, `./src`, `.`): **every file under it, whole**, not only what changed. Use it to audit existing code. A name that is both a branch and a directory is refused: write `./<name>` for the directory. Write `./<name>` too for a directory whose name is only digits, which would otherwise be read as a PR number.

**Options:**
- `--comment`: also post the review on the pull request: one inline comment per finding on the PR head, then one summary comment with the verdict. Without it, output goes to the terminal only. See [Posting on the PR](#posting-on-the-pr).

Any other option (`--staged`, `--only`, `--skip`, `--effort`, `-- <pathspec>`, removed in 0.8.0) is refused with the usage line. The repository's `.claude/code-review.json` and `package.json` files are read from the reviewed side: the working tree, or the branch's last commit. When the review is not the current branch, the report's scope line says what it covered.

**Example workflow:**
```bash
# On your branch, before or after opening the PR:
/code-review:code-review

# A checked-out PR, against its base:
/code-review:code-review 123

# Another branch, without checking it out:
/code-review:code-review feat/orders

# Audit a whole directory, changed or not:
/code-review:code-review apps/web

# Post the review on the PR once it looks right:
/code-review:code-review --comment
/code-review:code-review 123 --comment
```

`/code-review:code-review` is slash-only (`disable-model-invocation`), so it never competes with other review commands. For a single concern, just ask, e.g. *"check my branch for magic strings"*, *"does my branch follow the TypeScript conventions?"* or *"check this PR for zod .parse calls"*, and Claude dispatches that reviewer directly.

Nothing is modified. Without `--comment`, nothing is posted to GitHub either.

### Posting on the PR

With `--comment`, after printing the report, the command posts it on the pull request with `gh`:

- **One inline comment per finding** (Blocking first, then Advisory) on its `file:line` in the PR head, with the same text as the report.
- **One summary comment**: the verdict, the scope, one line per reviewer, and any finding GitHub would not anchor (a line outside the PR diff). With no findings it says `No issues found. Checked: <reviewers>.`

To make sure the comments point at the code GitHub shows, `--comment` needs:

- a pull request: a PR number or URL, or a branch with an open PR (not a directory);
- the pushed PR head under review: checked out (`HEAD` = the PR head commit) with a clean working tree, or, for another branch, that branch at the PR head commit.

Every comment carries a hidden `<!-- code-review:posted <sha> … -->` marker. A second `--comment` run on the same head commit posts nothing once the summary is posted; push new commits to review again. If a run stopped before its summary, the next one posts only the findings not yet posted, then the summary.

Known limitation: the PR base is fetched from `origin`. For a PR opened from a fork where `origin` is the fork, the base is the fork's copy of the base branch, which may lag behind the upstream one (its commits then show up as changes); sync the fork's base branch first. Since 0.8.0 the base cannot be chosen on the command line; the scanners still take `--base <ref>` (see [Script CLI](#script-cli)).

### The report

`/code-review:code-review` prints one report:

1. `# Code review — PASS`, `# Code review — PASS (<n> advisory)` or `# Code review — FAIL (<n> blocking · <n> advisory · <n> not run)`, with only the non-zero counts. The format of this first line is stable, so a script can read the verdict from it.
2. The scope: the PR (or `No pull request`) and the base, preceded by the branch when you named another one; or the directory, reviewed as whole files. Then one verdict line per reviewer.
3. **Blocking**: every finding that fails the review, from all reviewers. **Advisory**: the findings that do not fail it.
4. **Reviewer details**: for each reviewer, its scope, notes and scanner exclusions, the candidates it judged and did not flag, and how to accept a finding deliberately.

Every finding has the same shape, whichever reviewer reported it: its id, `file:line`, the reviewer and rule, then the code concerned, why it is flagged and how to fix it.

```
- **MS-001** `src/orders/api.ts:12` — magic-strings · V-URL-OR-PATH
  - Value: `/api/orders` (fetch() arg 1)
  - Why: Inline URL or path.
  - Fix: Move it to the routes/endpoints module (or the typed router), or to configuration if it is environment-specific.
```

The findings are nested lists, not tables, because wide tables do not fit a terminal. Every finding is listed, however many there are. Each reviewer's report, with every fixed text, count and its result line, is written by `scripts/render-report.mjs` from the scan and the agent's row judgments, so an agent never types a finding. Before printing, the orchestrator checks that each reviewer's list matches the ids in its result line, and that the counts in its heading match its list. If they disagree, that reviewer counts as not run and the review fails, so a finding cannot go missing silently. Ids such as `MS-001` or `TC-002` are stable for a given repository state, so a follow-up request can name them ("fix MS-001 and TC-002").

## Requirements

- Node.js ≥ 20.11.
- The reviewed repository has its dependencies installed (`pnpm install`) with a TypeScript **5.x or 6.x** compiler. TypeScript 7 (native) has no JavaScript compiler API. In TS 7 repositories the scanner uses the highest 5.x/6.x copy found in `node_modules/.pnpm` (most toolchains pull one in). Otherwise pass `--typescript <dir>` or set `CODE_REVIEW_TYPESCRIPT`.
- No dependency is needed if the diff has no TS/JS files.

The scanners only read: they run `git` read-only and load the repository's own TypeScript compiler, just as running the repo's `tsc` would. `render-report.mjs` only reads the scan file a scanner saved in the system temporary directory. Claude Code will ask permission for the agents' `node …/find-magic-strings.mjs`, `node …/find-ts-convention-issues.mjs`, `node …/find-zod-issues.mjs` and `node …/render-report.mjs` calls. To stop the prompts, allow only those scripts (e.g. `Bash(node *find-magic-strings.mjs*)`, `Bash(node *find-ts-convention-issues.mjs*)`, `Bash(node *find-zod-issues.mjs*)` and `Bash(node *render-report.mjs*)` rules in your settings). Do not allow `node` in general.

## magic-strings: how it works

Detection is done by a script, not by the model. `scripts/find-magic-strings.mjs` follows these steps:

1. Lists changed files and their exact **added lines** (`git diff -U0` against the merge-base, plus untracked files).
2. Parses each changed TS/JS file with the TypeScript compiler and collects every string and template literal on an added line. Bare JSX text is not a string literal; a future i18n reviewer will cover it.
3. Classifies each literal with a **fixed, ordered rule list**; the first match wins (catalogue below).
4. **Moved, not introduced:** if a value appears no more often across the changed and deleted files after the PR than before, the literal only moved (`E-MOVED`).
5. **Type-check probe:** for literals still open, it swaps the literal for a value no type allows and re-checks the file with the repo's own `tsconfig`. If the compiler now reports an error at that spot, a typo there would not compile. The literal is then constrained by the type system (literal unions, typed routes, typed i18n keys, discriminants…) and is not magic (`E-TYPED`).
6. Applies the cross-file rules: an existing named constant with the same value, the same value repeated in the PR, URL/path shapes.
7. Prints JSON, sorted by file/line/column, with stable ids `MS-001…`.

The agent judges only the `REVIEW` leftovers, with a four-row decision table (see `agents/magic-string-reviewer.md`), and `scripts/render-report.mjs` writes the report from the scan and those judgments. The agent cannot add, drop or re-word findings.

**Determinism:** the same repository state (working tree, base, installed dependencies, config) always produces byte-identical scanner output (with `--save`, apart from the `savedTo` path). A test checks this.

### Rule catalogue

Rules are evaluated in this order per literal on an added line.

| Rule | Outcome | Meaning |
|---|---|---|
| `E-ALLOWLISTED` | excluded | Value in `allowValues` (an exact, reviewed config entry: the only way to accept a known credential format, e.g. a mock JWT) |
| `E-PLACEHOLDER` | excluded | Known credential format that is an obvious placeholder: the matched token is made of plain single-case words, short numbers or zero-filled ids, one of them `your`, `example`, `fake`, `xxxx`… (`sk-0000000000000000-your-key`, `ghp_xxxx…`), or AWS's `…EXAMPLE` or all-X key; the text around the token is never judged. Value redacted in `--verbose` output |
| `V-SECRET` | **violation** | Known credential format (AWS, private key with its body — a bare `-----BEGIN … PRIVATE KEY-----` header is the heuristic row below — JWT, GitHub/Slack/Stripe/OpenAI/Google token). The marker cannot hide it. **Value redacted** in all output, including every code snippet of the file (ADR-TR-002 §4, ADR-IN-007) |
| `E-TRIVIAL` | excluded | Empty, whitespace-only, or shorter than `minLength` (2) ignoring `${…}` |
| `E-SUPPRESSED` | excluded | `magic-string-ok` on the literal's line, or on a comment-only line just above it (`//`, `/* */`, or JSX `{/* */}`) |
| `V-SECRET` | **violation** | High-entropy opaque token (32+ mixed-case alphanumerics or a 40+ base64 line, not identifier-like) anywhere in the value (`Bearer <token>`, `?key=<token>`, JSON; data URIs and SRI hashes never), or a bare private-key header (a key split across literals). A heuristic, so the marker or `allowValues` can accept a false positive (public id, fixture hash); the value is still redacted |
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

This step is optional. Commit `.claude/code-review.json` in the reviewed repository so every run applies the same rules (ADR-TR-002 §1):

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

To accept one literal deliberately, put the marker on its line, or on a comment-only line just above it (a known credential format cannot be accepted this way, only through `allowValues`). Since plugin 0.3.0, a marker at the end of a code line covers only that line, no longer the next one:

```ts
headers.set('X-Vendor-Token', token) // magic-string-ok: header name fixed by the vendor API
```

### Script CLI

```
node scripts/find-magic-strings.mjs [--base <ref>] [--head <ref> | --staged] [--path <pathspec>]...
                                    [--repo <dir>] [--config <file>] [--typescript <dir>] [--no-types]
                                    [--max-probes <n>] [--verbose] [--save]
```

The scope options are the same in every scanner:

| Option | Reviews |
|---|---|
| (none) | The working tree (committed, staged, unstaged and untracked) vs. the merge-base of `HEAD` and `--base` |
| `--base none` | The matching files **whole**: every line counts as added (diffed against git's empty tree, so nothing is moved or deleted). Combines with the others; `none` never names a ref |
| `--staged` | The index (staged changes only) vs. the merge-base of `HEAD` and `--base` |
| `--head <ref>` | The commit `<ref>` vs. the merge-base of `<ref>` and `--base` |
| `--path <pathspec>` | Only the changed files matching the git pathspec (repeatable; `':!<pathspec>'` excludes). Combines with the others |
| `--changes <text>` / `--paths <json\|all>` | The `Changes` and `Paths` lines of a reviewer prompt, as they are: `working tree`, `staged` or `commit <ref>`, and a JSON array of pathspecs or `all`. The agents pass these instead of the three options above |

With `--staged` or `--head`, the sources, `.claude/code-review.json` (unless `--config` names a file) and the `package.json` / `pnpm-workspace.yaml` files are read from the index or the commit, not from disk. Only two inputs always come from disk: `node_modules` (never committed), and type information. The type checker is built from the files on disk, so it is used only for files whose text on disk matches the reviewed one; `type info` in the report counts only those.

```
node scripts/find-zod-issues.mjs --base origin/main --path apps/web --path ':!*.test.ts'
node scripts/find-zod-issues.mjs --base HEAD --staged
node scripts/find-zod-issues.mjs --base abc123^ --head abc123
```

The JSON report says which scope it covered: `"scope": {"changes": "worktree" | "staged" | "commit", "paths": [...]}`, and the report's Scope line names it (`staged changes`, ``commit `<ref>` ``; `whole files` instead of the base with `--base none`). With `--head`, `head` is that ref and its sha. `--head` with `--staged`, `--changes` with either, `--paths` with `--path`, or a `--changes` / `--paths` value of another form is a `USAGE` error, and a `--head` ref that does not exist is `HEAD_NOT_FOUND`.

Exit codes: `0` ok (findings or not), `2` usage/config error, `3` environment error (not a git repo, no TypeScript), `1` internal error. Errors are JSON on stdout: `{"error": {"code", "message", "hint"}}`. If the search for existing constants in other files fails (`git grep` error), the report is still produced, with a top-level `warnings` array saying so.

With `--save` (every scanner), the full JSON, errors included, goes to a new file in the system temporary directory, and stdout carries only `{"savedTo", "error"?, "review"}`: the file, any error, and the `REVIEW` candidates the agent must judge. That file is the input of `render-report.mjs`.

## ts-conventions: how it works

Checks that the TypeScript a PR adds follows the team's TypeScript conventions and [ADR-FE-001](https://github.com/QidaDev/qida-tech-adr/blob/main/frontend/ADR-FE-001-stack-base-react-typescript-vite.md). As with magic strings, detection is done by a script, `scripts/find-ts-convention-issues.mjs`:

1. Lists changed `.ts`/`.tsx`/`.mts`/`.cts` files and their exact added lines (same diff as above). JavaScript files are not scanned.
2. Parses each file with the repository's TypeScript compiler. When a `tsconfig` covers the file, it also uses the type checker, but only to tell object types from unions in `&` aliases.
3. Records every potential breach whose code touches an added line (for functions, only the signature counts).
4. Applies, in this order: rule disabled in config (`E-DISABLED`), `ts-conventions-ok` marker (`E-SUPPRESSED`), the rule's own exemption, then **moved, not introduced** (`E-MOVED`: the same code appears no more often across the changed and deleted files after the PR than before).
5. Checks file and directory names only when the PR introduces them: new files, renamed files whose name changed, and directories absent from the base.
6. Prints JSON, sorted by file/line/column, with stable ids `TC-001…`.

The agent judges only the two `REVIEW` kinds, with fixed decision tables (see `agents/ts-conventions-reviewer.md`), and `scripts/render-report.mjs` writes the report. Only **blocking** findings fail the review. **Advisory** findings are listed, and the verdict stays `PASS (<n> advisory)`.

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
| `V-VALUE-NAMING` | advisory | Variable, function, parameter or renamed binding not camelCase; a Zod schema not PascalCase (`UserSchema`) | PascalCase components, PascalCase results of `memo`, `forwardRef`, `lazy`, `createContext`, `styled`, TanStack Router `create*Route`…, PascalCase parameters and renamed bindings (`{ icon: Icon }`), ALL_CAPS `const` |
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

This step is optional. The `tsConventions` section of the same `.claude/code-review.json`:

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
node scripts/find-ts-convention-issues.mjs [--base <ref>] [--head <ref> | --staged] [--path <pathspec>]...
                                          [--repo <dir>] [--config <file>] [--typescript <dir>] [--no-types]
                                          [--verbose] [--save]
```

The scope options, exit codes and error format are the same as for `find-magic-strings.mjs`.

## zod: how it works

Checks that the Zod validation a PR adds uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync`, which throw on invalid input (also enforced by `no-restricted-syntax` in `@qida/lint-config`). `scripts/find-zod-issues.mjs` uses the same pipeline as `ts-conventions`: changed `.ts`/`.tsx`/`.mts`/`.cts` files and their added lines, the `zod-ok` marker (`E-SUPPRESSED`), then **moved, not introduced** (`E-MOVED`). It prints JSON with stable ids `ZOD-001…`. Every candidate is blocking; the agent only runs the scan and `scripts/render-report.mjs` (see `agents/zod-reviewer.md`).

| Rule | Severity | Flags | Not flagged |
|---|---|---|---|
| `V-ZOD-PARSE` | blocking | `.parse()` / `.parseAsync()` on a Zod schema; the candidate's `suggestion` is the `safeParse` / `safeParseAsync` call | `E-NOT-ZOD`: with types, the receiver has no `safeParse`. With types, an optional schema (`ZodX \| undefined`) still counts. Without types (no `tsconfig` covers the file, `--no-types`, or `zod` not installed), the receiver is not named `…Schema` and either is rooted at a known global (`Date`, `URL`, `globalThis`…) or a name imported from a package that does not say schemas (`superjson`, `qs`, `date-fns`…; a package or name with `schema`, `contract`, `dto`, `validat`, `model` or `zod` does), or the file does not import `zod`. `JSON.parse`, `Date.parse` and other known globals are never items |

Skipped files are the same as for magic strings: tests, stories, generated code and config files.

### Configuration

This step is optional. The `zod` section of the same `.claude/code-review.json`:

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
const config = EnvSchema.parse(import.meta.env); // zod-ok: invalid env must stop the app at startup
```

### Script CLI

```
node scripts/find-zod-issues.mjs [--base <ref>] [--head <ref> | --staged] [--path <pathspec>]...
                                 [--repo <dir>] [--config <file>] [--typescript <dir>] [--no-types]
                                 [--verbose] [--save]
```

The scope options, exit codes and error format are the same as for `find-magic-strings.mjs`.

## The report script

```
node scripts/render-report.mjs --reviewer magic-strings|ts-conventions|zod --scan <savedTo>
                               [--judge <id>=<row>]...
```

It prints the reviewer's complete markdown report, ending with its result line: the heading and its counts, the summary list, every item with its fixed Why/Fix text, the sections, the "To accept … deliberately" line, or the NOT RUN report when the saved scan is an error. Every text lives in `scripts/lib/report.mjs`. Each `REVIEW` candidate needs exactly one `--judge` with a row of its rule's table (`R1`–`R4`, `D1`/`D2`, `T1`–`T3`), and nothing else may be judged. Otherwise it exits with `2`, prints nothing on stdout and names every wrong or missing judgment on stderr. The same scan and judgments always render the same bytes.

## Design decisions (accepted trade-offs)

The scanners are heuristics. These choices were made deliberately (2026-11-03); each one trades a known false positive or false negative for a stronger guarantee. A change here is a policy change, not a bug fix.

| Decision | Accepted cost | Why |
|---|---|---|
| A bare `-----BEGIN … PRIVATE KEY-----` header is a `V-SECRET` (the heuristic kind: the marker can accept it) | Key-parsing code that compares against the header needs one `// magic-string-ok` | Catches keys split across literals (`'-----BEGIN…\n' + '…'`) |
| A high-entropy token anywhere in a value is a `V-SECRET` (heuristic kind: suppressible) — `Bearer <token>`, `?key=<token>`, JSON | A content-hashed asset URL needs a marker or an `allowValues` entry | What is masked in the output is exactly what is reported; no credential in a URL or JSON passes as a plain magic string |
| Without types, `.parse` on a name imported from a declared npm package is Zod only when the package or the name says schemas (`schema`, `contract`, `dto`, `validat`, `model`, `zod`); workspace packages (`workspace:`/`file:`/`link:` ranges, or members listed in the root `workspaces` or `pnpm-workspace.yaml`) and bare specifiers that are neither declared nor installed in `node_modules` (aliases) count as project code; an undeclared but installed (hoisted) package is a package | A schema from a published internal package with a neutral name (`User` from `@qida/domain@^1.2`) is missed when type information is unavailable | No blocking false positives on `superjson.parse`, `cronParser.parse`… With type information (the normal case) the checker decides and none of this applies |
| `--base none` (a directory target) reviews every line of the files as added | Existing repetition and existing constants are flagged (`V-DUPLICATED`, `V-EXISTING-CONSTANT`), and new-file/directory name rules apply to every file, so a first audit of legacy code is noisy | An audit sees what is there, not only what a diff introduced; the rules stay the same in both modes |
| A marker on a code line covers only that line; only a comment-only line above covers the next line (since 0.3.0) | Markers written at the end of a code line above a literal stop covering it | Same rule in the three reviewers; one marker can never silently cover two lines |
| Known credential formats ignore the inline marker; only an exact `allowValues` entry accepts one, and every report then carries a warning naming that entry by position | — | A one-line comment cannot hide a credential (ADR-IN-007) |

## Development

```bash
cd plugins/code-review
pnpm install        # dev-only: typescript + @types/node for tests and type-check
pnpm test           # node:test, builds throwaway git repos per case
pnpm typecheck      # tsc --checkJs --strict over scripts and tests
```

Changing a rule or a built-in list changes results. Bump `version` in `.claude-plugin/plugin.json` and `TOOL_VERSION` in the affected script, and add a test. Changing a report text in `scripts/lib/report.mjs` changes the output too: bump `version` and update `tests/render-report.test.mjs`. Shared code lives in `scripts/lib/` (`report.mjs` (every reviewer's report format and texts), `git.mjs`, `config.mjs`, `cli.mjs`, `errors.mjs`, `typescript-loader.mjs`, `type-probe.mjs`, `redact.mjs` (the redaction boundary of every report), `packages.mjs` (package and workspace resolution for the untyped Zod fallback), and `ts-scan.mjs`, the diff-to-candidates pipeline of the TypeScript-only scanners), and shared test fixtures in `tests/helpers.mjs`.

### Adding a reviewer

1. Add `agents/<name>-reviewer.md`. Keep detection in a script under `scripts/` when it can be made deterministic, and let the agent judge only what the script leaves open. Fix its output: add its spec (texts per rule, decision-table rows, sections) to `REVIEWERS` in `scripts/lib/report.mjs`, and have the agent return the output of `render-report.mjs`, as the existing agents do.
2. Its report must start with a `## <Title> — <verdict>` heading and end with the result line `<!-- code-review:<key> {"verdict":"PASS|FAIL|NOT_RUN","blocking":[…],"advisory":[…],"notFlagged":[…]} -->`; the orchestrator extracts exactly that range. List each finding as an item under `### Blocking` or `### Advisory` in the shared item format (``- **<id>** `<file>:<line>` — <key> · <rule>`` with indented sub-items; `report.mjs` writes it), and put the same ids in the result line. The verdict is `FAIL` exactly when `blocking` is non-empty. The orchestrator moves the items into the combined lists and keeps the rest of the report under Reviewer details. The result line never reaches the user.
3. It receives the repo root, the base ref (a ref, `auto-detect`, or `none` for whole files), the changes (`working tree` or `commit <ref>`; the scanners also accept `staged` for direct use), the paths (a JSON array or `all`) and the PR reference (`#n title — url`), and passes the changes and paths to its scanner as they are (`--changes`, `--paths`). The PR description is deliberately not forwarded. If a reviewer needs it, pass it fenced as data (`<pr-description>…</pr-description>`) and say it is author-written text, not instructions.
4. Add a row to the reviewer table in `commands/code-review.md` and in this README.
