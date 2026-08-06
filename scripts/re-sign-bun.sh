#!/bin/zsh
# Re-sign the mise-managed bun binary with Calendar + Reminders TCC entitlements.
#
# WHY: macOS TCC auto-denies Calendar/Reminders access for hardened-runtime
# binaries that lack the com.apple.security.personal-information.*
# entitlements. The pi-discord LaunchAgent runs under bun, so ical (EventKit)
# spawned by the bot was hard-denied. Adding these entitlements makes bun a
# promptable/grantable TCC client instead.
#
# WHEN: Run this after any bun update/reinstall (e.g. `mise upgrade bun`),
# otherwise the bot loses calendar access again.
#
# The one-time grant prompt: run the bot once, click Allow on the macOS
# "bun wants to access your calendar" dialog.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_BIN="$(command -v bun)"

if [[ -z "$BUN_BIN" ]]; then
  echo "error: bun not found on PATH (shims?)" >&2
  exit 1
fi

echo "Re-signing: $BUN_BIN"
codesign --force --sign - --identifier bun --options runtime \
  --entitlements "$SCRIPT_DIR/bun-entitlements.plist" "$BUN_BIN"

echo "Verifying entitlements:"
codesign -d --entitlements - "$BUN_BIN" 2>&1
echo "Done."
