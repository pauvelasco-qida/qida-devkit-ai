---
description: Install the git-guard pre-push hook in the current repo (optionally also a GitHub ruleset)
argument-hint: "[--ruleset]"
allowed-tools: ["Bash", "Read"]
---

Install branch protection for the current repository.

## Steps

1. Verify the current directory is inside a git repository (`git rev-parse --git-dir`). If not, stop and tell the user.

2. Install the pre-push hook:
   - Hook source: `${CLAUDE_PLUGIN_ROOT}/scripts/pre-push`
   - Destination: `$(git rev-parse --git-dir)/hooks/pre-push`
   - If a pre-push hook already exists and differs from the git-guard one, show the user its content and ask before overwriting.
   - Copy the file and `chmod +x` it.

3. Verify the installation: create an empty commit on a protected branch only if safe to do so, or simply confirm the hook file is executable and report its path. Do not leave test commits behind.

4. If the arguments contain `--ruleset`:
   - Check `gh auth status` and that `origin` points to GitHub.
   - Create a repository ruleset named `protect-main` targeting the default branch with: require pull request (0 approvals), block force pushes (`non_fast_forward`), block deletions, empty `bypass_actors`.
   - Use `gh api repos/{owner}/{repo}/rulesets -X POST`. If a ruleset with that name already exists, report it and skip creation.

5. Report what was installed and remind the user that the local hook only protects this clone; server-side rules protect everyone.

Arguments: $ARGUMENTS
