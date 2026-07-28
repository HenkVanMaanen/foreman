#!/usr/bin/env bash
# worker-status — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Read-only status for a worker launched with `spawn-worker <name>`: reports done-vs-running
# (a "WORKER_EXIT=" marker in the log means the worker finished, and shows its exit code) and
# tails the last ~15 lines of its log so you can see where it is without re-reading everything.
#
# Usage: worker-status <name>
set -euo pipefail

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
# jq is unavailable, BEFORE falling through to the WORKER_EXIT/RUNNING log signal and the tail.
if [ -f "$result" ]; then
  echo "worker '$name': result.json"
  if command -v jq >/dev/null 2>&1; then
    jq -r '"  status : \(.status // "?")\n  branch : \(.branch // "")\n  mr_url : \(.mr_url // "")\n  summary: \(.summary // "")"' \
       "$result" 2>/dev/null || cat -- "$result"
  else
    cat -- "$result"
  fi
fi

[ -f "$log" ] || { echo "worker-status: no log for '$name' at $log" >&2; exit 1; }

# WORKER_EXIT= is appended by spawn-worker only after `claude -p` returns, so its presence is the
# done signal; grab the last one and report its code. This stays as the fallback when result.json is
# absent (worker still running, or launched by an older spawn-worker).
exit_line="$(grep -E '^WORKER_EXIT=' "$log" | tail -n1 || true)"
if [ -n "$exit_line" ]; then
  echo "worker '$name': DONE (${exit_line#WORKER_EXIT=} exit code)"
else
  echo "worker '$name': RUNNING (no WORKER_EXIT marker yet)"
fi

echo "--- last 15 lines of $log ---"
tail -n 15 "$log"
