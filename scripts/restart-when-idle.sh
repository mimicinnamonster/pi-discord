#!/usr/bin/env bash
#
# Restart pi-discord only when no subagent child is mid-flight.
#
# Why: a background subagent run reports itself through the process that started
# it. Restarting while one is running kills the runner before it can announce the
# result — observed live as a `subagent-notify` record that never turned into a
# turn (the channel stayed silent until a human prompted it), plus a run status
# left non-terminal.
#
# A stale record (dead pid) does not block a restart: only a run that is still
# queued or running *with a live pid* does. That keeps the guard from waiting on
# the very wedge a restart would clear.
#
# Usage: scripts/restart-when-idle.sh [options]
#
set -euo pipefail

UNIT="pi-discord"
MAX_WAIT=300
INTERVAL=10
FORCE=0
DRY_RUN=0
USE_SUDO=1
USER_SCOPE=0

usage() {
  cat <<'USAGE'
Restart the bot only when no subagent run is in flight.

Options:
  --unit NAME        systemd unit to restart (default: pi-discord)
  --max-wait SECS    how long to wait for runs to finish (default: 300)
  --interval SECS    poll interval while waiting (default: 10)
  --user             use `systemctl --user` instead of `sudo systemctl`
  --no-sudo          call systemctl without sudo (use when already root)
  --force            restart even if runs are in flight
  --dry-run          report what would happen, change nothing
  -h, --help         show this help

Exit codes: 0 restarted (or would restart with --dry-run), 2 still busy after
--max-wait (nothing restarted), 3 missing prerequisite.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --unit) UNIT="${2:?--unit needs a value}"; shift 2 ;;
    --max-wait) MAX_WAIT="${2:?--max-wait needs a value}"; shift 2 ;;
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    --user) USE_SUDO=0; USER_SCOPE=1; shift ;;
    --no-sudo) USE_SUDO=0; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 3 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "restart-when-idle: jq is required to read run status" >&2
  exit 3
fi

# Mirror pi-subagents' store resolution: $PI_SUBAGENTS_TEMP_ROOT, else
# <tmpdir>/pi-subagents-<scope> with scope uid-<uid>.
runs_dir() {
  local root scope
  if [ -n "${PI_SUBAGENTS_TEMP_ROOT:-}" ]; then
    root="$PI_SUBAGENTS_TEMP_ROOT"
  else
    root="${TMPDIR:-/tmp}/pi-subagents-$(id -u >/dev/null 2>&1 && echo "uid-$(id -u)" || echo "shared")"
  fi
  printf '%s/async-subagent-runs' "$root"
}

# Print "runId<TAB>state<TAB>pid" for runs that are queued/running with a live pid.
busy_runs() {
  local dir status state pid run_id
  dir="$(runs_dir)"
  [ -d "$dir" ] || return 0
  for status in "$dir"/*/status.json; do
    [ -e "$status" ] || continue
    state="$(jq -r '.state // ""' "$status" 2>/dev/null || true)"
    case "$state" in
      queued|running) ;;
      *) continue ;;
    esac
    pid="$(jq -r '.pid // ""' "$status" 2>/dev/null || true)"
    # A run whose runner is gone cannot be lost any further by a restart.
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      run_id="$(basename "$(dirname "$status")")"
      printf '%s\t%s\t%s\n' "$run_id" "$state" "$pid"
    fi
  done
}

restart() {
  local -a cmd
  cmd=(systemctl restart "$UNIT")
  if [ "$USER_SCOPE" -eq 1 ]; then
    cmd=(systemctl --user restart "$UNIT")
  elif [ "$USE_SUDO" -eq 1 ]; then
    cmd=(sudo -n systemctl restart "$UNIT")
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "dry-run: would run: ${cmd[*]}"
    return 0
  fi
  echo "restarting: ${cmd[*]}"
  "${cmd[@]}"
}

if [ "$FORCE" -eq 1 ]; then
  echo "restart-when-idle: --force, skipping the idle check" >&2
  restart
  exit 0
fi

deadline=$(( $(date +%s) + MAX_WAIT ))
while :; do
  busy="$(busy_runs)"
  if [ -z "$busy" ]; then
    echo "restart-when-idle: no run in flight ($(runs_dir))"
    restart
    exit 0
  fi

  echo "restart-when-idle: waiting for in-flight runs:" >&2
  printf '  %s\n' "$busy" | sed 's/\t/  /g' >&2

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "restart-when-idle: still busy after ${MAX_WAIT}s - NOT restarting." >&2
    echo "  Re-run with --force to restart anyway, or investigate with the pid above." >&2
    exit 2
  fi
  sleep "$INTERVAL"
done
