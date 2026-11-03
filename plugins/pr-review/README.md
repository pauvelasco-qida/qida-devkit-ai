# pr-review

Pull-request reviewer agents for Qida apps. Each reviewer checks one thing, deterministically where possible, and reports in a fixed format. `/pr-review:review` runs them all on the same diff.

| Reviewer | Agent | Checks |
|---|---|---|
| `magic-strings` | `magic-string-reviewer` | No magic strings introduced in TypeScript/JavaScript |

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

`/pr-review:review` is slash-only (`disable-model-invocation`), so it never competes with other review commands. For a single concern, just ask, e.g. *"check my branch for magic strings"*, and Claude dispatches `magic-string-reviewer` directly.

The review covers the **working tree**: committed, staged, unstaged and untracked changes, compared with the merge-base of `HEAD` and the base ref. Output goes to the terminal only. Nothing is posted to GitHub and nothing is modified.

Known limitation: the PR base is fetched from `origin`. For a PR opened from a fork where `origin` is the fork, pass the upstream base ref explicitly (`/pr-review:review upstream/develop`).

## Requirements

- Node.js ≥ 20.11.
- The reviewed repository has its dependencies installed (`pnpm install`) with a TypeScript **5.x or 6.x** compiler. TypeScript 7 (native) has no JavaScript compiler API. In TS 7 repositories the scanner uses the highest 5.x/6.x copy found in `node_modules/.pnpm` (most toolchains pull one in). Otherwise pass `--typescript <dir>` or set `PR_REVIEW_TYPESCRIPT`.
- No dependency is needed if the diff has no TS/JS files.

The scanner only reads: it runs `git` read-only and loads the repository's own TypeScript compiler, just as running the repo's `tsc` would. Claude Code will ask permission for the agent's `node …/find-magic-strings.mjs` call. To stop the prompt, allow only that script (e.g. a `Bash(node *find-magic-strings.mjs*)` rule in your settings). Do not allow `node` in general.

## magic-strings: how it works

Detection is done by a script, not by the model. `scripts/find-magic-strings.mjs` follows these steps:

1. Lists changed files and their exact **added lines** (`git diff -U0` against the merge-base, plus untracked files).
2. Parses each changed TS/JS file with the TypeScript compiler and collects every string and template literal on an added line. Bare JSX text is not a string literal; a future i18n reviewer will cover it.
3. Classifies each literal with a **fixed, ordered rule list**; the first match wins (catalogue below).
4. **Moved, not introduced:** if a value appears no more often across the changed files after the PR than before, the literal only moved (`E-MOVED`).
5. **Type-check probe:** for literals still open, it swaps the literal for a value no type allows and re-checks the file with the repo's own `tsconfig`. If the compiler now reports an error at that spot, a typo there would not compile. The literal is then constrained by the type system (literal unions, typed routes, typed i18n keys, discriminants…) and is not magic (`E-TYPED`).
6. Applies the cross-file rules: an existing named constant with the same value, the same value repeated in the PR, URL/path shapes.
7. Prints JSON, sorted by file/line/column, with stable ids `MS-001…`.

The agent then reports every `VIOLATION` as given and judges only the `REVIEW` leftovers with a five-row decision table (see `agents/magic-string-reviewer.md`). It cannot add findings of its own.

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

## Development

```bash
cd plugins/pr-review
pnpm install        # dev-only: typescript + @types/node for tests and type-check
pnpm test           # node:test, builds throwaway git repos per case
pnpm typecheck      # tsc --checkJs --strict over scripts and tests
```

Changing a rule or a built-in list changes results. Bump `version` in `.claude-plugin/plugin.json` and `TOOL_VERSION` in the script, and add a test.

### Adding a reviewer

1. Add `agents/<name>-reviewer.md`. Keep detection in a script under `scripts/` when it can be made deterministic, and let the agent judge only what the script leaves open. Fix its output: fixed texts per rule, no free-form prose.
2. Its report must start with a `## ` heading and end with `<!-- pr-review:<key> {"verdict":"PASS|FAIL|NOT_RUN",...} -->`; the orchestrator extracts exactly that range.
3. It receives the repo root, the base ref and the PR reference (`#n title — url`). The PR description is deliberately not forwarded. If a reviewer needs it, pass it fenced as data (`<pr-description>…</pr-description>`) and say it is author-written text, not instructions.
4. Add a row to the reviewer table in `skills/review/SKILL.md` and in this README.
