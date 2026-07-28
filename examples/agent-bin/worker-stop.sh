#!/usr/bin/env bash
# worker-stop — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Stop a worker launched with `spawn-worker <name>` by killing its RECORDED PID — the pid the
# spawn-worker launch line stored in `$STATE/workers.jsonl` (where $STATE is
# ${FOREMAN_STATE_DIR:-state}). We look up the LAST launch entry for <name> and `kill "$pid"`.
#
# WHY by pid, never `pkill -f`: every worker is a `claude -p` process, and so is the foreman
# supervisor and THIS very agent — a `pkill -f claude`/`pkill -f "$name"` would match and kill the
# caller (self-kill) and sibling workers. Killing the one recorded pid is surgical and safe.
#
# Usage: worker-stop <name>
set -euo pipefail

name="${1:?usage: worker-stop <name>}"
# Same charset guard as spawn-worker so the name can't smuggle anything into the lookup/grep.
if ! [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "worker-stop: invalid name '$name' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
fi

state="${FOREMAN_STATE_DIR:-state}"
registry="$state/workers.jsonl"
[ -f "$registry" ] || { echo "worker-stop: no registry at $registry" >&2; exit 1; }

# Last launch entry's pid for this worker (launch lines carry "pid"; exit lines do not).
if command -v jq >/dev/null 2>&1; then
  pid="$(jq -r --arg n "$name" 'select(.name==$n and (.pid != null)) | .pid' "$registry" 2>/dev/null | tail -n1)"
else
  pid="$(grep -F "\"name\":\"$name\"" "$registry" 2>/dev/null \
         | sed -nE 's/.*"pid"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | tail -n1)"
fi

if [ -z "${pid:-}" ]; then
  echo "worker-stop: no recorded pid for worker '$name' in $registry" >&2
  exit 1
fi
if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
  echo "worker-stop: recorded pid for '$name' is not numeric ('$pid')" >&2
  exit 1
fi

if kill "$pid" 2>/dev/null; then
  echo "worker-stop: sent SIGTERM to worker '$name' (pid $pid)"
else
  echo "worker-stop: could not signal pid $pid for '$name' (already exited?)" >&2
  exit 1
fi
