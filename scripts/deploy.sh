#!/usr/bin/env bash
#
# Deploy a new revision to the server checkout and prove it actually booted.
#
# Why this exists: the unit runs `node src/index.ts` directly (Node type
# stripping, no compiled output), so two failures only show up at startup:
#
#   1. TypeScript syntax that `tsc` accepts but Node's strip-only loader
#      rejects — e.g. a parameter property. That once crash-looped the bot
#      until systemd gave up ("Start request repeated too quickly").
#   2. A restart that kills an in-flight subagent run, whose completion notice
#      can never be delivered (the channel then stays silent).
#
# So a deploy is: refuse on a dirty checkout -> wait until no run is in flight
# -> pull -> `tsc` gate (catches class 1 before touching the service) ->
# restart -> poll for a readiness line (catches whatever `tsc` did not) ->
# roll back and restart the old revision if the smoke test fails.
#
# "Dirty" here means modified TRACKED files only, and that refusal is hard (no
# override). Untracked files do not block the deploy: a `--ff-only` pull cannot
# clobber an untracked path (git aborts the pull on collision instead), and this
# checkout permanently carries untracked research notes that must never be
# deleted or stashed. They are reported on one informational line so the deploy
# log still proves they were seen and left alone. The guard exists to protect
# local *edits to tracked files*, not to demand a pristine tree — see
# scripts/lib/checkout-guard.sh and its tests in scripts/deploy.test.sh.
#
# The tsc gate runs over a non-interactive ssh shell, which does not inherit the
# interactive PATH: on this host node/npm come from mise. The gate therefore
# prepends ~/.local/share/mise/shims when present. Without that it aborts with
# "npm: command not found" (exit 127) after the pull but before any restart,
# leaving a partially applied deploy — precisely what this script must prevent.
#
# Usage: scripts/deploy.sh --host <ssh-target> [options]
#
set -euo pipefail

HOST=""
# Intentional: the tilde must survive to the remote shell, which expands it.
# shellcheck disable=SC2088
REMOTE_PATH="~/Projects/pi-discord"
UNIT="pi-discord"
MAX_WAIT=300
FORCE=0
SKIP_BUILD=0
DRY_RUN=0
USER_SCOPE=0
SMOKE_TIMEOUT=60
SMOKE_INTERVAL=3
READY_PATTERN='Bot is ready|Bot logged in'

usage() {
  cat <<'USAGE'
Deploy the checked-out revision to a server and verify it boots.

Options:
  --host TARGET      ssh target to deploy to (required), e.g. oracle or
                     ubuntu@198.51.100.10
  --path PATH        remote checkout path (default: ~/Projects/pi-discord)
  --unit NAME        systemd unit (default: pi-discord)
  --max-wait SECS    how long to wait for in-flight runs (default: 300)
  --force            restart even if a run is in flight (may lose a completion)
  --skip-build       skip the `npm run build` (tsc) gate
  --user             drive a systemd user unit (systemctl --user, no sudo)
  --dry-run          print the remote commands, change nothing
  -h, --help         show this help

The remote checkout must be clean and is never stashed or committed to; run
git pull by hand if it is dirty. Exit codes: 0 deployed and verified, 1 deploy
or smoke test failed (old revision restored), 2 still busy after --max-wait
(nothing changed), 3 missing prerequisite or bad usage.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --path) REMOTE_PATH="${2:?--path needs a value}"; shift 2 ;;
    --unit) UNIT="${2:?--unit needs a value}"; shift 2 ;;
    --max-wait) MAX_WAIT="${2:?--max-wait needs a value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --user) USER_SCOPE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 3 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "deploy: --host is required (see --help)" >&2
  exit 3
fi
if [ "$DRY_RUN" -eq 0 ] && ! command -v ssh >/dev/null 2>&1; then
  echo "deploy: ssh is required" >&2
  exit 3
fi

if [ "$USER_SCOPE" -eq 1 ]; then
  SYSCTL="systemctl --user"
else
  SYSCTL="sudo -n systemctl"
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"

log() { printf 'deploy: %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# Run a command on the target. $REMOTE_PATH is interpolated unquoted so the
# remote shell expands `~`; the rest is a literal command string.
# shellcheck disable=SC2029  # the command is meant to expand on the remote side
remote() {
  local cmd="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] ssh %s %q\n' "$HOST" "$cmd"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" "$cmd"
}

# Capture stdout of a remote command (dry-run prints a placeholder).
# shellcheck disable=SC2029  # the command is meant to expand on the remote side
capture() {
  local cmd="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] ssh %s %q  (output captured)\n' "$HOST" "$cmd" >&2
    printf 'DRY-RUN'
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" "$cmd"
}

# --- 1. preflight -----------------------------------------------------------
# Tracked modifications refuse (local edits are at risk); untracked files are
# reported and left alone (a --ff-only pull cannot clobber them).
log "preflight: $HOST:$REMOTE_PATH"
tracked_changes="$(capture "cd $REMOTE_PATH && git status --porcelain --untracked-files=no")"
all_changes="$(capture "cd $REMOTE_PATH && git status --porcelain")"
if [ "$DRY_RUN" -eq 0 ]; then
  verdict="$(guard_verdict "$tracked_changes" "$all_changes")"
  case "$verdict" in
    refuse)
      printf 'deploy: remote checkout has modifications to tracked files - refusing to deploy:\n%s\n' "$tracked_changes" >&2
      exit 1
      ;;
    proceed-clean)
      ;;
    proceed-untracked\ *)
      untracked_count="${verdict##* }"
      untracked_names="$(untracked_paths "$all_changes" | tr '\n' ' ')"
      log "note: $untracked_count untracked file(s) present, not touched: ${untracked_names% }"
      ;;
    *)
      die "preflight: unexpected guard verdict '$verdict' - nothing changed"
      ;;
  esac
fi

# --- 2. wait for idle -------------------------------------------------------
# Reuses the guard's logic so a live subagent run is never killed; that guard
# only waits on runs that are queued/running *with a live pid*.
idle_args="--check-only --max-wait $MAX_WAIT --unit $UNIT"
idle_note=""
if [ "$FORCE" -eq 1 ]; then
  idle_args="$idle_args --force"
  idle_note=" --force"
fi
if [ "$USER_SCOPE" -eq 1 ]; then
  idle_args="$idle_args --user"
fi
log "waiting for idle (up to ${MAX_WAIT}s${idle_note})"
set +e
remote "cd $REMOTE_PATH && ./scripts/restart-when-idle.sh $idle_args"
idle_rc=$?
set -e
if [ "$idle_rc" -ne 0 ]; then
  if [ "$idle_rc" -eq 2 ]; then
    echo "deploy: still busy after ${MAX_WAIT}s - nothing changed. Re-run with --force to override." >&2
    exit 2
  fi
  die "idle check failed (exit $idle_rc) - nothing changed"
fi

# --- 3. rollback point ------------------------------------------------------
ROLLBACK="$(capture "cd $REMOTE_PATH && git rev-parse HEAD")"
log "rollback point: $ROLLBACK"

# --- 4. pull ----------------------------------------------------------------
log "pull --ff-only"
remote "cd $REMOTE_PATH && git pull --ff-only"

# --- 5. static gate (before any service disruption) -------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  log "build gate: skipped (--skip-build)"
else
  log "build gate: tsc"
  # A non-interactive ssh shell has no mise PATH, so `npm` would not resolve.
  # `export` (not a VAR=value prefix) because the target is a compound `if`.
  build_path_prefix=""
  if [ "$(capture "[ -d \$HOME/.local/share/mise/shims ] && echo yes || echo no")" = "yes" ]; then
    build_path_prefix='export PATH="$HOME/.local/share/mise/shims:$PATH"; '
  fi
  remote "cd $REMOTE_PATH && ${build_path_prefix}if [ -x node_modules/.bin/tsc ]; then npm run build; else echo 'deploy: no node_modules/.bin/tsc, skipping tsc gate' >&2; fi"
fi

# --- 6. restart -------------------------------------------------------------
START="$(capture "date +%s")"
log "restarting $UNIT"
remote "$SYSCTL restart $UNIT"

# --- 7. boot smoke test -----------------------------------------------------
# systemd still says "active" for a bot that crashed after startup, so require
# a readiness line written since the restart as well.
smoke_ok=0
deadline=$(( $(date +%s) + SMOKE_TIMEOUT ))
while :; do
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] poll for %s in journalctl -u %s for %ss, requiring active\n' \
      "$READY_PATTERN" "$UNIT" "$SMOKE_TIMEOUT"
    smoke_ok=1
    break
  fi

  ready_line="$(capture "journalctl -u $UNIT --since @$START --no-pager -o cat | grep -E '$READY_PATTERN' | tail -1" || true)"
  if [ -n "$ready_line" ]; then
    state="$(capture "$SYSCTL is-active $UNIT || true")"
    if [ "$state" = "active" ]; then
      smoke_ok=1
      log "smoke test: active and ready ($ready_line)"
      break
    fi
  fi

  if [ "$(capture "$SYSCTL is-failed $UNIT || true")" = "failed" ]; then
    log "smoke test: unit entered failed state"
    break
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "smoke test: no readiness line within ${SMOKE_TIMEOUT}s"
    break
  fi
  sleep "$SMOKE_INTERVAL"
done

# --- 8. rollback on failure -------------------------------------------------
if [ "$smoke_ok" -ne 1 ]; then
  echo "deploy: FAILED - rolling back to $ROLLBACK" >&2
  remote "cd $REMOTE_PATH && git reset --hard $ROLLBACK"
  remote "$SYSCTL restart $UNIT"
  sleep "$SMOKE_INTERVAL"
  back="$(capture "$SYSCTL is-active $UNIT || true")"
  if [ "$back" = "active" ]; then
    echo "deploy: rolled back to $ROLLBACK, unit is active again - investigate the journal" >&2
  else
    echo "deploy: rolled back to $ROLLBACK but the unit is '$back' - manual attention needed" >&2
  fi
  exit 1
fi

# --- 9. report --------------------------------------------------------------
HEAD="$(capture "cd $REMOTE_PATH && git rev-parse --short HEAD")"
MAIN_PID="$(capture "$SYSCTL show $UNIT -p MainPID --value")"
log "deployed $HEAD (MainPID $MAIN_PID)"
