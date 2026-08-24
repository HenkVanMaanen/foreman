#!/usr/bin/env bash
# spawn-worker — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Launch a detached, fresh-context worker agent — the exact pattern the agent otherwise retypes
# by hand each time (and gets subtly wrong: quoting the brief, redirecting the log, capturing the
# exit). A worker is a full agent instance with its own context window, so it can recurse
# further and a worker blocked on a human never blocks you.
#
# Usage: spawn-worker <name> <brief-file>
#   <name>       identifier for this worker (^[A-Za-z0-9_-]+$); names its log.
#   <brief-file> path to a file holding the worker's brief/prompt (read from a file, so multi-line
#                and apostrophes are safe — write the brief to a file, don't inline it).
#
# ENGINE (FOREMAN_WORKER_ENGINE, default `claude`) — which CLI actually runs the worker:
#   claude  the established pattern, unchanged and still the DEFAULT:
#             claude -p --dangerously-skip-permissions "$(cat <brief>)" > <log> 2>&1
#   codex   the OpenAI Codex CLI, opt-in:
#             codex exec --skip-git-repo-check --color never -s danger-full-access \
#                 -o <last-message> - < <brief> > <log> 2>&1
#           The brief goes over STDIN (`-`), never as an argv string: briefs are long and full of
#           quotes and newlines. FOREMAN_CODEX_MODEL pins the model (unset ⇒ codex's own default).
# Everything OUTSIDE the engine is identical for both: same log path, same `WORKER_EXIT=` marker,
# same `<name>.done` / `<name>.result.json` / `workers.jsonl` contract, same concurrency cap and
# `--force`, so `worker-status` and the supervisor's done-marker poll do not know or care which
# engine ran. Prints the wrapper pid and the log path; poll it with `worker-status <name>`.
set -euo pipefail

# Definition-of-done footer appended to EVERY worker brief. Policy: a worker produces a REVIEWABLE
# DRAFT fast and stops for the human — it does NOT run the heavy multi-round review loop. That
# review (`/review` + /simplify + Codex + /security-review) is a PRE-MERGE gate foreman runs once
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
6. As your VERY LAST act before you exit, write a machine-readable result file so foreman can collect
   your outcome without parsing your log: write to `${FOREMAN_STATE_DIR:-state}/<id>.result.json`
   (where <id> is the name spawn-worker was given) exactly one JSON object:
   `{"status":"done|blocked|needs-verify","branch":"","mr_url":"","summary":"","follow_ups":[]}`
   Fill status honestly, branch = your work branch, mr_url = the draft MR/PR URL, summary = one line,
   follow_ups = any deferred items. spawn-worker synthesises a needs-verify stub if you forget, but
   write it yourself so the recorded status/branch/mr_url are accurate.
EOF

# Parse args: an optional `--force` flag may appear ANYWHERE; the two positionals are <name> <brief>.
# --force bypasses the concurrency cap (see below).
force=0
positional=()
for a in "$@"; do
  case "$a" in
    --force) force=1;;
    *) positional+=("$a");;
  esac
done
set -- ${positional[@]+"${positional[@]}"}

name="${1:?usage: spawn-worker [--force] <name> <brief-file>}"
brief="${2:?usage: spawn-worker [--force] <name> <brief-file>}"

# Validate <name>: it is interpolated into the log file path, so restrict to a safe charset to
# block path-traversal (mirrors wait-reply.sh's <id> posture).
if ! [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "spawn-worker: invalid name '$name' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
fi
[ -f "$brief" ] || { echo "spawn-worker: brief file '$brief' not found" >&2; exit 2; }

state="${FOREMAN_STATE_DIR:-state}"
mkdir -p "$state" 2>/dev/null || true
log="$state/$name-worker.log"
registry="$state/workers.jsonl"
done_file="$state/$name.done"
result_file="$state/$name.result.json"
# codex's `--output-last-message`: the agent's FINAL message, verbatim, without having to parse it
# back out of the transcript log. Written for the codex engine only (claude -p already prints its
# final message as the tail of the log).
last_msg_file="$state/$name-worker.last-message.txt"
# The generated launch wrapper (see below). Kept on disk rather than passed as a `bash -c` string:
# the wrapper now carries the codex did-not-run check, and a multi-line script is the readable,
# testable way to express that.
runner_file="$state/$name-worker.run.sh"

# --- worker engine ------------------------------------------------------------------------------
# Which CLI runs the worker. DEFAULT `claude` — the codex path is strictly opt-in, so an existing
# harness sees no change until someone sets the variable.
engine="${FOREMAN_WORKER_ENGINE:-claude}"
case "$engine" in
  claude|codex) ;;
  *) echo "spawn-worker: unknown FOREMAN_WORKER_ENGINE '$engine' (expected: claude|codex)" >&2; exit 2;;
esac

# The engine command line, emitted as ONE shell line for the generated wrapper to run. Every path is
# already %q-quoted by the caller, so it is a single shell-safe token wherever it lands.
#
# SANDBOX (codex) — `-s danger-full-access`, deliberately, and NOT the tighter `-s workspace-write`.
#   WHY: codex's Linux sandbox is bubblewrap, and bubblewrap cannot start in the container this
#   harness runs in. The same finding review-loop.sh documents above its run_codex(), re-verified on
#   this box 2026-08-24 with a worker-shaped run (prompt over stdin, brief from a file):
#     -s workspace-write     -> 'warning: Codex's Linux sandbox uses bubblewrap and needs access to
#                               create user namespaces', every write refused with
#                               'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
#                               NO file created — and codex still exited 0 while the model happily
#                               reported the work as done.
#     -s danger-full-access  -> works; codex ran the shell command and the file appeared.
#   TRADE-OFF, stated plainly: this removes codex's OWN sandboxing. That is acceptable HERE and only
#   here because the claude engine right beside it already runs every worker as
#   `claude -p --dangerously-skip-permissions` over the same working tree — codex ends up with the
#   access its claude counterpart already has, so it is the same trust model, not a new exposure.
#   Do NOT copy this flag into a context where the agent handles UNTRUSTED input.
#   IF THE BOX CHANGES (new kernel, different container, CAP_NET_ADMIN granted), re-test with
#     codex exec --skip-git-repo-check -s workspace-write "run 'git log --oneline -1'"
#   and put workspace-write back the moment bubblewrap starts.
# `--color never`: the log is read by humans (`worker-status` tails it) and grepped by the
# did-not-run check below; ANSI escapes help neither. codex emits them even when stdout is a file.
worker_run_cmd() {
  local eng="$1" qb="$2" ql="$3" qlast="$4"
  local model="${FOREMAN_CODEX_MODEL:-}" marg=""
  [ -n "$model" ] && marg=" -m $(printf '%q' "$model")"
  case "$eng" in
    claude)
      printf 'claude -p --dangerously-skip-permissions "$(cat %s)" > %s 2>&1\n' "$qb" "$ql";;
    codex)
      printf 'codex exec --skip-git-repo-check --color never -s danger-full-access%s -o %s - < %s > %s 2>&1\n' \
             "$marg" "$qlast" "$qb" "$ql";;
    *) return 2;;
  esac
}

# Lines that mean codex NEVER GOT TO WORK — its sandbox failed to start — as opposed to codex
# working and reporting something. Kept verbatim in sync with review-loop.sh's copy, and narrow for
# the same reason: the first alternative is anchored to line start (bubblewrap writes its errors
# there, while a worker quoting them emits them behind a '#', a '+', a quote or an indent), and the
# second is a full sentence codex itself prints only when it is about to use bubblewrap.
CODEX_SANDBOX_RE="^bwrap:|Codex.s Linux sandbox uses bubblewrap"

# Did this codex worker fail to run AT ALL? Two independent signals, both required — an OBSERVATION
# and a CONFIRMATION — exactly as review-loop.sh learned to do it:
#   HIT      the log matches CODEX_SANDBOX_RE. On its own this is only a hint: a worker whose JOB is
#            to read or edit the sandbox notes in this very repo will quote those strings.
#   CONFIRM  the worker did not write its own <name>.result.json. Writing it needs a tool call, so a
#            worker whose sandbox never started CANNOT have produced one. This is our OWN contract,
#            not a codex UI string, which is why it is the confirmation rather than the prettier
#            "no `succeeded in` line in the transcript" (that marker is unversioned CLI chrome, and
#            if its wording changed we would start reporting healthy workers as broken).
# Both true ⇒ codex ran, did nothing, and — the nasty part, reproduced on this box — exited 0 with
# the model cheerfully claiming success. That must surface as a FAILURE, never as a silent `done`.
codex_did_not_run() {
  local lg="$1" res="$2"
  [ -f "$lg" ] || return 1
  grep -aqE "$CODEX_SANDBOX_RE" "$lg" 2>/dev/null || return 1
  [ -f "$res" ] && return 1
  return 0
}
# Exit code stamped on a confirmed did-not-run. Distinct from anything the engines return
# themselves (codex exits 0 in this state), so `WORKER_EXIT=86` is unambiguous in the log.
CODEX_DID_NOT_RUN_EXIT=86

# Count LIVE review-loop pid markers under $1, deleting any whose pid is dead (stale). A review-loop
# registers an empty file named for its pid under review-loops/ while it runs; "live" = the pid still
# answers `kill -0`. Optional $2 = a pid to EXCLUDE (a review-loop skips its own marker). Echoes the
# live count. Kept in sync verbatim with the copy in review-loop.sh (small, so duplicated not sourced).
_review_loop_load() {
  local rl_dir="$1" self="${2:-}" n=0 f pid
  [ -d "$rl_dir" ] || { printf '0'; return 0; }
  for f in "$rl_dir"/*; do
    [ -e "$f" ] || continue                        # empty dir ⇒ the glob stays literal
    pid="${f##*/}"
    case "$pid" in ''|*[!0-9]*) continue;; esac     # not a pid marker we own — leave it untouched
    if kill -0 "$pid" 2>/dev/null; then
      [ "$pid" = "$self" ] && continue              # our own live marker — do not count it
      n=$((n + 1))
    else
      rm -f "$f" 2>/dev/null || true                # dead pid — clean the stale marker
    fi
  done
  printf '%s' "$n"
}

# --- concurrency cap --------------------------------------------------------------------------
# A worker is a full `claude -p` instance (its own context window, its own token spend); too many
# at once thrash the machine and the budget. A review-loop is HEAVIER still (it drives its own review
# agents), so it counts as 2 slots against the SAME FOREMAN_MAX_WORKERS budget. Cap the combined LOAD
# at FOREMAN_MAX_WORKERS (default 2), where:
#   LOAD = (active workers) + 2*(active review-loops).
#   active workers      = a name that appears as a launch entry in workers.jsonl whose `<name>.done`
#                         marker does NOT yet exist (the wrapper touches it when `claude -p` returns).
#   active review-loops = LIVE pid markers under $state/review-loops (dead-pid markers are cleaned).
# `--force` bypasses the whole check.
max_workers="${FOREMAN_MAX_WORKERS:-2}"
[[ "$max_workers" =~ ^[0-9]+$ ]] || max_workers=2
if [ "$force" -ne 1 ]; then
  active_workers=0
  if [ -f "$registry" ]; then
    # Distinct worker names ever launched. Prefer jq; fall back to a grep/sed extraction of the first
    # "name":"…" on each line (launch and exit entries both carry it — de-duped by sort -u).
    if command -v jq >/dev/null 2>&1; then
      names="$(jq -r '.name // empty' "$registry" 2>/dev/null | sort -u)"
    else
      names="$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' "$registry" 2>/dev/null \
               | sed -E 's/.*"([^"]*)"$/\1/' | sort -u)"
    fi
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      [ -e "$state/$n.done" ] || active_workers=$((active_workers + 1))
    done <<EOF
$names
EOF
  fi
  rl_load="$(_review_loop_load "$state/review-loops")"
  active_total=$((active_workers + 2 * rl_load))
  if [ "$active_total" -ge "$max_workers" ]; then
    detail="$active_workers active worker(s)"
    [ "$rl_load" -gt 0 ] && detail="$detail + $rl_load review-loop(s) at 2 slots each"
    echo "spawn-worker: load $active_total ($detail) >= cap $max_workers (FOREMAN_MAX_WORKERS)." >&2
    echo "spawn-worker: refusing to spawn '$name'. Wait for one to finish (worker-list), stop one" >&2
    echo "spawn-worker: (worker-stop <name>), raise FOREMAN_MAX_WORKERS, or pass --force to override." >&2
    exit 3
  fi
fi

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

# Pre-quote the paths the detached wrapper interpolates; %q makes each a single shell-safe token.
qbrief="$(printf '%q' "$full_brief")"
qlog="$(printf '%q' "$log")"
qdone="$(printf '%q' "$done_file")"
qresult="$(printf '%q' "$result_file")"
qreg="$(printf '%q' "$registry")"
qlast="$(printf '%q' "$last_msg_file")"

run_cmd="$(worker_run_cmd "$engine" "$qbrief" "$qlog" "$qlast")" \
  || { echo "spawn-worker: no launch command for engine '$engine'" >&2; exit 2; }

# The detached wrapper, generated per worker. Structure, and the ORDER, are the done-marker contract
# and are IDENTICAL for both engines: after the engine returns it (1) appends the WORKER_EXIT marker
# to the log, (2) touches `<name>.done` (the single-stat done signal the supervisor polls),
# (3) appends an exit line to the registry, and (4) synthesises a minimal result.json if the worker
# forgot to write one, so `<name>.result.json` always exists once `.done` does. `$name` is
# charset-guarded (A-Za-z0-9_-), so inlining it into the JSON below is safe.
#
# Between the engine and (1) sits the codex did-not-run check — before the WORKER_EXIT line, because
# it OVERRIDES the exit code codex reported (0) with one that says what actually happened.
# Written with an UNQUOTED heredoc: `$q*` and `$run_cmd` are expanded HERE (they are already
# %q-quoted single tokens), while `\$code` and friends stay literal for the wrapper to evaluate at
# run time. Deliberately no `set -e`: the whole point is to survive the engine's non-zero exit and
# record it. codex_did_not_run is emitted from THIS file with `declare -f`, so the wrapper's copy
# can never drift from the one the test exercises.
{
  cat <<EOF
#!/usr/bin/env bash
# Generated by spawn-worker for worker '$name' (engine=$engine). Safe to delete once it is done.
engine=$(printf '%q' "$engine")
CODEX_SANDBOX_RE=$(printf '%q' "$CODEX_SANDBOX_RE")
EOF
  declare -f codex_did_not_run
  cat <<EOF
$run_cmd
code=\$?
blocked=0
if [ "\$engine" = codex ] && codex_did_not_run $qlog $qresult; then
  blocked=1; code=$CODEX_DID_NOT_RUN_EXIT
  {
    echo
    echo "spawn-worker: ** CODEX DID NOT RUN — its sandbox failed to start, so this worker executed"
    echo "spawn-worker: ** NOTHING. codex exits 0 in that state and the model can still report the"
    echo "spawn-worker: ** work as done, so the exit code alone would have lied. Reported as exit"
    echo "spawn-worker: ** $CODEX_DID_NOT_RUN_EXIT. See the bubblewrap note above worker_run_cmd() in spawn-worker."
  } >> $qlog
fi
echo "WORKER_EXIT=\$code" >> $qlog
touch $qdone
printf '{"name":"$name","engine":"$engine","ended_at":"%s","exit":%s}\n' \\
       "\$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%s)" "\$code" >> $qreg
if [ ! -f $qresult ]; then
  if [ "\$blocked" = 1 ]; then
    printf '{"status":"blocked","branch":"","mr_url":"","summary":"codex did not run: its sandbox failed to start, so the worker executed nothing","follow_ups":[]}\n' > $qresult
  else
    printf '{"status":"needs-verify","summary":"exited %s, no result.json"}\n' "\$code" > $qresult
  fi
fi
EOF
} > "$runner_file"

# Detach so the worker outlives this turn.
nohup bash "$runner_file" >/dev/null 2>&1 &
pid=$!

# Registry launch line (append-only). started_at is ISO-8601 UTC, or epoch seconds if `date -u` with
# that format is unavailable. Prefer jq to encode the paths safely; fall back to printf.
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%s)"
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg name "$name" --argjson pid "$pid" --arg log "$log" --arg brief "$brief" \
        --arg started_at "$started_at" \
    '{name:$name,pid:$pid,log:$log,brief:$brief,started_at:$started_at}' >> "$registry" 2>/dev/null || true
else
  printf '{"name":"%s","pid":%s,"log":"%s","brief":"%s","started_at":"%s"}\n' \
    "$name" "$pid" "$log" "$brief" "$started_at" >> "$registry" 2>/dev/null || true
fi

echo "spawned worker '$name' (pid $pid)"
echo "log: $log"
