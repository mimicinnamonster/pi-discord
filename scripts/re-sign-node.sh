#!/bin/zsh
# Re-sign the mise-managed node binary with Calendar + Reminders TCC entitlements.
#
# WHY: macOS TCC auto-denies Calendar/Reminders access for hardened-runtime
# binaries that lack the com.apple.security.personal-information.*
# entitlements. The pi-discord LaunchAgent runs under node, so ical (EventKit)
# spawned by the bot was hard-denied. Adding these entitlements makes node a
# promptable/grantable TCC client instead.
#
# WHEN: Run this after any node update/reinstall (e.g. `mise upgrade node`),
# otherwise the bot loses calendar access again.
#
# The one-time grant prompt: run the bot once, click Allow on the macOS
# "node wants to access your calendar" dialog.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH (shims?)" >&2
  exit 1
fi

echo "Re-signing: $NODE_BIN"
codesign --force --sign - --identifier node --options runtime \
  --entitlements "$SCRIPT_DIR/node-entitlements.plist" "$NODE_BIN"

echo "Verifying entitlements:"
codesign -d --entitlements - "$NODE_BIN" 2>&1
echo "Done."
