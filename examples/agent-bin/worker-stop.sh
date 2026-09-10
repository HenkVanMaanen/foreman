#!/usr/bin/env bash
# worker-stop — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Stop a worker launched with `spawn-worker <name>` by killing its RECORDED PID — the pid the
# runner stored in `$STATE/<name>.launch` (where $STATE is ${FOREMAN_STATE_DIR:-state}).
# Verify the saved process identity before sending TERM; refuse legacy bare PIDs.
#
# WHY by pid, never `pkill -f`: every worker is a `claude -p` process, and so is the foreman
# supervisor and THIS very agent — a `pkill -f claude`/`pkill -f "$name"` would match and kill the
# caller (self-kill) and sibling workers. Killing the one recorded pid is surgical and safe.
#
# Usage: worker-stop <name>
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/worker-state.sh"

name="${1:?usage: worker-stop <name>}"
# Same charset guard as spawn-worker so the name can't smuggle anything into the lookup/grep.
if ! [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "worker-stop: invalid name '$name' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
fi

state="${FOREMAN_STATE_DIR:-state}"
registry="$state/workers.jsonl"
[ -f "$registry" ] || { echo "worker-stop: no registry at $registry" >&2; exit 1; }

# Require the saved process identity as well as its PID; historical bare PIDs may be reused.
lifecycle="$(worker_state "$state" "$name")"
if [ "$lifecycle" != RUNNING ]; then
  echo "worker-stop: '$name' is $lifecycle; refusing to signal an unverified PID" >&2
  exit 1
fi
read -r requested pid identity < "$state/$name.launch"
[ "$(worker_identity "$pid")" = "$identity" ] || exit 1

if kill "$pid" 2>/dev/null; then
  echo "worker-stop: sent SIGTERM to worker '$name' (pid $pid)"
else
  echo "worker-stop: could not signal pid $pid for '$name' (already exited?)" >&2
  exit 1
fi
