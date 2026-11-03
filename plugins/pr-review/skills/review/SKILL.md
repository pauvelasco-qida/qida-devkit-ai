---
name: review
description: This skill should be used when the user invokes /pr-review:review to run every pr-review reviewer agent on the current branch, a checked-out pull request (number or URL) or an explicit base ref, and print each reviewer's report plus an overall PASS/FAIL verdict.
argument-hint: "[PR number | PR URL | base ref]"
disable-model-invocation: true
allowed-tools: ["Bash(git rev-parse:*)", "Bash(git merge-base:*)", "Bash(git fetch:*)", "Bash(gh pr view:*)", "Agent"]
---

# PR review

Run every reviewer agent of the `pr-review` plugin against one diff and print their reports. This skill only fixes the scope, dispatches the reviewers and aggregates their verdicts; each reviewer owns its analysis and its report.

**Argument:** `$ARGUMENTS`

## Execute immediately

Start Step 1 as soon as the skill is invoked. Do not summarise this skill, announce what you are about to do, or ask for confirmation. The only text you output is one stop message from Step 1 or the report from Step 3.

## Reviewers

| Key | Agent (`subagent_type`) | What it checks |
|---|---|---|
| `magic-strings` | `pr-review:magic-string-reviewer` | No magic strings introduced in TS/JS (ADR-FE-002, ADR-FE-004) |

## Steps

### 1. Fix the scope

Reviewers always compare **the working tree** (committed, uncommitted and untracked changes) with the merge-base of `HEAD` and a base ref.

1. `git rev-parse --show-toplevel` gives the **repo root**. If it fails, output exactly `Not inside a git repository.` and stop.
2. Trim `$ARGUMENTS` and classify it:
   - matches `^#?[0-9]+$` or `^https://github\.com/[^/]+/[^/]+/pull/[0-9]+` → **PR**; `<n>` is the number (without `#`).
   - empty → **auto**.
   - anything else → **base ref**, used exactly as given.

**PR**
1. `gh pr view <n> --json number,title,baseRefName,headRefOid,url`. If it fails, output `Could not read PR <n>: <first line of the error>` and stop. Do not fall back to another mode.
2. `git merge-base --is-ancestor <headRefOid> HEAD`. If it fails, the PR is not checked out here: output exactly ``PR #<number> is not checked out here. Run `gh pr checkout <number>` and invoke /pr-review:review <number> again.`` and stop. Do not check it out yourself. (Local commits on top of the PR head are allowed.)
3. `git fetch --quiet origin <baseRefName>`. If it fails, output `Could not fetch origin/<baseRefName>: <first line of the error>` and stop. Base ref = `origin/<baseRefName>`. PR = `#<number> <title> — <url>`.

**auto**: `gh pr view --json number,title,baseRefName,url,state`. If it succeeds and `state` is `OPEN`, run PR step 3 with its `baseRefName`, and PR = `#<number> <title> — <url>`. Otherwise base ref = `auto-detect` and PR = `none`; fetch nothing.

**base ref**: PR = `none`. Do not validate or fetch it; a missing ref is reported by the reviewers as `BASE_NOT_FOUND`.

### 2. Dispatch the reviewers

Launch **all** reviewers from the table **in parallel, in a single message**, one Agent call each. Set only `subagent_type` (from the table), `description` and `prompt`: no model override, no background run. Send every reviewer this prompt, filled in:

```
Review the changes in the repository at <repo root>.
Base ref: <base ref, or "auto-detect">
PR: <PR, or "none">
Follow your instructions exactly and return only your report.
```

Wait for every reviewer to finish before Step 3.

### 3. Report

For each reviewer, its **report** is the text of its Agent result from the first line starting with `## ` through the last line matching `<!-- pr-review:<key> {...} -->`, inclusive; discard anything outside that range. Its **verdict** is the `verdict` field of that line's JSON.

If the Agent call failed, or there is no such line, or its JSON does not parse, or `verdict` is not `PASS`, `FAIL` or `NOT_RUN`, use verdict `NOT_RUN` and this report:

```
## <key> — NOT RUN
Reviewer returned no machine-readable result.
<!-- pr-review:<key> {"verdict":"NOT_RUN"} -->
```

Then output exactly the following, with nothing before or after it:

```
# PR review — <PASS | FAIL>

- <key>: <verdict>

<report of each reviewer, in table order, separated by one blank line>
```

- The overall verdict is `FAIL` if any reviewer's verdict is `FAIL` or `NOT_RUN`, otherwise `PASS`.
- Write one `- <key>: <verdict>` line per reviewer, in table order.
- Copy each report character for character, including its machine-readable line. Do not reword, translate, merge, re-rank or drop rows.

Do not fix code, post to GitHub or commit anything. If the user then asks for fixes, treat that as a new request.
