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

# Definition-of-done footer appended to EVERY worker brief. Policy: a worker produces a REVIEWABLE
# DRAFT fast and stops for the human — it does NOT run the heavy multi-round review loop. That
# review (/code-review + /simplify + Codex + /security-review) is a PRE-MERGE gate foreman runs once
# the human approves the MR content (see the review policy in prompts/bootstrap.md), so human↔foreman
# iteration on the MR stays fast. Edit this constant to change the standard; it is applied additively,
# so the existing `spawn-worker <name> <brief-file>` interface is unchanged.
read -r -d '' DOD_FOOTER <<'EOF' || true

## Definition of done (mandatory — appended by spawn-worker)
Produce a reviewable change FAST, then stop for the human. Before you mark yourself done / exit:
1. Complete your change and COMMIT it on your branch.
2. Sanity-check only: make sure it builds and the repo's QUICK checks pass (unit tests, `bash -n`,
   typecheck — whatever is fast). Fix obvious breakage. Do NOT start a multi-round review.
3. Push and open a **draft** MR/PR against the agreed base branch.
4. Write your status + the MR/PR URL + a one-line summary to notes/tasks/<id>.md, then exit. Foreman
   collects that and takes the MR to the human; the human then iterates with foreman on it.
5. Do NOT run `bin/review-loop` — it is NOT part of definition-of-done. The full review is a
   pre-merge gate foreman runs later, only after the human approves the MR content. Running it here
   is exactly the slow-iteration problem this policy removes.
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
