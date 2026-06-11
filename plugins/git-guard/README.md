# git-guard

Branch protection for `main`/`master`, reusable across projects.

## What it does

Two layers:

1. **Claude-side (automatic).** A `PreToolUse` hook that denies any `git push` targeting a protected branch from a Claude Code session. Active in every project where the plugin is enabled — no setup needed. Covers explicit pushes (`git push origin main`, `HEAD:main`, `:main`), bare `git push` while on a protected branch, and `git push origin HEAD`.

2. **Terminal-side (per repo, via `/git-guard:protect`).** Installs a git `pre-push` hook into the current repo's `.git/hooks/`, blocking direct pushes to protected branches from any terminal, not just Claude.

## Usage

```
/git-guard:protect            # install pre-push hook in current repo
/git-guard:protect --ruleset  # also create a GitHub ruleset (requires gh auth + admin)
```

## Configuration

Protected branches default to `main master develop`. Override with a space-separated env var:

```bash
export GIT_GUARD_PROTECTED="main master develop release"
```

Applies to both the Claude-side hook and the installed pre-push hook.

## Limitations

- The Claude-side check is best-effort string matching; the installed `pre-push` hook (and a server-side ruleset) are the authoritative layers.
- `.git/hooks/` is not committed — each clone needs `/git-guard:protect` once. Use `--ruleset` for protection that applies to every clone and collaborator.
- `git push --no-verify` bypasses the local pre-push hook; only a server-side ruleset prevents that.
