#!/usr/bin/env bash
# Unit test for review-loop.sh's VERDICT RULE, its ESCALATION PASS and its CODEX SANDBOX detection —
# no real Claude, no codex, no network, no repo work. Every unit is extracted verbatim from the
# shipped script (never re-typed here), so the test cannot drift from the code it claims to cover.
#
# What it pins down:
#   verdict rule    - correctness signals (RISKY finding, ANY security finding, phase ERROR) decide
#                     the verdict; convergence signals (a phase stopping at its round cap, codex not
#                     running) are informational and must NEVER flip it or appear in the WHY line.
#                     What a RISKY finding MEANS is the escalation pass's answer: fixed/refuted ⇒
#                     CLEAN, "needs a product/data/ownership decision" ⇒ NEEDS-DECISION, anything
#                     else ⇒ NEEDS-AI. FAILED (5) > NEEDS-AI (3) > NEEDS-DECISION (6) > CLEAN (0).
#   escalation pass - a RISKY finding is handed to a fresh agent; the pass is BOUNDED (never loops),
#                     an attempt that changes nothing ends it, a pass that emits no verdict line
#                     counts as UNRESOLVED (never silently resolved), an echoed-back output template
#                     is not a verdict, and running out of attempts is reported as UNRESOLVED.
#   codex sandbox   - a bubblewrap/startup failure is detected from the round's output (codex exits
#                     0 in that state, so the exit code alone never told anyone), while the SAME
#                     error text merely QUOTED by a healthy review is not; and a detection that was
#                     never confirmed by the phase must not stop later codex rounds.
#
# shellcheck disable=SC2034,SC2154  # units are eval'd from review-loop.sh, so shellcheck cannot see
#                                  # the extracted functions assign/read these globals.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/review-loop.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

fail() { echo "FAIL: $1"; exit 1; }

# --- extract the units under test from the real script ----------------------------------------
# Each range runs from its first line to the next line that is exactly "}" (only a top-level
# function body ends that way in this file).
extract() { awk -v pat="$1" '$0 ~ pat {f=1} f{print} f&&/^}$/{exit}' "$SCRIPT"; }
eval "$(extract '^VERDICT="CLEAN"')"
eval "$(extract '^CODEX_SANDBOX_RE=')"
eval "$(extract '^_esc_new[(][)]')"
eval "$(extract '^_risky_finding_re=')"
eval "$(extract '^build_escalation_prompt[(][)]')"
eval "$(extract '^run_escalation_phase[(][)]')"
eval "$(extract '^configure_review_engines[(][)]')"
eval "$(extract '^build_codex_simplify_prompt[(][)]')"
eval "$(extract '^build_security_prompt[(][)]')"
eval "$(sed -n '/^LF=/p;/^_esc_mark_seen()/p;/^_esc_count()/p' "$SCRIPT")"
for fn in compute_verdict run_codex _esc_new collect_risky_findings build_escalation_prompt \
          run_escalation_phase _esc_mark_seen _esc_count configure_review_engines \
          build_codex_simplify_prompt build_security_prompt; do
  type "$fn" >/dev/null 2>&1 || fail "could not extract $fn from $SCRIPT"
done

# === 1. the verdict rule ======================================================================
# check NAME EXPECT_VERDICT EXPECT_RC CR SI CODEX SEC RECON ESC [SEC_FINDINGS]
check() {
  local name="$1" want="$2" want_rc="$3"
  CR_STATUS="$4"; SI_STATUS="$5"; CODEX_STATUS="$6"; SEC_STATUS="$7"; RECONCILE_STATUS="$8"
  ESC_STATUS="$9"; SEC_FINDINGS="${10:-}"; ESC_REASON=""
  compute_verdict
  [ "$VERDICT" = "$want" ]     || fail "$name: expected verdict $want, got $VERDICT"
  [ "$VERDICT_RC" = "$want_rc" ] || fail "$name: expected exit $want_rc, got $VERDICT_RC"
  echo "  OK  $name -> $VERDICT (exit $VERDICT_RC)"
}

echo "### 1: correctness signals decide the verdict; convergence signals do not ###"
check "all-clean"              CLEAN       0 CLEAN CLEAN         CLEAN       CLEAN CLEAN         SKIPPED
check "simplify-capped-only"   CLEAN       0 CLEAN NOT-CONVERGED CLEAN       CLEAN CLEAN         SKIPPED
[ -z "$VERDICT_WHY" ] || fail "a round cap must not produce a WHY reason (got: $VERDICT_WHY)"
[ -n "$VERDICT_NOTES" ] || fail "a round cap must be reported as an informational note"
check "reconcile-capped-only"  CLEAN       0 CLEAN CLEAN         CLEAN       CLEAN NOT-CONVERGED SKIPPED
[ -z "$VERDICT_WHY" ] || fail "a reconcile cap must not produce a WHY reason (got: $VERDICT_WHY)"
check "codex-did-not-run"      CLEAN       0 CLEAN CLEAN         DID-NOT-RUN CLEAN CLEAN         SKIPPED
[ -z "$VERDICT_WHY" ] || fail "codex not running must not produce a WHY reason (got: $VERDICT_WHY)"
case "$VERDICT_NOTES" in *"DID NOT RUN"*) ;; *) fail "codex DID-NOT-RUN must be noted, got '$VERDICT_NOTES'";; esac
check "phases-skipped"         CLEAN       0 CLEAN CLEAN         SKIPPED     SKIPPED CLEAN       SKIPPED

echo "### 2: a RISKY finding means whatever the escalation pass says it means ###"
# No escalation pass ran (--escalation-attempts 0): the pre-escalation behaviour, under the new name.
check "risky-no-escalation"    NEEDS-AI    3 RISKY CLEAN         CLEAN       CLEAN CLEAN         SKIPPED
check "codex-risky-no-escal"   NEEDS-AI    3 CLEAN CLEAN         RISKY       CLEAN CLEAN         SKIPPED
check "final-risky-no-escal"   NEEDS-AI    3 CLEAN CLEAN         CLEAN       CLEAN RISKY         SKIPPED
# Escalated and FIXED (or refuted with evidence) — the whole point of the rename: foreman did the
# work instead of handing it back. The correctness phases re-ran over the fix before we get here.
check "risky-escalated-fixed"  CLEAN       0 RISKY CLEAN         CLEAN       CLEAN CLEAN         RESOLVED
[ -z "$VERDICT_WHY" ] || fail "a resolved escalation must not produce a WHY reason (got: $VERDICT_WHY)"
case "$VERDICT_NOTES" in *escalat*) ;; *) fail "a resolved escalation must be noted, got '$VERDICT_NOTES'";; esac
check "risky-escal-cannot-fix" NEEDS-AI    3 RISKY CLEAN         CLEAN       CLEAN CLEAN         UNRESOLVED
case "$VERDICT_WHY" in *"more AI work"*) ;; *) fail "UNRESOLVED must say more AI work is needed";; esac
check "risky-bound-exhausted"  NEEDS-AI    3 RISKY CLEAN         RISKY       CLEAN CLEAN         UNRESOLVED
check "risky-escalation-error" FAILED      5 RISKY CLEAN         CLEAN       CLEAN CLEAN         ERROR
check "unknown-status"         NEEDS-AI    3 CLEAN CLEAN         CLEAN       WAT   CLEAN         SKIPPED

echo "### 3: NEEDS-DECISION — rare, and only an escalation pass can reach it ###"
check "needs-decision"         NEEDS-DECISION 6 RISKY CLEAN      CLEAN       CLEAN CLEAN         DECISION
case "$VERDICT_WHY" in *decision*) ;; *) fail "NEEDS-DECISION must name the decision in WHY: $VERDICT_WHY";; esac
# No phase status can land there on its own — only ESC_STATUS=DECISION does.
for s in RISKY NOT-CONVERGED DID-NOT-RUN ERROR WAT; do
  CR_STATUS="$s"; SI_STATUS=CLEAN; CODEX_STATUS=CLEAN; SEC_STATUS=CLEAN; RECONCILE_STATUS=CLEAN
  ESC_STATUS=UNRESOLVED; SEC_FINDINGS=""; ESC_REASON=""
  compute_verdict
  [ "$VERDICT" != "NEEDS-DECISION" ] || fail "phase status '$s' reached NEEDS-DECISION without an escalation DECISION"
done
echo "  OK  no phase status reaches NEEDS-DECISION on its own"
# Both kinds at once: do the AI work first (NEEDS-AI outranks), but say BOTH in the WHY line.
check "mixed-decision+unfixed" NEEDS-AI    3 RISKY CLEAN         RISKY       CLEAN CLEAN         MIXED
case "$VERDICT_WHY" in *decision*) ;; *) fail "MIXED must still name the decision half: $VERDICT_WHY";; esac
case "$VERDICT_WHY" in *"AI work"*) ;; *) fail "MIXED must still name the unfixed half: $VERDICT_WHY";; esac

echo "### 4: a security finding is never silently cleared ###"
check "security-risky"         NEEDS-AI    3 CLEAN CLEAN         CLEAN       RISKY CLEAN         UNRESOLVED \
      "SECFINDING: RISKY | high | a.sh:1 | x -- NOT APPLIED: y"
check "security-finding-fixed" NEEDS-AI    3 CLEAN CLEAN         CLEAN       CLEAN CLEAN         SKIPPED \
      "SECFINDING: APPLIED | high | a.sh:1 | unquoted arg — quoted it"
case "$VERDICT_WHY" in *security*) ;; *) fail "an auto-fixed security finding must name security in WHY";; esac
# Even when the ESCALATION pass is what fixed it: a vulnerability existed in this branch, so the fix
# is still surfaced rather than disappearing into a CLEAN run.
check "security-escal-fixed"   NEEDS-AI    3 CLEAN CLEAN         CLEAN       RISKY CLEAN         RESOLVED \
      "SECFINDING: RISKY | high | a.sh:1 | auth bypass -- NOT APPLIED: needs a schema change"
case "$VERDICT_WHY" in *security*) ;; *) fail "a security finding fixed by escalation must still be surfaced";; esac

echo "### 5: a broken gate outranks everything, and is never silently CLEAN ###"
check "phase-error"            FAILED      5 ERROR CLEAN         CLEAN       CLEAN CLEAN         SKIPPED
check "error-beats-risky"      FAILED      5 RISKY CLEAN         CLEAN       ERROR CLEAN         RESOLVED
check "error-beats-decision"   FAILED      5 RISKY CLEAN         CLEAN       ERROR CLEAN         DECISION
check "everything-at-once"     FAILED      5 ERROR NOT-CONVERGED DID-NOT-RUN RISKY NOT-CONVERGED MIXED \
      "SECFINDING: RISKY | high | a.sh:1 | x -- NOT APPLIED: y"
case "$VERDICT_WHY" in
  *"round cap"*|*"DID NOT RUN"*) fail "informational signals leaked into the WHY line: $VERDICT_WHY";;
esac

echo "### 6: the shipped --self-test-verdict entrypoint still runs ###"
out="$WS/selftest.txt"
bash "$SCRIPT" --self-test-verdict > "$out" 2>&1 || fail "--self-test-verdict exited non-zero"
grep -q "all-clean" "$out"       || fail "--self-test-verdict lost its all-clean case"
grep -q "NEEDS-AI" "$out"        || fail "--self-test-verdict covers no NEEDS-AI case"
grep -q "NEEDS-DECISION" "$out"  || fail "--self-test-verdict covers no NEEDS-DECISION case"
grep -q "FAILED"      "$out"     || fail "--self-test-verdict covers no FAILED case"
grep -q "NEEDS-HUMAN" "$out"     && fail "--self-test-verdict still reports the retired NEEDS-HUMAN outcome"
echo "  OK  --self-test-verdict"

# === 7. the escalation pass ===================================================================
# run_escalation_phase is driven with a STUBBED agent pass (run_fix_phase) and a stubbed re-check, so
# the bound, the status mapping and the never-silent rule are exercised without an agent.
echo "### 7: the escalation pass is bounded, and never silently resolves a finding ###"
scope_diff_ref="base...HEAD"          # build_escalation_prompt interpolates it
ESC_CALLS=0                            # how many agent passes run_escalation_phase actually asked for
ESC_EMIT=""                            # what the stubbed pass writes into the capture
ESC_PHASE_STATUS="CLEAN"; ESC_PHASE_CHANGED=1
RECHECK_ADDS=""                        # a NEW risky finding the stubbed re-check "discovers"
CR_FINDINGS=""; SEC_FINDINGS=""; CODEX_FINDINGS=""; CODEX_CAP=""

run_fix_phase() {                      # stub: stands in for the whole agent pass
  ESC_CALLS=$((ESC_CALLS + 1))
  [ -n "$ESC_EMIT" ] && printf '%s\n' "$ESC_EMIT" >> "$RUN_CLAUDE_CAPTURE"
  PHASE_STATUS="$ESC_PHASE_STATUS"; PHASE_CHANGED="$ESC_PHASE_CHANGED"; PHASE_ROUNDS=1
  return 0
}
escalation_recheck() {                 # stub: the correctness re-run over the escalation fix
  [ -n "$RECHECK_ADDS" ] && CR_FINDINGS="${CR_FINDINGS:+$CR_FINDINGS$LF}$RECHECK_ADDS$ESC_CALLS"
  return 0
}

esc_run() {  # esc_run ATTEMPTS RISKY_LINES ; leaves ESC_* set, transcript in $WS/esc.log
  escalation_attempts="$1"; CR_FINDINGS="$2"; ESC_CALLS=0
  run_escalation_phase > "$WS/esc.log" 2>&1
}
R1='REVIEWFINDING: RISKY | api.sh:42 | unchecked index -- NOT APPLIED: could change behaviour'
R2='SECFINDING: RISKY | high | auth.sh:7 | token compare is not constant-time -- NOT APPLIED: risky'

esc_run 2 ""
[ "$ESC_STATUS" = "SKIPPED" ] || fail "no RISKY finding must leave escalation SKIPPED, got $ESC_STATUS"
[ "$ESC_CALLS" -eq 0 ] || fail "escalation ran an agent pass with nothing to escalate"
echo "  OK  nothing to escalate -> SKIPPED, no agent pass"

ESC_EMIT="ESCFINDING: FIXED | api.sh:42 | added the bounds check and a test for it"
esc_run 0 "$R1"
[ "$ESC_STATUS" = "SKIPPED" ] || fail "--escalation-attempts 0 must skip escalation, got $ESC_STATUS"
[ "$ESC_CALLS" -eq 0 ] || fail "--escalation-attempts 0 still ran an agent pass"
echo "  OK  --escalation-attempts 0 disables the pass entirely"

esc_run 2 "$R1"
[ "$ESC_STATUS" = "RESOLVED" ] || fail "a FIXED escalation must be RESOLVED, got $ESC_STATUS"
[ "$ESC_CALLS" -eq 1 ] || fail "a resolved escalation took $ESC_CALLS passes, expected 1"
[ "$ESC_CHANGED" -eq 1 ] || fail "an escalation that changed code must report ESC_CHANGED=1"
echo "  OK  risky -> escalated -> fixed -> RESOLVED (1 pass)"

ESC_EMIT="ESCFINDING: DECISION | data-migration | model.ts:88 | filing this under the right heading needs a new stored field, i.e. migrating saved annotations"
esc_run 2 "$R1"
[ "$ESC_STATUS" = "DECISION" ] || fail "a DECISION escalation must report DECISION, got $ESC_STATUS"
echo "  OK  risky -> escalated -> cannot-fix (product/data call) -> DECISION"

ESC_EMIT="ESCFINDING: UNRESOLVED | api.sh:42 | could not reproduce the path; needs the caller's contract"
esc_run 2 "$R1"
[ "$ESC_STATUS" = "UNRESOLVED" ] || fail "an UNRESOLVED escalation must report UNRESOLVED, got $ESC_STATUS"
echo "  OK  risky -> escalated -> still a coding problem -> UNRESOLVED"

ESC_EMIT="ESCFINDING: DECISION | product | a.ts:1 | which default applies is a product call
ESCFINDING: UNRESOLVED | b.ts:2 | needs an interface I cannot see"
esc_run 2 "$R1"
[ "$ESC_STATUS" = "MIXED" ] || fail "both kinds at once must report MIXED, got $ESC_STATUS"
echo "  OK  decision + unfixed in one pass -> MIXED"

# A pass that answers with NOTHING must never be read as "resolved" — that is how a RISKY finding
# would be laundered into a CLEAN run.
ESC_EMIT=""
esc_run 2 "$R1"
[ "$ESC_STATUS" = "UNRESOLVED" ] || fail "a silent escalation pass must be UNRESOLVED, got $ESC_STATUS"
grep -q "no ESCFINDING line" "$WS/esc.log" || fail "a silent escalation pass must say so in the transcript"
echo "  OK  a pass that emits no verdict line counts as UNRESOLVED"

# ...and neither must a pass that merely echoes its own output contract back.
ESC_EMIT="  ESCFINDING: FIXED | <file:line-or-area> | <what you changed and why it is correct>"
esc_run 2 "$R1"
[ "$ESC_STATUS" = "UNRESOLVED" ] || fail "an echoed-back output template must not count as a verdict, got $ESC_STATUS"
echo "  OK  an echoed-back output template is not a verdict"

# A pass that answers for only SOME of the findings it was given must not resolve the rest.
ESC_EMIT="ESCFINDING: FIXED | api.sh:42 | fixed the first one"
esc_run 2 "$R1$LF$R2"
[ "$ESC_STATUS" = "UNRESOLVED" ] || fail "a partial answer must leave the rest UNRESOLVED, got $ESC_STATUS"
grep -q "fewer findings than it was given" "$WS/esc.log" || fail "a partial answer must say so in the transcript"
echo "  OK  a pass that answers for only some findings leaves the rest UNRESOLVED"

# An attempt that changes no code ends the phase: a second identical pass would only repeat it.
ESC_EMIT="ESCFINDING: UNRESOLVED | api.sh:42 | blast radius is bigger than this branch"
ESC_PHASE_CHANGED=0
esc_run 2 "$R1"
[ "$ESC_CALLS" -eq 1 ] || fail "an attempt that changed nothing must end the phase, ran $ESC_CALLS passes"
ESC_PHASE_CHANGED=1
echo "  OK  an attempt that changes nothing ends the phase"

# THE BOUND. Every attempt fixes its finding but the re-check keeps discovering a new one: the phase
# must stop at --escalation-attempts and report the leftovers as UNRESOLVED, not spin.
ESC_EMIT="ESCFINDING: FIXED | api.sh:42 | fixed it"
RECHECK_ADDS='REVIEWFINDING: RISKY | api.sh:99 | another one -- NOT APPLIED: n'
esc_run 2 "$R1"
[ "$ESC_CALLS" -eq 2 ] || fail "the escalation bound is 2 attempts, but $ESC_CALLS passes ran"
[ "$ESC_ATTEMPTS" -eq 2 ] || fail "expected ESC_ATTEMPTS=2, got $ESC_ATTEMPTS"
[ "$ESC_STATUS" = "UNRESOLVED" ] || fail "an exhausted bound must report UNRESOLVED, got $ESC_STATUS"
case "$ESC_REASON" in *"bound exhausted"*) ;; *) fail "an exhausted bound must say so: $ESC_REASON";; esac
echo "  OK  the attempt bound stops the phase and reports the leftovers UNRESOLVED"
# ...and 1 attempt really means 1.
esc_run 1 "$R1"
[ "$ESC_CALLS" -eq 1 ] || fail "--escalation-attempts 1 ran $ESC_CALLS passes"
echo "  OK  --escalation-attempts N is the hard bound (N=1 -> 1 pass)"
RECHECK_ADDS=""

# A finding already answered is never re-sent; a genuinely NEW one is.
ESC_EMIT="ESCFINDING: FIXED | api.sh:42 | fixed it"
esc_run 2 "$R1"
_esc_mark_seen "$R1"
[ -z "$(_esc_new "$R1")" ] || fail "an already-escalated finding must not be handed over twice"
[ -n "$(_esc_new "$R2")" ] || fail "a NEW risky finding must still be handed over"
echo "  OK  each finding is escalated at most once"

# A broken escalation pass is a broken gate, not a resolved finding.
ESC_PHASE_STATUS="ERROR"
esc_run 2 "$R1"
[ "$ESC_STATUS" = "ERROR" ] || fail "an ERRORing escalation pass must report ERROR, got $ESC_STATUS"
ESC_PHASE_STATUS="CLEAN"
echo "  OK  an ERRORing escalation pass reports ERROR (-> FAILED)"

# The risky collector reads all three reviewer families and ignores non-risky lines.
CR_FINDINGS="REVIEWFINDING: APPLIED | a.sh:1 | fixed${LF}$R1"
SEC_FINDINGS="$R2"
CODEX_FINDINGS="CODEXFINDING: RISKY | bug | c.go:3 | racy -- NOT APPLIED: unsure"
got="$(collect_risky_findings | wc -l | tr -d ' ')"
[ "$got" = "3" ] || fail "collect_risky_findings should have found 3 RISKY lines, found $got"
collect_risky_findings | grep -q "REVIEWFINDING: APPLIED" && fail "collect_risky_findings picked up a non-RISKY line"
echo "  OK  the collector gathers RISKY findings from all three reviewers only"
CR_FINDINGS=""; SEC_FINDINGS=""; CODEX_FINDINGS=""

# The prompt must actually tell the pass what DECISION is for — and what it is NOT for.
p="$(build_escalation_prompt "$R1")"
case "$p" in *"$R1"*) ;; *) fail "the escalation prompt does not carry the finding text";; esac
case "$p" in *"NOT APPLIED"*) ;; *) fail "the escalation prompt does not explain the earlier refusal";; esac
for phrase in "ESCALATION pass" "ALREADY STORED" "ownership/policy" "is NOT a DECISION" "UNRESOLVED"; do
  case "$p" in *"$phrase"*) ;; *) fail "the escalation prompt is missing '$phrase'";; esac
done
echo "  OK  the escalation prompt defines FIXED / DISMISSED / DECISION / UNRESOLVED"
unset -f run_fix_phase escalation_recheck

# === 8. codex sandbox-failure detection =======================================================
echo "### 8: a codex sandbox failure is detected, quoted error text is not ###"
_indent_tee() { sed 's/^/    | /' >/dev/null; }   # swallow the transcript; we assert on the flag
dir="$WS"; codex_model="stub"; RUN_CLAUDE_CAPTURE=""
mkdir -p "$WS/bin"; PATH="$WS/bin:$PATH"
mk_codex() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WS/bin/codex"; chmod +x "$WS/bin/codex"; }

# The real failure shape, captured from this box: codex exits 0, bubblewrap's error is on the stream.
mk_codex 'echo "warning: Codex'"'"'s Linux sandbox uses bubblewrap and needs access to create user namespaces."
echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
exit 0'
CODEX_SANDBOX_HIT=0; CODEX_SANDBOX_CONFIRMED=0; CODEX_SCAN=""
rc=0; run_codex "review" || rc=$?
[ "$rc" = 0 ] || fail "the stub codex should exit 0 (that is the point: the exit code hides it)"
[ "$CODEX_SANDBOX_HIT" = 1 ] || fail "a real sandbox failure was not detected"
echo "  OK  sandbox failure detected (codex exit 0)"

# A healthy review that quotes those very errors — this loop reviews the file documenting them.
mk_codex 'cat <<EOT
Reviewing the diff; the comment documents:
#   -s workspace-write -> "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
+#  bwrap: setting up uid map: Permission denied
CODEXFINDING: NONE
EOT'
CODEX_SANDBOX_HIT=0; CODEX_SANDBOX_CONFIRMED=0
run_codex "review" || fail "healthy stub should exit 0"
[ "$CODEX_SANDBOX_HIT" = 0 ] || fail "quoted sandbox error text must NOT count as a failure"
echo "  OK  quoted error text is not a failure"

# An unconfirmed hit must not stop later rounds (that would turn a false positive into a phase ERROR).
CODEX_SANDBOX_HIT=1; CODEX_SANDBOX_CONFIRMED=0
mk_codex 'echo "CODEXFINDING: NONE"; exit 0'
run_codex "review" || fail "an UNconfirmed hit must not block a codex round"
echo "  OK  an unconfirmed hit does not block later rounds"

# Once the phase confirms it, further rounds are refused instead of burning calls. The stub leaves a
# marker file if it is ever executed, so "was codex invoked?" is asserted directly.
CODEX_SANDBOX_CONFIRMED=1
rm -f "$WS/codex-ran"
mk_codex 'touch '"$WS"'/codex-ran; exit 0'
rc=0; run_codex "review" || rc=$?
[ "$rc" != 0 ] || fail "a confirmed sandbox failure must return non-zero"
[ ! -e "$WS/codex-ran" ] || fail "codex was invoked despite a CONFIRMED sandbox failure"
echo "  OK  a confirmed failure stops further codex calls"

# The invocation itself must use danger-full-access (workspace-write cannot start bwrap here).
grep -q 'codex exec --skip-git-repo-check -s danger-full-access' "$SCRIPT" \
  || fail "run_codex must invoke codex with -s danger-full-access (see the bubblewrap note)"
echo "  OK  codex is invoked with -s danger-full-access"

# === 9. review-engine selection ================================================================
echo "### 9: review phases and the independent cross-check always use opposite engines ###"
ENGINE_DIE=""
die_usage() { ENGINE_DIE="$1"; return 2; }

unset FOREMAN_REVIEW_ENGINE
review_engine="${FOREMAN_REVIEW_ENGINE:-claude}"
configure_review_engines
[ "$phase_runner:$crosscheck_engine:$crosscheck_runner" = "run_claude:codex:run_codex" ] \
  || fail "unset engine did not preserve Claude phases + Codex cross-check"
default_selection="$phase_runner:$crosscheck_engine:$crosscheck_runner"

FOREMAN_REVIEW_ENGINE=claude; review_engine="$FOREMAN_REVIEW_ENGINE"
configure_review_engines
[ "$phase_runner:$crosscheck_engine:$crosscheck_runner" = "$default_selection" ] \
  || fail "unset and explicit claude engine selections differ"
grep -q 'claude -p --dangerously-skip-permissions "$slash" </dev/null' "$SCRIPT" \
  || fail "the established Claude phase command changed"
echo "  OK  unset == explicit claude: unchanged claude runner + codex cross-check"

FOREMAN_REVIEW_ENGINE=codex; review_engine="$FOREMAN_REVIEW_ENGINE"
configure_review_engines
[ "$phase_runner:$crosscheck_engine:$crosscheck_runner" = "run_codex:claude:run_claude" ] \
  || fail "codex engine did not select Codex phases + Claude cross-check"
[ "$phase_runner" != "$crosscheck_runner" ] || fail "codex phases are cross-checking themselves"
echo "  OK  codex phases -> independent claude cross-check"

scope_diff_ref="base...HEAD"
p="$(build_codex_simplify_prompt)"
for phrase in "TASTE/CLEANUP" "reuse:" "simplification:" "efficiency:" "altitude:" "conventions:" "preserve exact"; do
  case "$p" in *"$phrase"*) ;; *) fail "codex simplify prompt is missing '$phrase'";; esac
done
review_engine=codex
p="$(build_security_prompt)"
case "$p" in *"over 80%"*"SECFINDING: APPLIED"*"SECFINDING: RISKY"*) ;;
  *) fail "codex security prompt lost /security-review's confidence filter or output markers";;
esac
grep -q 'run_codex "$codex_review_prompt"' "$SCRIPT" \
  || fail "codex review report no longer reuses run_codex"
grep -q 'codex_review_prompt="$(build_review_prompt)"' "$SCRIPT" \
  || fail "codex review report lost the scoped REVIEWFINDING prompt"
echo "  OK  codex prompts preserve simplify/security intent and parser markers"

rc=0
FOREMAN_REVIEW_ENGINE=wat bash "$SCRIPT" --self-test-verdict > "$WS/bad-engine.out" 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "unknown FOREMAN_REVIEW_ENGINE must exit 2 before work (got $rc)"
grep -q "unknown FOREMAN_REVIEW_ENGINE 'wat'" "$WS/bad-engine.out" \
  || fail "unknown engine rejection was not loud"
echo "  OK  unknown FOREMAN_REVIEW_ENGINE is rejected before self-test/work"

# === 10. the label rename =====================================================================
# The phase runs `/review`, so nothing user-facing may still call it `code-review`. Only genuine
# references to the retired `/code-review` COMMAND may remain.
echo "### 10: the phase is labelled after the command it actually runs ###"
stale="$(grep -n 'code-review' "$SCRIPT" | grep -v '/code-review' || true)"
[ -z "$stale" ] || fail "stale 'code-review' phase label(s) in $SCRIPT:$LF$stale"
grep -q '^run_review_phase "review"' "$SCRIPT" || fail "the main phase is no longer invoked as 'review'"
echo "  OK  no stale 'code-review' phase label outside /code-review command references"

echo
echo "ALL REVIEW-LOOP VERDICT + ESCALATION + CODEX-SANDBOX TESTS PASSED"
