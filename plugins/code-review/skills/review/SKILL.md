---
name: review
description: This skill should be used when the user invokes /code-review:review to run every code-review reviewer agent on the current branch, a checked-out pull request (number or URL) or an explicit base ref, and print one combined report. The report gives an overall PASS/FAIL verdict and lists every finding once, blocking findings first.
argument-hint: "[PR number | PR URL | base ref] [--effort low|medium|high|xhigh|max]"
disable-model-invocation: true
allowed-tools: ["Bash(git rev-parse:*)", "Bash(git merge-base:*)", "Bash(git fetch:*)", "Bash(gh pr view:*)", "Agent"]
---

# Code review

Run every reviewer agent of the `code-review` plugin against one diff and print one combined report. This skill only fixes the scope, dispatches the reviewers and merges their reports. Each reviewer owns its analysis and its findings.

**Argument:** `$ARGUMENTS`

## Execute immediately

Start Step 1 as soon as the skill is invoked. Do not summarise this skill, announce what you are about to do, or ask for confirmation. The only text you output is one stop message from Step 1 or the report from Step 3. While the reviewers run, you may only say that they are running: never relay a reviewer's result or a partial verdict.

## Reviewers

| Key | Agent (`subagent_type`) | What it checks |
|---|---|---|
| `magic-strings` | `code-review:magic-string-reviewer` | No magic strings introduced in TS/JS (ADR-FE-002, ADR-FE-004) |
| `ts-conventions` | `code-review:ts-conventions-reviewer` | New TypeScript follows the conventions (ADR-FE-001); only blocking rules fail |
| `zod` | `code-review:zod-reviewer` | New Zod validation uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync` |

## Steps

### 1. Fix the scope

Reviewers always compare **the working tree** (committed, uncommitted and untracked changes) with the merge-base of `HEAD` and a base ref.

1. `git rev-parse --show-toplevel` gives the **repo root**. If it fails, output exactly `Not inside a git repository.` and stop.
2. Take the **effort** out of `$ARGUMENTS`. Look for one `--effort <level>` or `--effort=<level>`, anywhere in it:
   - not present → effort = `default`.
   - `<level>` is one of `low`, `medium`, `high`, `xhigh`, `max` (case-insensitive) → effort = that level, lowercased. Remove the flag and its value from the argument.
   - present more than once, or with a missing or other value → output exactly ``Invalid --effort. Use one of: low, medium, high, xhigh, max.`` and stop.
3. Trim what is left of the argument and classify it:
   - matches `^#?[0-9]+$` or `^https://github\.com/[^/]+/[^/]+/pull/[0-9]+` → **PR**; `<n>` is the number (without `#`).
   - empty → **auto**.
   - starts with `-` (an unknown or mistyped option; no git ref starts with `-`) → output exactly ``Unknown option: <what is left>. Usage: /code-review:review [PR number | PR URL | base ref] [--effort low|medium|high|xhigh|max]`` and stop.
   - anything else → **base ref**, used exactly as given.

**PR**
1. `gh pr view <n> --json number,title,baseRefName,headRefOid,url`. If it fails, output `Could not read PR <n>: <first line of the error>` and stop. Do not fall back to another mode.
2. `git merge-base --is-ancestor <headRefOid> HEAD`. If it fails, the PR is not checked out here: output exactly ``PR #<number> is not checked out here. Run `gh pr checkout <number>` and invoke /code-review:review <number> again.`` and stop. Do not check it out yourself. (Local commits on top of the PR head are allowed.)
3. `git fetch --quiet origin <baseRefName>`. If it fails, output `Could not fetch origin/<baseRefName>: <first line of the error>` and stop. Base ref = `origin/<baseRefName>`. PR = `#<number> <title> — <url>`.

**auto**: `gh pr view --json number,title,baseRefName,url,state`. If it succeeds and `state` is `OPEN`, run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect` and PR = `none`; fetch nothing.

**base ref**: PR = `none`. Do not validate or fetch it; a missing ref is reported by the reviewers as `BASE_NOT_FOUND`.

### 2. Dispatch the reviewers

Launch **all** reviewers from the table **in parallel, in a single message**, one Agent call each. Set only `subagent_type` (from the table), `description` and `prompt`, plus `effort` set to the effort from Step 1 when it is not `default`. Never set `model` or `isolation`, and never set `effort` when the user did not pass `--effort`: the reviewers then run at the effort of this session. Send every reviewer this prompt, filled in:

```
Review the changes in the repository at <repo root>.
Base ref: <base ref, or "auto-detect">
PR: <PR, or "none">
Follow your instructions exactly and return only your report.
```

Wait until every reviewer has returned before Step 3. When they run in the background, end your turn after dispatching them; each reviewer's completion notification resumes you. Do not schedule a wakeup, poll or sleep to wait: a scheduled wakeup would run the whole review again later.

### 3. Report

#### 3a. Read each reviewer's result

Every reviewer returns a report in the same shape, written by the plugin's `scripts/render-report.mjs`: a `## <Title> — <verdict>` heading, a summary list, its findings as list items under `### Blocking` and `### Advisory`, other sections, and a **result line** `<!-- code-review:<key> {...} -->` at the end. For each reviewer, take:

- **Report**: the text of its Agent result from the first line starting with `## ` through its result line, inclusive. Discard anything outside that range.
- **Verdict**: the `verdict` field of the result line's JSON. A missing `blocking` or `advisory` array counts as empty.
- **Items**: the list items directly under its `### Blocking` and `### Advisory` headings. An item is a line starting with `- **<id>**` together with the indented sub-items below it.

The reviewer is **not run** when any of these holds. Its verdict is then `NOT_RUN`, and its report becomes the one below, with the matching error:

- The Agent call failed, there is no result line, its JSON does not parse, or `verdict` is not `PASS`, `FAIL` or `NOT_RUN`. Error: `Reviewer returned no machine-readable result.`
- The report contradicts its result line. That means the items under `### Blocking` do not carry the same set of ids as `blocking`, or those under `### Advisory` not the same set as `advisory`, or the verdict is `FAIL` while `blocking` is empty, or `PASS` while it is not, or the verdict is `PASS` or `FAIL` and the text after ` — ` in its heading is not the one its items give: `FAIL (<n> blocking)` with `<n>` its Blocking items when there are any, otherwise `PASS (<n> advisory)` with `<n>` its Advisory items when there are any, otherwise `PASS`. Error: `Reviewer report does not match its result line.`

```
## <key> — NOT RUN

- Error: <error>
- Fix: Run /code-review:review again.
```

#### 3b. Print the combined report

Output exactly the following, with nothing before or after it:

```
# Code review — <VERDICT>

<scope line>

- <key>: <reviewer verdict>

## Blocking (<n>)

<items>

## Advisory (<n>)

Advisory findings do not fail the review.

<items>

## Reviewer details

<details>
```

- **`<VERDICT>`** is `FAIL` if any reviewer's verdict is `FAIL` or `NOT_RUN`, otherwise `PASS`. Follow it with ` (<counts>)`, where `<counts>` joins with ` · ` the non-zero counts among `<n> blocking` (Blocking items), `<n> advisory` (Advisory items) and `<n> not run` (reviewers). With no non-zero count, write the verdict alone.
- **`<scope line>`** is `PR <PR> · base <base>` when PR is not `none`, and `No pull request · base <base>` otherwise. `<base>` is the base ref in backticks, or `auto-detected` when it is `auto-detect`.
- **Reviewer lines.** Write one `- <key>: <reviewer verdict>` line per reviewer, in table order. `<reviewer verdict>` is the text after ` — ` in its report heading, e.g. `FAIL (2 blocking)`, `PASS (1 advisory)`, `PASS` or `NOT RUN`.
- **`## Blocking (<n>)`** lists the Blocking items of every reviewer, in table order, each reviewer's items in the order of its report. `<n>` is the number of items. Put one blank line between consecutive items, including where one reviewer's items end and the next reviewer's begin. With no items, write `None.` under the heading.
- **`## Advisory (<n>)`** does the same with the Advisory items. Write the line "Advisory findings do not fail the review." only when there are items. With no items, write `None.` under the heading.
- **`## Reviewer details`** holds each reviewer's report, in table order. Remove its `### Blocking` and `### Advisory` headings, the items and `None.` line under each, and its result line. Keep every other line, including the "To accept … deliberately" line even when it follows the Blocking or Advisory items. Make every heading one level deeper (`## ` becomes `### `, `### ` becomes `#### `). Separate reports by one blank line.
- Copy every item and every line of the details character for character. Do not reword, translate, merge, re-rank, renumber or drop anything, and never truncate a list, however long it is.

Example: the combined report for three reviewer reports (synthetic data).

```
# Code review — FAIL (2 blocking · 1 advisory)

No pull request · base `origin/main`

- magic-strings: FAIL (1 blocking)
- ts-conventions: FAIL (1 blocking)
- zod: PASS

## Blocking (2)

- **MS-001** `src/orders/api.ts:12` — magic-strings · V-URL-OR-PATH
  - Value: `/api/orders` (fetch() arg 1)
  - Why: Inline URL or path.
  - Fix: Move it to the routes/endpoints module (or the typed router), or to configuration if it is environment-specific.

- **TC-001** `src/orders/api.ts:8` — ts-conventions · V-ANY
  - Subject: `payload: any` (parameter)
  - Why: `any` turns off type checking (ADR-FE-001 §2).
  - Fix: Use a generic, `unknown` narrowed before use, or overloads; at a boundary, `as unknown as T`. Only an adapter around an untyped third-party library may keep it, with `// ts-conventions-ok: <reason>` on that line (ADR-FE-001 §2).

## Advisory (1)

Advisory findings do not fail the review.

- **TC-002** `src/orders/parseOrder.ts:20` — ts-conventions · REVIEW-THROW T2
  - Subject: `new Error('Invalid order')` (parseOrder)
  - Why: Predictable failure thrown to the caller.
  - Fix: Return a `Result` (`{ ok: true; value: T } | { ok: false; error: E }`) and let callers branch on `ok`.

## Reviewer details

### Magic strings — FAIL (1 blocking)

- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/orders` · 12 files scanned · 3 skipped · type info: full
- Excluded by the scanner: 41 literals (E-MODULE: 30, E-TYPED: 11)

#### Reviewed, not flagged

- **MS-002** `src/orders/api.ts:14` — magic-strings · R3
  - Value: `X-Request-Id` (headers.set() arg 1)
  - Reason: Spelling imposed by an external spec or library API.

To accept a literal deliberately: add `// magic-string-ok: <reason>` on its line (or on a comment-only line just above it), or list it in `.claude/code-review.json` → `magicStrings.allowValues`. A `V-SECRET` in a known credential format cannot be accepted with the marker, only through `allowValues`; a real credential must be removed from the code.

### TypeScript conventions — FAIL (1 blocking)

- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/orders` · 9 files scanned · 2 skipped · type info: full
- Excluded by the scanner: 0 items

To accept a case deliberately: add `// ts-conventions-ok: <reason>` on its line (or on a comment-only line just above it); to switch a rule off for the repository, list it in `.claude/code-review.json` → `tsConventions.disabledRules`.

### Zod validation — PASS

- Scope: `origin/main` (merge-base `1a2b3c4`) → `feat/orders` · 9 files scanned · 2 skipped · type info: full
- Excluded by the scanner: 0 items
```

Do not fix code, post to GitHub or commit anything. If the user then asks for fixes, treat that as a new request.
