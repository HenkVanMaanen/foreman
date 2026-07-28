#!/usr/bin/env bash
# wait-on — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Block on one or more workers WITHOUT keeping the model awake. Like `park`, this does not
# foreground-wait (which would re-invoke the model on every poll and re-read your whole context —
# the ~32%-of-idle-spend problem). Instead it records the worker names you are blocking on and ENDS
# YOUR TURN; the cheap TypeScript supervisor owns the wait and re-invokes you only when it has a
# reason to — either a named worker's `$STATE/<name>.done` marker appears (worker finished) or a
# human message arrives — delivering a prompt that names the finished worker(s).
#
# It writes the names newline-separated to `$STATE/wait-on` (the supervisor's wake-on-worker
# sentinel) AND touches `$STATE/idle-wait` (so the supervisor enters its parked wait loop at all).
# $STATE is ${FOREMAN_STATE_DIR:-state}.
#
# Usage: wait-on <name> [<name> ...]
set -euo pipefail

[ "$#" -ge 1 ] || { echo "usage: wait-on <name> [<name> ...]" >&2; exit 2; }

# Validate every name up front (same charset as spawn-worker) so a bad name can't land in the
# sentinel the supervisor reads back and hands to its `<name>.done` stat.
for n in "$@"; do
  if ! [[ "$n" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "wait-on: invalid name '$n' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
  fi
done

state="${FOREMAN_STATE_DIR:-state}"
mkdir -p "$state" 2>/dev/null || true

# Names newline-separated = the wake-on-worker sentinel; idle-wait = enter the parked wait at all.
printf '%s\n' "$@" > "$state/wait-on"
touch "$state/idle-wait"

# Space-joined for the human-readable line.
joined="$*"
echo "waiting on: $joined — supervisor will wake me when they finish or a human writes"
