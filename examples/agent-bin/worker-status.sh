#!/usr/bin/env bash
# worker-status — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Read-only status for a worker launched with `spawn-worker <name>`: verifies runner liveness and
# tails the last ~15 lines of its log so you can see where it is without re-reading everything.
#
# Usage: worker-status <name>
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/worker-state.sh"

name="${1:?usage: worker-status <name>}"
# Same charset guard as spawn-worker so the name can't escape the log path.
if ! [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "worker-status: invalid name '$name' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
fi

state="${FOREMAN_STATE_DIR:-state}"
log="$state/$name-worker.log"
result="$state/$name.result.json"

# Structured result first: the worker writes `<name>.result.json` as its last act, and the
# spawn-worker wrapper synthesises a minimal one if the worker forgot — so once the worker is DONE
# this file exists and is the authoritative status. Show its parsed fields (jq), or the raw file if
# jq is unavailable. The separate lifecycle check below determines whether execution finished.
if [ -f "$result" ]; then
  echo "worker '$name': result.json"
  if command -v jq >/dev/null 2>&1; then
    jq -r '"  status : \(.status // "?")\n  branch : \(.branch // "")\n  mr_url : \(.mr_url // "")\n  summary: \(.summary // "")"' \
       "$result" 2>/dev/null || cat -- "$result"
  else
    cat -- "$result"
  fi
fi

lifecycle="$(worker_state "$state" "$name")"
case "$lifecycle" in
  DONE)
    code="$(worker_field "$state" "$name" exit)"
    echo "worker '$name': DONE (${code:-unknown} exit code)";;
  RUNNING) echo "worker '$name': RUNNING (runner identity verified)";;
  STARTING) echo "worker '$name': STARTING (awaiting runner acknowledgement)";;
  ORPHANED) echo "worker '$name': ORPHANED (runner missing, recorded engine child still live; needs attention)";;
  LOST) echo "worker '$name': LOST (recorded runner absent or replaced; completion unconfirmed)";;
  *) echo "worker '$name': UNKNOWN (no verified live runner or completion; inspect launch evidence)";;
esac

if [ -f "$log" ]; then
  echo "--- last 15 lines of $log ---"
  tail -n 15 "$log"
else
  echo "worker-status: no log for '$name' at $log" >&2
fi
