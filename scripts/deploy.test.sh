#!/usr/bin/env bash
#
# Standalone regression tests for the deploy preflight guard
# (scripts/lib/checkout-guard.sh). The repo has no shell test runner, so this
# is directly executable: ./scripts/deploy.test.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"

failures=0
checks=0

check() {
  local name="$1" expected="$2" actual="$3"
  checks=$((checks + 1))
  if [ "$actual" = "$expected" ]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s\n     expected: %q\n     actual:   %q\n' "$name" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# A modified tracked file must block the deploy: that work is genuinely at risk.
check "modified tracked file refuses" \
  "refuse" \
  "$(guard_verdict ' M src/index.ts' ' M src/index.ts')"

# Staged additions are tracked changes too.
check "staged tracked file refuses" \
  "refuse" \
  "$(guard_verdict 'A  src/new.ts' 'A  src/new.ts')"

# Untracked files alone must not block: a --ff-only pull cannot clobber them.
check "untracked only proceeds with count" \
  "proceed-untracked 2" \
  "$(guard_verdict '' '?? notes-a.md
?? notes-b.md')"

# Mixed tracked + untracked still refuses (the tracked change is the risk).
check "tracked plus untracked refuses" \
  "refuse" \
  "$(guard_verdict ' M src/index.ts' ' M src/index.ts
?? notes-a.md')"

# Clean tree proceeds.
check "clean tree proceeds" \
  "proceed-clean" \
  "$(guard_verdict '' '')"

# Untracked path extraction yields bare paths, in order, without the "?? " prefix.
check "untracked paths are stripped and ordered" \
  "prior-research-forth-native.md
research-cdda-4systems.md" \
  "$(untracked_paths '?? prior-research-forth-native.md
 M src/index.ts
?? research-cdda-4systems.md')"

printf '\n%s checks, %s failed\n' "$checks" "$failures"
[ "$failures" -eq 0 ] || exit 1
