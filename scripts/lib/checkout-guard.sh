#!/usr/bin/env bash
#
# Pure helpers for the deploy preflight's checkout check.
#
# Why this exists: the deploy guard must refuse when a *tracked* file has local
# edits, because `git pull --ff-only` may conflict with or overwrite that work.
# It must NOT refuse merely because untracked files are present: a fast-forward
# pull cannot clobber untracked paths (git aborts the pull instead), and this
# checkout permanently carries untracked research notes that must never be
# deleted or stashed. Demanding a pristine tree therefore blocked every deploy.
#
# Kept side-effect free so `scripts/deploy.test.sh` can exercise the decision
# logic without running a deploy.

# Print the paths of untracked entries from `git status --porcelain` output.
untracked_paths() {
  local status_output="$1"
  local line path
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      '?? '*)
        path="${line#\?\? }"
        printf '%s\n' "$path"
        ;;
    esac
  done <<< "$status_output"
}

# Decide whether the deploy may proceed.
#
#   $1  output of `git status --porcelain --untracked-files=no` (tracked changes)
#   $2  output of `git status --porcelain` (everything)
#
# Prints exactly one of:
#   refuse                 tracked files are modified
#   proceed-clean          nothing modified, nothing untracked
#   proceed-untracked <n>  only untracked files (<n> of them)
guard_verdict() {
  local tracked_status="$1"
  local full_status="$2"
  local untracked count

  if [ -n "$tracked_status" ]; then
    printf 'refuse\n'
    return 0
  fi

  untracked="$(untracked_paths "$full_status")"
  if [ -z "$untracked" ]; then
    printf 'proceed-clean\n'
    return 0
  fi

  count="$(printf '%s\n' "$untracked" | grep -c .)"
  printf 'proceed-untracked %s\n' "$count"
}
