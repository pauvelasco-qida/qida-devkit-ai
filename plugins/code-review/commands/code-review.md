---
allowed-tools: ["Bash(git rev-parse:*)", "Bash(git merge-base:*)", "Bash(git fetch:*)", "Bash(git status:*)", "Bash(test -d:*)", "Bash(gh pr view:*)", "Bash(gh pr comment:*)", "Bash(gh api:*)", "Agent"]
description: Run the code-review reviewers on the current branch, a PR, another branch or a whole directory; print one combined report and, with --comment, post it on the PR
disable-model-invocation: true
argument-hint: "[PR | branch | directory] [--comment]"
---

# Code review

Run every reviewer agent of the `code-review` plugin against one scope and print one combined report, and with `--comment` post it on the pull request. This command only fixes the scope, dispatches the reviewers, merges their reports and, when asked, posts them. Each reviewer owns its analysis and its findings.

## Execute immediately

Start Step 1 as soon as the command is invoked. Do not summarise this command, announce what you are about to do, or ask for confirmation. The only text you output is one stop message from Step 1, or the report from Step 3 followed, with `--comment`, by the one line from Step 4. While the reviewers run, you may only say that they are running: never relay a reviewer's result or a partial verdict.

## Reviewers

| Key | Agent (`subagent_type`) | What it checks |
|---|---|---|
| `magic-strings` | `code-review:magic-string-reviewer` | No magic strings introduced in TS/JS (ADR-FE-002, ADR-FE-004) |
| `ts-conventions` | `code-review:ts-conventions-reviewer` | New TypeScript follows the conventions (ADR-FE-001); only blocking rules fail |
| `zod` | `code-review:zod-reviewer` | New Zod validation uses `safeParse` / `safeParseAsync`, never `parse` / `parseAsync` |

## Steps

### 1. Fix the scope

Reviewers compare **the changes** with a **base ref** (through their merge-base), optionally limited to some **paths**. A base ref of `none` makes them review the files whole. Read the arguments the user gave (`$ARGUMENTS`, possibly empty) and settle each value below.

`git rev-parse --show-toplevel` gives the **repo root**. If it fails, output `Not inside a git repository.` and stop.

The arguments are at most one **target** and the option `--comment`, in any order. Anything else (a second target, any other option, such as `--staged`, `--only`, `--skip`, `--effort` or `--`) cannot be read: output one line naming the problem, followed by `Usage: /code-review:code-review [PR | branch | directory] [--comment]`, and stop. Do not guess what the user meant.

`--comment`: after printing the report, post it on the pull request (Step 4). If `--comment` is NOT provided, nothing is posted. It needs a pull request: a PR target, a branch with an open PR, or **auto** mode that finds an open PR.

**Target.** Resolve it with the first rule that applies:
1. Nothing → **auto** mode.
2. A PR number (`123`, `#123`) or a PR URL → **PR** mode.
3. `.`, or a word starting with `./`, `../` or `/`, or ending with `/` → **directory** mode.
4. Otherwise run `test -d <target>` and `git rev-parse --verify --quiet refs/heads/<target>`, and when that fails `git rev-parse --verify --quiet refs/remotes/<target>`. If both say it exists, output exactly ``<target> is both a branch and a directory: write ./<target> for the directory.`` and stop. If only the branch exists → **branch** mode; if only the directory → **directory** mode. If neither, output `Not a pull request, branch or directory: <target>` followed by the usage line, and stop.

Every mode sets **base ref**, **changes**, **paths** and **PR**. Unless a mode says otherwise, changes = `working tree` (committed, uncommitted and untracked changes), paths = `all` and PR = `none`.

**auto**: `gh pr view --json number,title,baseRefName,headRefOid,url,state`. If it succeeds and `state` is `OPEN`, run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect`; fetch nothing. With `--comment` and PR = `none`, output exactly ``--comment needs an open pull request for this branch, or a PR number.`` and stop.

**PR**
1. `gh pr view <n> --json number,title,baseRefName,headRefOid,url`. If it fails, output `Could not read PR <n>: <first line of the error>` and stop. Do not fall back to another mode.
2. `git merge-base --is-ancestor <headRefOid> HEAD`. If it fails, the PR is not checked out here: output exactly ``PR #<number> is not checked out here. Run `gh pr checkout <number>` and invoke /code-review:code-review <number> again.`` and stop. Do not check it out yourself. (Local commits on top of the PR head are allowed.) Instead of checking it out, the user can also pass the PR's branch.
3. `git fetch --quiet origin <baseRefName>`. If it fails, output `Could not fetch origin/<baseRefName>: <first line of the error>` and stop. Base ref = `origin/<baseRefName>`. PR = `#<number> <title> — <url>`.

**branch** (`<branch>` is the target as written):
1. If `<branch>` equals the output of `git rev-parse --abbrev-ref HEAD`, it is the current branch: continue in **auto** mode, as if no target was given.
2. Otherwise changes = `commit <branch>`: only what is committed on that branch, which need not be checked out. Run `gh pr view <name> --json number,title,baseRefName,headRefOid,url,state`, where `<name>` is `<branch>`, or for a remote branch (`refs/remotes/<remote>/<name>`) the part after `<remote>/`. If it succeeds and `state` is `OPEN`, run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect`; fetch nothing. With `--comment` and PR = `none`, output exactly ``--comment needs an open pull request for branch <branch>.`` and stop.

**directory**:
1. `test -d <target>` must succeed. Otherwise output exactly ``Directory not found: <target>`` and stop.
2. `git rev-parse --show-prefix` gives the current directory relative to the repo root (empty at the root). Join it with the target and normalise the result (drop `./` and trailing `/`, resolve `..`); an absolute target is made relative to the repo root. That is **`<dir>`**, or `.` for the repo root itself. If it lies outside the repo root, output exactly ``Directory is outside the repository: <target>`` and stop.
3. Base ref = `none` (every file under the directory is reviewed whole, not only its changes), paths = `["<dir>"]`. With `--comment`, output exactly ``--comment needs a pull request: it cannot be used with a directory.`` and stop.

**`--comment` checks** (when PR is not `none`), before dispatching anything. GitHub can only anchor a comment on the PR head as it was pushed, so the review must see exactly that:
1. `git rev-parse HEAD` must equal `headRefOid`. Otherwise output exactly ``--comment needs the pushed PR head checked out: HEAD is not the head of PR #<number>. Push or pull, then run again.`` and stop.
2. `git status --porcelain` must print nothing. Otherwise output exactly ``--comment needs a clean working tree: commit, stash or remove local changes, then run again.`` and stop.
3. `gh pr view <number> --json comments --jq '.comments[].body'`. If any body contains `<!-- code-review:posted <headRefOid> -->`, this head was already reviewed on GitHub: output exactly ``PR #<number> already has a code-review comment for this head commit; nothing posted.`` and stop.
4. `gh api --paginate repos/{owner}/{repo}/pulls/<number>/comments --jq '.[].body'`. Every body containing `<!-- code-review:posted <headRefOid> <id> -->` is a finding a previous run posted before it stopped short of its summary: note each such `<id>` as **already posted**.

### 2. Dispatch the reviewers

Launch **every reviewer in the table** **in parallel, in a single message**, one Agent call each. Set only `subagent_type` (from the table), `description` and `prompt`. Never set `model`, `effort` or `isolation`: the reviewers run at the effort of this session. Send every reviewer this prompt, filled in:

```
Review the changes in the repository at <repo root>.
Base ref: <base ref, "auto-detect" or "none">
Changes: <changes: "working tree" or "commit <branch>">
Paths: <the paths as a JSON array of strings, e.g. ["apps/web"], or "all">
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
- Fix: Run /code-review:code-review again.
```

#### 3b. Print the combined report

Output exactly the following, with nothing before it and nothing after it except the line from Step 4:

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
- **`<scope line>`** depends on the mode. Directory mode: `` Directory `<dir>` · whole files ``. Branch mode (another branch): `` Branch `<branch>` · `` followed by the PR part. Every other mode: the PR part alone. The PR part is `PR <PR> · base <base>` when PR is not `none`, and `No pull request · base <base>` otherwise. `<base>` is the base ref in backticks, or `auto-detected` when it is `auto-detect`.
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

If `--comment` argument was NOT provided, stop here. Do not post anything to GitHub.

### 4. Post on the pull request (`--comment` only)

Post only what Step 3 printed; never add, reword or drop a finding. Use `gh` for every call, passing each body through a quoted heredoc (`<<'EOF'`) so nothing in it is expanded by the shell.

1. **One inline comment per finding**, Blocking items first, in report order. The item's first line gives its `<path>:<line>`. Post it on the PR head:

   ```
   gh api repos/{owner}/{repo}/pulls/<number>/comments --input - <<'EOF'
   {"commit_id": "<headRefOid>", "path": "<path>", "line": <line>, "side": "RIGHT", "body": "<body>"}
   EOF
   ```

   `<body>` is the item text with its leading `- ` removed and its sub-items unindented, preceded by `**Blocking** · ` or `**Advisory** · ` and followed by a blank line and `<!-- code-review:posted <headRefOid> <id> -->` (`<id>` the finding id), as a JSON string. Post one comment per finding id, never two, and skip every id noted as already posted in check 4. If a call fails (for example the line is not part of the PR diff), do not retry it: keep the finding for the summary.
2. **One summary comment**, posted last:

   ```
   gh pr comment <number> --body-file - <<'EOF'
   <summary>
   EOF
   ```

   `<summary>` is, in this order: the report's first line made a `##` heading (`## Code review — FAIL (2 blocking)`); the scope line; the reviewer lines; when some inline comments failed, a `### Not anchored (<n>)` section holding those items as printed in the report; when no finding was reported at all, the line `No issues found. Checked: <keys of the reviewers that ran, joined with ", ">.`; and last the line `<!-- code-review:posted <headRefOid> -->`.
3. Output one line after the report: ``Posted on PR #<number>: <i> inline comments, 1 summary comment.``, adding ``, <n> not anchored (in the summary)`` when some inline comments failed and ``, <k> already posted`` when check 4 found some. If the summary comment itself fails, output ``Could not post the summary on PR #<number>: <first line of the error>`` instead.

Do not fix code or commit anything. If the user then asks for fixes, treat that as a new request.
