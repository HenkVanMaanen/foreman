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
#           quotes and newlines. FOREMAN_CODEX_MODEL pins the model and FOREMAN_CODEX_EFFORT the
#           reasoning effort (defaults: gpt-6-astra and xhigh).
# Everything OUTSIDE the engine is identical for both: same log path, same `WORKER_EXIT=` marker,
# same `<name>.done` / `<name>.result.json` / `workers.jsonl` contract, same concurrency cap and
# `--force`, so `worker-status` and the supervisor's done-marker poll do not know or care which
# engine ran. Prints the wrapper pid and the log path; poll it with `worker-status <name>`.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/worker-state.sh"

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
mkdir -p "$state"
state="$(cd "$state" && pwd)"
log="$state/$name-worker.log"
registry="$state/workers.jsonl"
done_file="$state/$name.done"
result_file="$state/$name.result.json"
# codex's `--output-last-message`: the agent's FINAL message, verbatim, without having to parse it
# back out of the transcript log. Written for the codex engine only (claude -p already prints its
# final message as the tail of the log).
last_msg_file="$state/$name-worker.last-message.txt"
# The generated runner stays on disk as launch evidence.
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
# sandbox hint below; ANSI escapes help neither. codex emits them even when stdout is a file.
worker_run_cmd() {
  local eng="$1" qb="$2" ql="$3" qlast="$4"
  local model="${FOREMAN_CODEX_MODEL:-gpt-6-astra}" marg=""
  [ -n "$model" ] && marg=" -m $(printf '%q' "$model")"
  # FOREMAN_CODEX_EFFORT pins codex's reasoning effort (default xhigh). It is a
  # config override rather than a flag, so it goes through -c like any other config key.
  local effort="${FOREMAN_CODEX_EFFORT:-xhigh}"
  [ -n "$effort" ] && marg="$marg -c model_reasoning_effort=$(printf '%q' "$effort")"
  case "$eng" in
    claude)
      printf 'claude -p --dangerously-skip-permissions "$(cat %s)" > %s 2>&1\n' "$qb" "$ql";;
    codex)
      printf 'codex exec --skip-git-repo-check --color never -s danger-full-access%s -o %s - < %s > %s 2>&1\n' \
             "$marg" "$qlast" "$qb" "$ql";;
    *) return 2;;
  esac
}

# Sandbox prose can be emitted by a successful command reading these very docs. A missing
# result is a contract omission, not evidence that no command ran. Keep this as a diagnostic
# hint only; never replace the engine exit code or claim that the worker executed nothing.
CODEX_SANDBOX_RE="^bwrap:|Codex.s Linux sandbox uses bubblewrap"
codex_sandbox_hint() {
  local lg="$1" res="$2"
  [ ! -f "$res" ] && [ -f "$lg" ] && grep -aqE "$CODEX_SANDBOX_RE" "$lg" 2>/dev/null
}

# Names are durable run identifiers. Reusing one could let an old .done/result (or late exit)
# complete the new run. Refuse without deleting or overwriting any previous evidence.
for artifact in "$log" "$done_file" "$result_file" "$runner_file" "$last_msg_file" "$state/$name.launch" "$state/$name.child"; do
  [ ! -e "$artifact" ] || { echo "spawn-worker: '$name' already has run artifacts; use a new name" >&2; exit 2; }
done
[ -z "$(worker_field "$state" "$name" name)" ] || {
  echo "spawn-worker: '$name' is already registered; use a new name" >&2; exit 2;
}

# Separate sessions survive caller process-group cleanup, but not cgroup cleanup. Foreground
# mode lets a service manager own the entire lifetime. Explicit nohup preserves the old mode.
launch="${FOREMAN_WORKER_LAUNCH:-auto}"
case "$launch" in
  auto) if command -v setsid >/dev/null 2>&1; then launch=setsid; else launch=nohup; fi;;
  setsid) command -v setsid >/dev/null 2>&1 || { echo "spawn-worker: setsid unavailable" >&2; exit 2; };;
  nohup|foreground) ;;
  *) echo "spawn-worker: unknown FOREMAN_WORKER_LAUNCH '$launch' (auto|setsid|nohup|foreground)" >&2; exit 2;;
esac

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
#   active workers      = running, starting, orphaned, or unverified launches. A lost wrapper
#                         frees a slot only when its recorded engine child is also gone.
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
      names="$(jq -Rr 'fromjson? | .name // empty' "$registry" | sort -u)"
    else
      names="$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' "$registry" 2>/dev/null \
               | sed -E 's/.*"([^"]*)"$/\1/' | sort -u || true)"
    fi
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      if worker_slot_active "$state" "$n"; then active_workers=$((active_workers + 1)); fi
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

# Atomically reserve this run name before composing any artifacts. Concurrent same-name
# callers cannot overwrite each other's runner or consume each other's completion.
if ! (set -o noclobber; printf '%s pending\n' "$(date +%s)" > "$state/$name.launch") 2>/dev/null; then
  echo "spawn-worker: '$name' was already reserved; use a new name" >&2
  exit 2
fi

# Compose the brief the worker actually receives: the caller's brief followed by the standard
# definition-of-done footer. Written to a file so multi-line
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
qresult="$(printf '%q' "$result_file")"
qreg="$(printf '%q' "$registry")"
qlast="$(printf '%q' "$last_msg_file")"

run_cmd="$(worker_run_cmd "$engine" "$qbrief" "$qlog" "$qlast")" \
  || { echo "spawn-worker: no launch command for engine '$engine'" >&2; exit 2; }

json_string() {
  local s="$1" code char escape
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  # Bash strings cannot contain NUL; escape every other JSON control byte.
  for ((code=1; code<32; code++)); do
    printf -v char '\\%03o' "$code"
    printf -v char '%b' "$char"
    printf -v escape '\\u%04x' "$code"
    s="${s//"$char"/"$escape"}"
  done
  printf '"%s"' "$s"
}

# The runner owns registration and finalization. Its acknowledgement records the ACTUAL runner
# PID (setsid may fork), and its EXIT trap publishes result + registry BEFORE the wake marker.
# Paths/cwd are pinned so a prepared runner does not silently operate in a recovery caller's cwd.
{
  cat <<EOF
#!/usr/bin/env bash
engine=$(printf '%q' "$engine")
name=$(printf '%q' "$name")
state=$(printf '%q' "$state")
log=$qlog
result=$qresult
registry=$qreg
brief=$(printf '%q' "$brief")
launch=$(printf '%q' "$launch")
CODEX_SANDBOX_RE=$(printf '%q' "$CODEX_SANDBOX_RE")
EOF
  declare -f worker_identity codex_sandbox_hint json_string
  cat <<'EOF'
child=""
interrupted=""
launching=0
interrupt_status=0
child_group_running() {
  local processes pgid stat
  kill -0 -- "-$child" 2>/dev/null || return 1
  processes="$(ps -eo pgid=,stat=)" || return 0
  while read -r pgid stat; do
    # Orphaned zombies may await the host's reaper, but can no longer do work.
    if [ "$pgid" = "$child" ]; then
      case "$stat" in Z*|X*) ;; *) return 0;; esac
    fi
  done <<< "$processes"
  return 1
}
stop_child_group() {
  [ -n "$child" ] || return 0
  local signal attempt
  for signal in "${interrupted:-TERM}" KILL; do
    kill -s "$signal" -- "-$child" 2>/dev/null || true
    for ((attempt=0; attempt<20; attempt++)); do
      if ! child_group_running; then
        wait "$child" 2>/dev/null || true
        return 0
      fi
      sleep 0.05
    done
  done
  # Do not publish completion or free capacity if even KILL cannot stop the group.
  printf '%s unknown\n' "$child" > "$state/$name.child.tmp.$$" && \
    mv "$state/$name.child.tmp.$$" "$state/$name.child"
  echo "spawn-worker: child process group did not stop; completion unverified" >> "$log"
  return 1
}
finish() {
  local code="$1" summary
  trap - EXIT
  trap '' TERM INT HUP
  stop_child_group || return 1
  summary="exited $code, no result.json"
  if [ -n "$interrupted" ]; then
    summary="interrupted by $interrupted; verify partial work"
  elif [ "$engine" = codex ] && codex_sandbox_hint "$log" "$result"; then
    summary="exited $code, no result.json; sandbox text observed, execution unverified"
    echo "spawn-worker: sandbox text observed; quoted output and a real failure cannot be distinguished without further evidence" >> "$log"
  fi
  if [ ! -f "$result" ]; then
    printf '{"status":"needs-verify","branch":"","mr_url":"","summary":"%s","follow_ups":[]}\n' "$summary" \
      > "$result.tmp.$$" && mv "$result.tmp.$$" "$result" || return 1
  fi
  printf 'WORKER_EXIT=%s\n' "$code" >> "$log" || return 1
  printf '{"name":"%s","engine":"%s","ended_at":"%s","exit":%s}\n' \
    "$name" "$engine" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" >> "$registry" || return 1
  touch "$state/$name.done"
}
interrupt() {
  interrupted="$1"
  interrupt_status="$2"
  trap '' TERM INT HUP
  [ "$launching" -eq 0 ] || return 0
  exit "$interrupt_status"
}
trap 'finish $?' EXIT
trap 'interrupt TERM 143' TERM
trap 'interrupt INT 130' INT
trap 'interrupt HUP 129' HUP
export FOREMAN_STATE_DIR="$state"
EOF
  cat <<EOF
cd $(printf '%q' "$PWD") || exit 1
EOF
  cat <<'EOF'
identity="$(worker_identity "$$")" || exit 1
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Retain the historical launch fields together, with safely encoded paths.
printf '{"name":"%s","pid":%s,"log":%s,"brief":%s,"engine":"%s","launcher":"%s","started_at":"%s"}\n' \
  "$name" "$$" "$(json_string "$log")" "$(json_string "$brief")" "$engine" "$launch" "$started_at" >> "$registry" || exit 1
printf '%s %s %s\n' "$(date +%s)" "$$" "$identity" > "$state/$name.launch.tmp.$$" && \
  mv "$state/$name.launch.tmp.$$" "$state/$name.launch" || exit 1
EOF
  cat <<EOF
# Job control gives the engine an owned process group and preserves foreground SIGINT.
# Restore the historical background stdin; codex's explicit brief redirect overrides it.
set -m
# Defer interruption until the engine PID is available to finalization.
launching=1
</dev/null $run_cmd &
child=\$!
set +m
launching=0
[ -z "\$interrupted" ] || exit "\$interrupt_status"
if child_identity="\$(worker_identity "\$child")"; then :
elif [ "\$?" -eq 2 ]; then child_identity=unknown
else child_identity=exited
fi
printf '%s %s\n' "\$child" "\$child_identity" > "\$state/\$name.child.tmp.\$\$" && \
  mv "\$state/\$name.child.tmp.\$\$" "\$state/\$name.child"
wait "\$child"
exit \$?
EOF
} > "$runner_file"

# Durable intent exists even if the child never reaches its first instruction. A stale pending
# launch is UNKNOWN (needs attention), never proof that it is running or safe to relaunch.
# Preserve launch path fields in the registry, also in environments without jq.

printf '{"name":"%s","log":%s,"brief":%s,"requested_at":"%s"}\n' \
  "$name" "$(json_string "$log")" "$(json_string "$brief")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$registry"

clean_env=(env -u MATTERMOST_BOT_TOKEN -u TELEGRAM_BOT_TOKEN -u FOREMAN_ROUTER_TOKEN -u FOREMAN_ROUTER_SOCKET)
if [ "$launch" = foreground ]; then
  exec "${clean_env[@]}" bash "$runner_file" >> "$log" 2>&1
elif [ "$launch" = setsid ]; then
  "${clean_env[@]}" nohup setsid bash "$runner_file" </dev/null >> "$log" 2>&1 &
else
  "${clean_env[@]}" nohup bash "$runner_file" </dev/null >> "$log" 2>&1 &
fi

# Bounded acknowledgement: don't report a successful spawn solely because $! was allocated.
for ((attempt=0; attempt<50; attempt++)); do
  read -r requested pid identity < "$state/$name.launch" || true
  if [[ "${pid:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "spawned worker '$name' (pid $pid; $launch)"
    echo "log: $log"
    exit 0
  fi
  sleep 0.1
done
echo "spawn-worker: '$name' did not acknowledge startup; inspect $log and worker-status (it may start later)" >&2
exit 1
