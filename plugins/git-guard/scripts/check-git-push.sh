#!/usr/bin/env bash
# git-guard PreToolUse hook: denies `git push` targeting a protected branch.
# Protected branches: $GIT_GUARD_PROTECTED (space-separated), default "main master develop".
set -euo pipefail

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

case "$command" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

protected="${GIT_GUARD_PROTECTED:-main master develop}"

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
  if printf '%s' "$command" | grep -qE "git push[^|;&]*[[:space:]:](refs/heads/)?$branch([[:space:]]|\"|'|\$)"; then
    deny "git-guard: push targets protected branch '$branch'. Use a feature branch and open a PR."
  fi
done

# `git push origin HEAD` resolves to the current branch
if printf '%s' "$command" | grep -qE 'git push[^|;&]*[[:space:]]HEAD([[:space:]]|$)'; then
  cur=$(current_branch)
  for branch in $protected; do
    if [ "$cur" = "$branch" ]; then
      deny "git-guard: 'git push ... HEAD' while on protected branch '$branch'. Use a feature branch and open a PR."
    fi
  done
fi

# Bare push (only flags and/or a remote name, no refspec) pushes the current branch
if printf '%s' "$command" | grep -qE 'git push([[:space:]]+(-[^[:space:]]+|origin|upstream))*[[:space:]]*($|[|;&])'; then
  cur=$(current_branch)
  for branch in $protected; do
    if [ "$cur" = "$branch" ]; then
      deny "git-guard: bare 'git push' while on protected branch '$branch'. Use a feature branch and open a PR."
    fi
  done
fi

exit 0
