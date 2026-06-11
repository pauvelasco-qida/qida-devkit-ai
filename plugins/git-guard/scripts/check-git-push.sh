#!/usr/bin/env bash
# git-guard PreToolUse hook: denies `git push` targeting a protected branch.
# Protected branches, by precedence: .claude/git-guard.local.md (protected_branches),
# $GIT_GUARD_PROTECTED (space-separated), default "main master develop".
set -euo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "git-guard: jq not found -- branch protection inactive" >&2
  exit 0
}

input=$(cat)
# Malformed input must not abort the hook (non-2 exit codes are non-blocking),
# so fall back to empty and let the gate below allow the command through.
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

# Matches `git push` with optional global flags between `git` and `push`,
# e.g. `git -C /repo push`, `git -c key=val push`, `git --git-dir=x push`.
GIT_PUSH='git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-|;&[:space:]][^[:space:]]*)?)*[[:space:]]+push'

printf '%s' "$command" | grep -qE "$GIT_PUSH" || exit 0

protected="${GIT_GUARD_PROTECTED:-main master develop}"

# Per-project settings: .claude/git-guard.local.md with YAML frontmatter.
#   enabled: false              -> skip protection in this project
#   protected_branches: a b c   -> overrides env var and default (space-separated)
settings="${cwd:-$PWD}/.claude/git-guard.local.md"
if [ -f "$settings" ]; then
  frontmatter=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$settings")
  enabled=$(printf '%s\n' "$frontmatter" | grep '^enabled:' | sed -e 's/enabled: *//' -e 's/^"\(.*\)"$/\1/' || true)
  [ "$enabled" = "false" ] && exit 0
  branches=$(printf '%s\n' "$frontmatter" | grep '^protected_branches:' | sed -e 's/protected_branches: *//' -e 's/^"\(.*\)"$/\1/' || true)
  [ -n "$branches" ] && protected="$branches"
fi

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

current_branch() {
  git -C "$cwd" branch --show-current 2>/dev/null || true
}

# Explicit protected branch as push destination, e.g.
# `git push origin main`, `git push -u origin HEAD:main`, `git push origin :main`
for branch in $protected; do
  if printf '%s' "$command" | grep -qE "${GIT_PUSH}[^|;&]*[[:space:]:](refs/heads/)?$branch([[:space:]]|\"|'|\$)"; then
    deny "git-guard: push targets protected branch '$branch'. Use a feature branch and open a PR."
  fi
done

# `git push origin HEAD` resolves to the current branch
if printf '%s' "$command" | grep -qE "${GIT_PUSH}[^|;&]*[[:space:]]HEAD([[:space:]]|\$)"; then
  cur=$(current_branch)
  for branch in $protected; do
    if [ "$cur" = "$branch" ]; then
      deny "git-guard: 'git push ... HEAD' while on protected branch '$branch'. Use a feature branch and open a PR."
    fi
  done
fi

# Bare push (only flags and/or a remote name, no refspec) pushes the current branch
if printf '%s' "$command" | grep -qE "${GIT_PUSH}([[:space:]]+(-[^[:space:]]+|origin|upstream))*[[:space:]]*(\$|[|;&])"; then
  cur=$(current_branch)
  for branch in $protected; do
    if [ "$cur" = "$branch" ]; then
      deny "git-guard: bare 'git push' while on protected branch '$branch'. Use a feature branch and open a PR."
    fi
  done
fi

exit 0
