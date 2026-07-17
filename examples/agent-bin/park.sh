#!/usr/bin/env bash
# park — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Go idle WITHOUT keeping the model awake. Instead of foreground-blocking `wait-reply --inbox`
# (which re-invokes the model on every ~600s poll and re-reads your whole context each time —
# ~32% of total spend when idle), write an idle sentinel and END YOUR TURN. The supervisor
# (cheap TypeScript) then owns the wait: it blocks on `wait-reply --inbox` itself and re-invokes
# you ONLY when the human sends a message, delivering the message text in your next prompt
# (prefixed "[inbox] New message(s)…").
#
# Usage: park            # touch the idle sentinel, print a one-liner, then end your turn
set -euo pipefail

state="${FOREMAN_STATE_DIR:-state}"
mkdir -p "$state" 2>/dev/null || true
touch "$state/idle-wait"
echo "parked — supervisor will wake me on the next message"
