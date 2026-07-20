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

# Definition-of-done footer appended to EVERY worker brief. This is what makes the
# review→fix→re-review loop automatic for all future workers: a worker must self-review with
# bin/review-loop and must not mark itself done until it reports CLEAN (or surfaces a security
# issue / non-convergence for the human). Edit this constant to change the standard; it is applied
# additively, so the existing `spawn-worker <name> <brief-file>` interface is unchanged.
read -r -d '' DOD_FOOTER <<'EOF' || true

## Definition of done (mandatory — appended by spawn-worker)
Before you mark yourself done / exit:
1. Complete your change and COMMIT it on your branch.
2. Run the auto-review loop on your working dir:  `bin/review-loop --dir .`
   (it runs /code-review and /simplify to convergence, committing each round's fixes, plus an
   independent OpenAI Codex reviewer that auto-fixes what it is confident about and escalates
   risky findings — pass --no-codex to skip it — and a conditional /security-review).
3. Do NOT mark done / exit until review-loop prints `review-loop: CLEAN` and exits 0.
   - If it reports NOT-CLEAN (hit the round cap with findings still, or a review invocation
     failed), or the security review escalates, DO NOT proceed — report that clearly to the human
     (via bin/ask-human / bin/reply) and stop, rather than silently marking the task done.
4. After any auto-fixes, sanity-check your change still builds / passes `bash -n` (or the repo's
   equivalent) before finishing.
EOF

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

# Compose the brief the worker actually receives: the caller's brief followed by the standard
# definition-of-done footer (which wires in the auto-review loop). Written to a file so multi-line
# text / apostrophes stay safe — the launch still passes it via $(cat …), exactly as before, so
# the existing safe-quoting is preserved.
full_brief="$state/$name-brief.composed.txt"
# Read the caller's brief into memory BEFORE writing full_brief, so we are safe even if the caller
# passed a brief path that resolves to full_brief itself (the redirect would otherwise truncate it
# to empty before cat could read it).
brief_body="$(cat -- "$brief")"
{ printf '%s\n' "$brief_body"; printf '%s\n' "$DOD_FOOTER"; } > "$full_brief"

# Detach so the worker outlives this turn; capture its exit into the log so worker-status can
# tell done-vs-running. $(cat …) expands in the child at launch, so the full brief is passed as
# one argument regardless of quotes/newlines in it.
nohup bash -c "claude -p --dangerously-skip-permissions \"\$(cat $(printf '%q' "$full_brief"))\" > $(printf '%q' "$log") 2>&1; echo \"WORKER_EXIT=\$?\" >> $(printf '%q' "$log")" >/dev/null 2>&1 &
pid=$!

echo "spawned worker '$name' (pid $pid)"
echo "log: $log"
