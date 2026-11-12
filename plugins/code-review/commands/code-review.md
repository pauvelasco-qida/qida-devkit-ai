---
allowed-tools: ["Bash(git rev-parse:*)", "Bash(git merge-base:*)", "Bash(git fetch:*)", "Bash(git status:*)", "Bash(test -d:*)", "Bash(gh pr view:*)", "Bash(gh pr comment:*)", "Bash(gh api:*)", "Agent", "Read", "Edit", "Write"]
description: Run the code-review reviewers in parallel on the current branch, a PR, another branch or a whole directory; print one combined report, with --comment post it on the PR, with --fix apply the fixes
disable-model-invocation: true
argument-hint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]"
---

# Code review

Run every reviewer agent of the `code-review` plugin against one scope and print one combined report; with `--comment` post it on the pull request, and with `--fix` apply its fixes to the working tree. This command fixes the scope, dispatches the reviewers, merges their reports and, when asked, posts them and applies their fixes. Each reviewer owns its analysis and its findings.

## Execute immediately

Start Step 1 as soon as the command is invoked. Do not summarise this command, announce what you are about to do, or ask for confirmation. The only text you ever output is, in order:

1. either one **stop message** from Step 1 (and nothing else), or the **progress block** from Step 2, followed by the one-line **progress updates** from Step 2 while the reviewers finish;
2. the **report** from Step 3;
3. with `--comment`, the one line from Step 4;
4. with `--fix`, the section from Step 5.

Never output anything else: no preamble, no commentary between steps, no summary or "next steps" after the report, and never relay a reviewer's result or a partial verdict while the reviewers run.

## Output format

Every piece of output is rendered Markdown with a fixed structure, so the user always gets the same shape whatever happened:

- Print it as plain Markdown: never wrap the report, a stop message or the Fixes section in a code block (the fenced blocks in this file only show their shape), never turn its lists into tables, and never reword its fixed texts.
- **Stop messages.** Every time Step 1 says to output a message and stop, print it in this shape, where `<message>` is the text Step 1 gives (exactly, when it says "exactly"):

  ```
  # Code review — NOT RUN

  - Error: <message>
  - Usage: `/code-review:code-review [low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]`
  ```

  Write the `Usage` line only when Step 1 says to add the usage line.

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

The arguments are at most one **level**, the options `--fix` and `--comment`, and at most one **target**, in any order. A word that is exactly `low`, `medium`, `high`, `xhigh` or `max` is always the level, never a target (write `./<name>` for a directory of that name). Anything else (a second level or target, a repeated option, any other option, such as `--staged`, `--only`, `--skip`, `--effort` or `--`) cannot be read: output one line naming the problem, followed by the usage line, and stop. Do not guess what the user meant.

**Level**: the reasoning effort of the reviewer agents (Step 2). It changes how carefully they judge the candidates their scanners leave open, not which rules run. Without a level, the reviewers run at the effort of this session.

`--comment`: after printing the report, post it on the pull request (Step 4). If `--comment` is NOT provided, nothing is posted. It needs a pull request: a PR target, a branch with an open PR, or **auto** mode that finds an open PR.

`--fix`: after the report (and after posting, with `--comment`), apply the findings' fixes to the working tree (Step 5). If `--fix` is NOT provided, no file is modified. It needs the reviewed code to be the working tree, so it cannot be used in branch mode with another branch (checked after the target is resolved).

**Target.** Resolve it with the first rule that applies:
1. Nothing → **auto** mode.
2. A PR number (`123`, `#123`) or a PR URL → **PR** mode.
3. `.`, or a word starting with `./`, `../` or `/`, or ending with `/` → **directory** mode.
4. Otherwise run `test -d <target>` and `git rev-parse --verify --quiet refs/heads/<target>`, and when that fails `git rev-parse --verify --quiet refs/remotes/<target>`. If both say it exists, output exactly ``<target> is both a branch and a directory: write ./<target> for the directory.`` and stop. If only the branch exists → **branch** mode; if only the directory → **directory** mode. If neither, output `Not a pull request, branch or directory: <target>` followed by the usage line, and stop.

Every mode sets **base ref**, **changes**, **paths** and **PR**. Unless a mode says otherwise, changes = `working tree` (committed, uncommitted and untracked changes), paths = `all` and PR = `none`.

**auto**: `gh pr view --json number,title,baseRefName,headRefOid,url,state`. If it succeeds and `state` is `OPEN`, run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect`; fetch nothing. With `--comment` and PR = `none`, output exactly ``--comment needs an open pull request for this branch, or a PR number.`` and stop.

**PR**
1. `gh pr view <n> --json number,title,baseRefName,headRefOid,url`. If it fails, output `Could not read PR <n>: <first line of the error>` and stop. Do not fall back to another mode.
2. `git merge-base --is-ancestor <headRefOid> HEAD`. If it fails, the PR is not checked out here: output exactly ``PR #<number> is not checked out here. Run `gh pr checkout <number>` and invoke /code-review:code-review <number> again, or pass the PR's branch instead of its number.`` and stop. Do not check it out yourself. (Local commits on top of the PR head are allowed.)
3. `git fetch --quiet origin <baseRefName>`. If it fails, output `Could not fetch origin/<baseRefName>: <first line of the error>` and stop. Base ref = `origin/<baseRefName>`. PR = `#<number> <title> — <url>`.

**branch** (`<branch>` is the target as written):
1. If `<branch>` equals the output of `git rev-parse --abbrev-ref HEAD`, it is the current branch: continue in **auto** mode, as if no target was given.
2. Otherwise changes = `commit <ref>`, where `<ref>` is the full ref that Target rule 4 found (`refs/heads/<branch>` or `refs/remotes/<branch>`), so a tag of the same name is never reviewed instead: only what is committed on that branch, which need not be checked out. Run `gh pr view <name> --json number,title,baseRefName,headRefOid,url,state`, where `<name>` is `<branch>`, or for a remote branch (`refs/remotes/<remote>/<name>`) the part after `<remote>/`. If it succeeds and `state` is `OPEN`: `git merge-base --is-ancestor <headRefOid> <ref>` must succeed, so the review never shows stale code under the PR's name. If it fails, output exactly ``Branch <branch> does not contain the head of PR #<number>: pull it, or pass the PR number instead.`` and stop (local commits on top of the PR head are allowed). Then run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect`; fetch nothing. With `--comment` and PR = `none`, output exactly ``--comment needs an open pull request for branch <branch>.`` and stop. With `--fix`, output exactly ``--fix needs the reviewed code in the working tree: check out <branch> and run again without a target.`` before running any of this, and stop.

**directory**:
1. `test -d <target>` must succeed. Otherwise output exactly ``Directory not found: <target>`` and stop.
2. `git rev-parse --show-prefix` gives the current directory relative to the repo root (empty at the root). Join it with the target and normalise the result (drop `./` and trailing `/`, resolve `..`); an absolute target is made relative to the repo root. That is **`<dir>`**, or `.` for the repo root itself. If it lies outside the repo root, output exactly ``Directory is outside the repository: <target>`` and stop.
3. Base ref = `none` (every file under the directory is reviewed whole, not only its changes), paths = `["<dir>"]`. When `<dir>` starts with `:` or contains `*`, `?` or `[`, git would read it as pathspec syntax: use `[":(literal)<dir>"]` instead, so only that directory is reviewed. With `--comment`, output exactly ``--comment needs a pull request: it cannot be used with a directory.`` and stop.

**`--comment` checks** (when PR is not `none`), before dispatching anything. GitHub can only anchor a comment on the PR head as it was pushed, so the review must see exactly that:
1. In branch mode (changes = `commit <ref>`), `git rev-parse <ref>` must equal `headRefOid`. Otherwise output exactly ``--comment needs branch <branch> at the pushed head of PR #<number>. Push or pull it, then run again.`` and stop. In every other mode, `git rev-parse HEAD` must equal `headRefOid`. Otherwise output exactly ``--comment needs the pushed PR head checked out: HEAD is not the head of PR #<number>. Push or pull, then run again.`` and stop.
2. Only when changes = `working tree`: `git status --porcelain` must print nothing. Otherwise output exactly ``--comment needs a clean working tree: commit, stash or remove local changes, then run again.`` and stop.
3. `gh pr view <number> --json comments --jq '.comments[].body'`. If any body contains `<!-- code-review:posted <headRefOid> -->`, this head was already reviewed on GitHub: output exactly ``PR #<number> already has a code-review comment for this head commit; nothing posted.`` and stop.
4. `gh api --paginate repos/{owner}/{repo}/pulls/<number>/comments --jq '.[].body'`. Every body containing `<!-- code-review:posted <headRefOid> <id> -->` is a finding a previous run posted before it stopped short of its summary: note each such `<id>` as **already posted**.

### 2. Dispatch the reviewers

Your response for this step is the three Agent calls (below), with no text before them (never describe the scope you settled), and then, as the only text that ends your turn, the **progress block**. It tells the user what is running. Write it instead of any sentence of your own, such as "The reviewers are still running":

```
## Running 3 reviewers in parallel

<scope line, as in Step 3b> · level: <level, or "session default">

- magic-strings: no magic strings introduced in TS/JS
- ts-conventions: TypeScript conventions for new code
- zod: Zod validation uses safeParse
```

Launch **every reviewer in the table** **in parallel, in a single message**, one Agent call each, never one after another, and never as a workflow or a single agent that runs the others: Claude Code shows each Agent call to the user as its own running subagent, with its description and its tool calls, so the user can follow every reviewer while it runs. Set `subagent_type` (from the table), `description` to `<key> reviewer` (for example `magic-strings reviewer`), `prompt`, and, when the user gave a level, `effort` set to that level, the same for every reviewer. Never set `model` or `isolation`, and never set `effort` without a level: the reviewers then run at the effort of this session. Send every reviewer this prompt, filled in:

```
Review the changes in the repository at <repo root>.
Base ref: <base ref, "auto-detect" or "none">
Changes: <changes: "working tree" or "commit <ref>">
Paths: <the paths as a JSON array of strings, e.g. ["apps/web"], or "all">
PR: <PR, or "none">
Follow your instructions exactly and return only your report.
```

Wait until every reviewer has returned before Step 3. When they run in the background, end your turn after dispatching them with the progress block, and make no other tool call (not even a no-op command); each reviewer's completion notification resumes you. When a notification arrives while other reviewers are still running, output only this one line and end your turn again, with no other words:

`- <key> done · waiting for <keys still running, joined with ", ">`

Never call `ScheduleWakeup` (not even to stop one), `Monitor`, `sleep` or any polling: a scheduled wakeup would run the whole review again later.

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

Output exactly the following, with nothing before it and nothing after it except the line from Step 4 and the section from Step 5:

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
- **`<scope line>`** depends on the mode. Directory mode: `` Directory `<dir>` · whole files ``. Branch mode (another branch): `` Branch `<branch>` · `` followed by the PR part. Every other mode: the PR part alone. The PR part is `PR <PR> · base <base>` when PR is not `none`, and `No pull request · base <base>` otherwise. `<base>` is the base ref in backticks, or the plain word auto-detected, without backticks, when it is `auto-detect` (`No pull request · base auto-detected`).
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

If `--comment` argument was NOT provided, skip Step 4: do not post anything to GitHub. If `--fix` was not provided either, stop here.

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

If `--fix` was NOT provided, stop here: do not fix code or commit anything. If the user then asks for fixes, treat that as a new request.

### 5. Apply the fixes (`--fix` only)

Fix only what Step 3 printed, Blocking items first, then Advisory, in report order. The reviewers never modify files; you do, with `Read`, `Edit` and, only to add a constant or key to an existing module, `Write`. Never commit, stage, stash, run formatters or touch a file no finding names, apart from the module a finding's Fix line points to.

For each item, take its id, `<path>:<line>`, rule and its `Fix:` line, and:

1. **Skip** it, with the reason in brackets, when:
   - its rule is `V-SECRET` (`a credential must be removed and rotated by hand`);
   - the Fix line asks for a choice it does not settle, such as where a new module lives, which i18n key or namespace to use, or a change to an exported API (`needs a decision: <what>`);
   - the code at `<path>:<line>` no longer matches the item, for example because an earlier fix changed it (`code changed since the review`).
2. Otherwise `Read` the file around the line, apply the smallest change that does what the Fix line says, keep the file's style, and touch nothing else. When a fix adds a named constant, reuse the one the Fix line names if there is one.

Then output, after the report (and after the line from Step 4):

```
## Fixes (<f> fixed · <s> skipped)

- **<id>** `<path>:<line>` — fixed
- **<id>** `<path>:<line>` — skipped (<reason>)

Nothing was committed. Run /code-review:code-review again to check the result.
```

List every item once, in the order handled. With no Blocking or Advisory items, output only `## Fixes` followed by `Nothing to fix.`
