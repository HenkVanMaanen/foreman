#!/usr/bin/env bash
# spawn-worker — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Launch a detached, fresh-context worker agent — the exact pattern the agent otherwise retypes
# by hand each time (and gets subtly wrong: quoting the brief, redirecting the log, capturing the
# exit). A worker is a full `claude -p` instance with its own context window, so it can recurse
# further and a worker blocked on a human never blocks you.
#
# Usage: spawn-worker <name> <brief-file>
#   <name>       identifier for this worker (^[A-Za-z0-9_-]+$); names its log.
#   <brief-file> path to a file holding the worker's brief/prompt (read with cat, so multi-line
#                and apostrophes are safe — write the brief to a file, don't inline it).
#
# Launches, faithful to the established pattern:
#   nohup bash -c 'claude -p --dangerously-skip-permissions "$(cat <brief>)" \
#       > "$STATE/<name>-worker.log" 2>&1; echo "WORKER_EXIT=$?" >> "$STATE/<name>-worker.log"' &
# where $STATE is ${FOREMAN_STATE_DIR:-state}. Prints the wrapper pid and the log path; poll it
# with `worker-status <name>`.
set -euo pipefail

name="${1:?usage: spawn-worker <name> <brief-file>}"
brief="${2:?usage: spawn-worker <name> <brief-file>}"

# Validate <name>: it is interpolated into the log file path, so restrict to a safe charset to
# block path-traversal (mirrors wait-reply.sh's <id> posture).
if ! [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "spawn-worker: invalid name '$name' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
fi
[ -f "$brief" ] || { echo "spawn-worker: brief file '$brief' not found" >&2; exit 2; }

state="${FOREMAN_STATE_DIR:-state}"
mkdir -p "$state" 2>/dev/null || true
log="$state/$name-worker.log"

# Detach so the worker outlives this turn; capture its exit into the log so worker-status can
# tell done-vs-running. $(cat …) expands in the child at launch, so the full brief is passed as
# one argument regardless of quotes/newlines in it.
nohup bash -c "claude -p --dangerously-skip-permissions \"\$(cat $(printf '%q' "$brief"))\" > $(printf '%q' "$log") 2>&1; echo \"WORKER_EXIT=\$?\" >> $(printf '%q' "$log")" >/dev/null 2>&1 &
pid=$!

echo "spawned worker '$name' (pid $pid)"
echo "log: $log"
