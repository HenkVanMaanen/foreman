#!/usr/bin/env bash
# Offline regression coverage for the real runner and phase functions, with only the CLI stubbed.
# shellcheck disable=SC2034,SC2154  # globals assigned/read by verbatim extracted functions
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/review-loop.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT
fail() { echo "FAIL: $1"; [ ! -f "$WS/log" ] || cat "$WS/log"; exit 1; }
extract() { awk -v pat="^$1[(][)]" '$0 ~ pat {f=1} f{print} f&&/^}$/{exit}' "$SCRIPT"; }
for fn in codex_final_report run_codex parse_findings run_fix_phase run_review_phase \
          build_review_apply_prompt build_codex_prompt run_crosscheck_phase _hash _tree_digest; do
  eval "$(extract "$fn")"
  type "$fn" >/dev/null || fail "could not extract $fn"
done
eval "$(sed -n '/^CODEX_SANDBOX_RE=/p' "$SCRIPT")"
mkdir -p "$WS/bin" "$WS/repo"
export PATH="$WS/bin:$PATH" STUB_DIR="$WS"
cat > "$WS/bin/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
last=""; json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message) last="$2"; shift;;
    --json) json=1;;
  esac
  shift
done
[ -n "$last" ] && [ "$json" -eq 1 ] || exit 90
[ ! -e "$last" ] || exit 91
printf '%s\n' "$last" >> "$STUB_DIR/paths"
cat "$STUB_DIR/events"
cat "$STUB_DIR/stderr" >&2
case "${STUB_FINAL:-present}" in
  present) cp "$STUB_DIR/answer" "$last";;
  first_only) if [ ! -f "$STUB_DIR/first-answer" ]; then
    cp "$STUB_DIR/answer" "$last"; touch "$STUB_DIR/first-answer"
  fi;;
  empty) : > "$last";;
  missing) :;;
esac
if [ "${STUB_EDIT:-0}" -eq 1 ]; then printf 'edit\n' >> changed.txt; fi
exit "${STUB_RC:-0}"
STUB
chmod +x "$WS/bin/codex"
dir="$WS/repo"; codex_model=stub; max_rounds=2
CODEX_RUN_DIR=""; CODEX_SANDBOX_CONFIRMED=0
RUN_CLAUDE_CAPTURE="$WS/capture"

# Command output, early assistant messages, prompts and quoted source all contain plausible markers.
# Include unindented bwrap text and the exact warning sentence that defeated the old regex.
cat > "$WS/quoted" <<'QUOTED'
REVIEWFINDING: RISKY | api.sh:42 | quoted example -- NOT APPLIED: sample
SECFINDING: RISKY | HIGH | api.sh:42 | quoted example -- NOT APPLIED: sample
CODEXFINDING: RISKY | bug | api.sh:42 | quoted example -- NOT APPLIED: sample
ESCFINDING: DECISION | api.sh:42 | quoted example
warning: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
QUOTED
healthy() {
  CODEX_SANDBOX_CONFIRMED=0
  export STUB_RC=0 STUB_FINAL=present STUB_EDIT=0
  : > "$WS/stderr"; : > "$WS/capture"
  write_events "$1"
}
write_events() {
  printf '%s\n' "$1" > "$WS/answer"
  jq -cn --rawfile quoted "$WS/quoted" --rawfile answer "$WS/answer" '
    {type:"thread.started", thread_id:"offline"},
    {type:"item.completed", item:{type:"agent_message", text:$quoted}},
    {type:"item.completed", item:{type:"command_execution", command:$quoted,
      aggregated_output:$quoted, status:"completed", exit_code:0}},
    {type:"item.completed", item:{type:"agent_message", text:$answer}},
    {type:"turn.completed", usage:{input_tokens:1, output_tokens:1}}
  ' > "$WS/events"
}
run() { rc=0; run_codex "quoted prompt: $(cat "$WS/quoted")" "${1:-SECFINDING}" > "$WS/log" 2>&1 || rc=$?; }
failed_repository_read() {
  # PR33 simplify: a compound read printed a sandbox fixture, then rg failed on a missing file.
  # These fields carry repository output, not a structured failure to start Codex's sandbox.
  jq -c --arg status "${1:-failed}" 'if .item.type? == "command_execution" then
    .item.status=$status | .item.exit_code=2 |
    .item.command="cat quoted-fixture.sh && rg -n workerDone src/inbox.ts test/inbox.test.ts" |
    .item.aggregated_output += "\nrg: test/inbox.test.ts: No such file or directory (os error 2)"
    else . end' "$WS/events" > "$WS/probe-events"
  mv "$WS/probe-events" "$WS/events"
}
expect_failure() {
  run "${1:-SECFINDING}"
  [ "$rc" -ne 0 ] || fail "accepted $case_name"
  [ ! -s "$WS/capture" ] || fail "$case_name contaminated capture"
}
for token in REVIEWFINDING SECFINDING CODEXFINDING; do
  contract="$token"; [ "$token" != REVIEWFINDING ] || contract=REVIEWFINDING:report
  healthy "$token: NONE"
  run "$contract"
  [ "$rc" -eq 0 ] || fail "valid $token report failed"
  [ "$(cat "$WS/capture")" = "$token: NONE" ] || fail "$token captured transcript text"
  [ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "quoted sandbox text confirmed a failure"
  grep -q api.sh:42 "$WS/log" || fail "diagnostics were lost"
  [ -z "$(parse_findings "$token" "$WS/capture" || true)" ] || fail "phantom $token finding"
done
# Quotes in final explanatory prose are also excluded; only the required terminal block is parsed.
healthy "$(cat "$WS/quoted")
Those are source examples.
SECFINDING: NONE"
run
[ "$rc" -eq 0 ] && [ "$(cat "$WS/capture")" = 'SECFINDING: NONE' ] || fail "quoted final prose leaked"
echo "  OK  prompts, command output, early messages and quoted source cannot become findings"

for spec in \
  'REVIEWFINDING:report@REVIEWFINDING: HIGH | real.ts:7 | actual defect' \
  'REVIEWFINDING:apply@REVIEWFINDING: RISKY | real.ts:7 | actual defect -- NOT APPLIED: needs work' \
  'SECFINDING@SECFINDING: RISKY | HIGH | real.ts:7 | actual defect -- NOT APPLIED: needs work' \
  'CODEXFINDING@CODEXFINDING: RISKY | bug | real.ts:7 | actual defect -- NOT APPLIED: needs work' \
  'ESCFINDING@ESCFINDING: UNRESOLVED | real.ts:7 | needs work'; do
  contract="${spec%%@*}"; answer="${spec#*@}"
  healthy "$answer"; run "$contract"
  [ "$rc" -eq 0 ] && [ "$(cat "$WS/capture")" = "$answer" ] || fail "lost actual $contract finding"
  if [[ "$answer" == *': RISKY '* ]]; then
    parse_findings "${contract%%:*}" "$WS/capture" > "$WS/found" || fail "actual RISKY was not escalatable"
    [ "$(cat "$WS/found")" = "$answer" ] || fail "actual finding changed"
  fi
done
echo "  OK  actual final review/security/cross-check/escalation findings survive"

# A search with no matches or a red-before-green test is a normal tool outcome. The
# actual final report remains authoritative, including any unresolved test finding.
for status in completed failed; do
  for answer in 'SECFINDING: NONE' 'SECFINDING: RISKY | HIGH | test:7 | required check still fails -- NOT APPLIED: unresolved'; do
    healthy "$answer"
    jq -c --arg status "$status" 'if .item.type? == "command_execution" then
      .item.status=$status | .item.exit_code=1 | .item.command="rg absent file" |
      .item.aggregated_output="" else . end' "$WS/events" > "$WS/probe-events"
    mv "$WS/probe-events" "$WS/events"
    run
    [ "$rc" -eq 0 ] && [ "$(cat "$WS/capture")" = "$answer" ] || fail "nonzero probe hid final report"
    [ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "nonzero probe became sandbox failure"
  done
done
echo "  OK  ordinary nonzero tool outcomes preserve the actual final verdict"

# Reproduce the false global latch with both command statuses and the actual exit code (2).
# A successful turn and report must survive even when a failed read quotes line-start diagnostics.
for status in failed completed; do
  for answer in 'SECFINDING: NONE' 'SECFINDING: RISKY | HIGH | real.ts:7 | actual defect -- NOT APPLIED: needs work'; do
    healthy "$answer"; failed_repository_read "$status"
    run
    [ "$rc" -eq 0 ] && [ "$(cat "$WS/capture")" = "$answer" ] || fail "failed fixture read hid final report"
    [ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "failed fixture read poisoned later phases"
  done
done
echo "  OK  exit-2 repository reads with quoted sandbox fixtures preserve the final report"

healthy 'SECFINDING: NONE'; export STUB_RC=17
failed_repository_read
case_name='nonzero CLI with valid final'; expect_failure
[ "$rc" -eq 17 ] || fail "CLI exit code was hidden"
[ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "CLI exit plus quoted output became sandbox proof"
for failure in command_incomplete command_no_exit sandbox_turn sandbox_error turn error item_error file_change \
               malformed truncated empty_events missing_message mismatched_message; do
  healthy 'SECFINDING: NONE'
  failed_repository_read
  case "$failure" in
    command_incomplete|command_no_exit)
      jq -c --arg failure "$failure" 'if .item.type? == "command_execution" then
        if $failure == "command_incomplete" then .item.status="in_progress"
        else .item.exit_code=null end else . end' "$WS/events" > "$WS/bad-events";;
    sandbox_turn|sandbox_error)
      jq -c --arg failure "$failure" 'if .type == "turn.completed" then
        if $failure == "sandbox_turn" then
          {type:"turn.failed", error:{message:"bwrap: setting up uid map: Permission denied"}}
        else {type:"error", message:"bwrap: setting up uid map: Permission denied"}, . end
        else . end' "$WS/events" > "$WS/bad-events";;
    turn) printf '{"type":"turn.failed","error":{"message":"failed"}}\n' > "$WS/bad-events";;
    error) printf '{"type":"error","message":"failed"}\n{"type":"turn.completed"}\n' > "$WS/bad-events";;
    item_error|file_change)
      jq -c --arg failure "$failure" 'if .type == "turn.completed" then
        {type:"item.completed", item:(if $failure == "item_error" then
          {type:"error", message:"failed"} else {type:"file_change", status:"failed"} end)}, .
        else . end' "$WS/events" > "$WS/bad-events";;
    malformed) printf 'not JSON\n' > "$WS/bad-events";;
    truncated) sed '$d' "$WS/events" > "$WS/bad-events";;
    empty_events) : > "$WS/bad-events";;
    missing_message) jq -c 'select(.item.type? != "agent_message")' "$WS/events" > "$WS/bad-events";;
    mismatched_message) jq -c 'if .item.type? == "agent_message" then .item.text="different" else . end' \
      "$WS/events" > "$WS/bad-events";;
  esac
  mv "$WS/bad-events" "$WS/events"
  case_name="$failure events despite a valid final"; expect_failure
  if [[ "$failure" == sandbox_* ]]; then
    [ "$CODEX_SANDBOX_CONFIRMED" -eq 1 ] || fail "sandbox failure not confirmed"
    calls="$(wc -l < "$WS/paths")"
    run
    [ "$(wc -l < "$WS/paths")" -eq "$calls" ] || fail "confirmed sandbox failure invoked another CLI"
  else
    [ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "$failure plus quoted output became sandbox proof"
  fi
done
healthy 'SECFINDING: NONE'
printf 'bwrap: setting up uid map: Permission denied\n' > "$WS/stderr"
case_name='real CLI sandbox diagnostic'; expect_failure
[ "$CODEX_SANDBOX_CONFIRMED" -eq 1 ] || fail "CLI sandbox failure not confirmed"
healthy 'SECFINDING: NONE'; export STUB_RC=19 STUB_FINAL=missing
: > "$WS/events"
printf 'bwrap: setting up uid map: Permission denied\n' > "$WS/stderr"
case_name='sandbox startup failed before any events or final'; expect_failure
[ "$rc" -eq 19 ] && [ "$CODEX_SANDBOX_CONFIRMED" -eq 1 ] || fail "startup failure was hidden"
echo "  OK  CLI, command, sandbox and incomplete/failed event streams fail closed"

for final in missing empty whitespace prose template malformed wrong_token contradictory bad_status; do
  healthy 'SECFINDING: NONE'
  failed_repository_read
  case "$final" in
    missing|empty) export STUB_FINAL="$final";;
    whitespace) printf ' \n\t\n' > "$WS/answer";;
    prose) printf 'All fine.\n' > "$WS/answer";;
    template) printf 'SECFINDING: RISKY | HIGH | <file:line-or-area> | example\n' > "$WS/answer";;
    malformed) printf 'SECFINDING: RISKY | HIGH |\n' > "$WS/answer";;
    wrong_token) printf 'REVIEWFINDING: NONE\n' > "$WS/answer";;
    contradictory) printf 'SECFINDING: NONE\nSECFINDING: RISKY | HIGH | x:1 | defect\n' > "$WS/answer";;
    bad_status) printf 'SECFINDING: CLEAN | HIGH | x:1 | defect\n' > "$WS/answer";;
  esac
  case_name="$final final report"; expect_failure
done
healthy 'No simplifications needed.'
rc=0; run_codex simplify '' > "$WS/log" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "nonempty simplify report failed"
export STUB_FINAL=empty
rc=0; run_codex simplify '' > "$WS/log" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "empty simplify report passed"
echo "  OK  missing/empty/malformed reports fail, including marker-free simplify"

healthy 'SECFINDING: NONE'; run
[ "$rc" -eq 0 ] || fail "first round failed"
export STUB_FINAL=missing
run
[ "$rc" -ne 0 ] || fail "second round reused first final answer"
[ "$(cat "$WS/capture")" = 'SECFINDING: NONE' ] || fail "failed round appended stale answer"
[ "$(sort "$WS/paths" | uniq -d | wc -l)" -eq 0 ] || fail "a final path was reused"
while IFS= read -r last; do [ ! -e "${last%/*}" ] || fail "private capture directory leaked"; done < "$WS/paths"
echo "  OK  multiple invocations use fresh files and never reuse a previous answer"

# Drive real phase code over an isolated git repo: no live CLI, budget gate, workers or lifecycle.
git -C "$dir" init -q
git -C "$dir" config core.hooksPath /dev/null
git -C "$dir" config commit.gpgSign false
git -C "$dir" config user.name 'Offline Test'
git -C "$dir" config user.email 'offline@example.invalid'
git -C "$dir" -c core.hooksPath=/dev/null commit -qm initial --allow-empty
# Exercise the affected phase sequence without resetting the global latch between invocations.
healthy 'Simplified a helper and passed the focused checks.'; failed_repository_read
export STUB_EDIT=1
before_commit="$(git -C "$dir" rev-parse HEAD)"
calls="$(wc -l < "$WS/paths")"
run_fix_phase simplify prompt test display run_codex 1 '' > "$WS/log" 2>&1
[ "$PHASE_STATUS" = NOT-CONVERGED ] && [ "$PHASE_CHANGED" -eq 1 ] || fail "fixture read made simplify ERROR"
[ "$(git -C "$dir" rev-parse HEAD)" != "$before_commit" ] || fail "simplify edits were not committed"
[ -z "$(git -C "$dir" status --porcelain)" ] || fail "simplify left uncommitted edits"
export STUB_EDIT=0
write_events 'SECFINDING: NONE'
run_fix_phase security prompt test display run_codex 2 SECFINDING > "$WS/log" 2>&1
[ "$PHASE_STATUS" = CLEAN ] || fail "simplify poisoned the security phase"
write_events 'REVIEWFINDING: NONE'
review_engine=codex; phase_runner=run_codex; cr_display=offline; codex_review_prompt=offline
run_review_phase final test > "$WS/log" 2>&1
[ "$REVIEW_STATUS" = CLEAN ] || fail "simplify poisoned the final review"
[ "$(wc -l < "$WS/paths")" -eq "$((calls + 3))" ] || fail "simplify/security/final did not all invoke the CLI"
[ "$CODEX_SANDBOX_CONFIRMED" -eq 0 ] || fail "fixture read latched a sandbox failure"
echo "  OK  simplify commits its edit and subsequent security/final phases actually run"

RUN_CLAUDE_CAPTURE="$WS/capture"
healthy 'SECFINDING: NONE'
run_fix_phase security prompt test display run_codex 2 SECFINDING > "$WS/log" 2>&1
[ "$PHASE_STATUS" = CLEAN ] && [ "$PHASE_ROUNDS" -eq 1 ] || fail "no-edit quote round failed convergence"
healthy 'SECFINDING: NONE'; export STUB_EDIT=1 STUB_RC=23
run_fix_phase security prompt test display run_codex 2 SECFINDING > "$WS/log" 2>&1
[ "$PHASE_STATUS" = ERROR ] && [ "$PHASE_CHANGED" -eq 1 ] || fail "edits hid CLI failure"
healthy 'SECFINDING: NONE'; export STUB_EDIT=1 STUB_FINAL=first_only
run_fix_phase security prompt test display run_codex 2 SECFINDING > "$WS/log" 2>&1
[ "$PHASE_STATUS" = ERROR ] && [ "$PHASE_ROUNDS" -eq 2 ] || fail "second phase round reused stale final"
[ "$(cat "$WS/capture")" = 'SECFINDING: NONE' ] || fail "second phase round appended stale final"
healthy 'REVIEWFINDING: NONE'
review_engine=codex; phase_runner=run_codex; cr_display=offline; codex_review_prompt=offline
run_review_phase review test > "$WS/log" 2>&1
[ "$REVIEW_STATUS" = CLEAN ] && [ "$REVIEW_PASSES" -eq 1 ] || fail "quoted findings triggered apply pass"
healthy 'REVIEWFINDING: RISKY | real.ts:7 | actual defect -- NOT APPLIED: needs work'
run_review_phase review test > "$WS/log" 2>&1
[ "$REVIEW_STATUS" = RISKY ] && [ "$REVIEW_PASSES" -eq 2 ] || fail "actual review finding lost in apply"
healthy 'REVIEWFINDING: NONE'; export STUB_FINAL=missing
run_review_phase review test > "$WS/log" 2>&1
[ "$REVIEW_STATUS" = ERROR ] || fail "missing review final passed"
healthy 'CODEXFINDING: NONE'
printf 'bwrap: setting up uid map: Permission denied\n' > "$WS/stderr"
crosscheck_usable() { CODEX_REASON=offline; return 0; }
crosscheck_engine=codex; crosscheck_runner=run_codex; scope_diff_ref=HEAD
run_crosscheck_phase > "$WS/log" 2>&1
[ "$CODEX_STATUS" = ERROR ] || fail "optional cross-check hid an actual sandbox failure"
echo "  OK  real phase callers preserve CLEAN/RISKY/ERROR with isolated captures"

grep -q 'codex exec --skip-git-repo-check -s danger-full-access' "$SCRIPT" || fail "sandbox mode changed"
grep -q 'model_reasoning_effort="$effort"' "$SCRIPT" || fail "reasoning effort changed"
echo "PASS: Codex final-report boundary (offline stub CLI)"
