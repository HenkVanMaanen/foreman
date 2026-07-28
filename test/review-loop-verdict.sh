#!/usr/bin/env bash
# Unit test for review-loop.sh's VERDICT RULE and its CODEX SANDBOX detection — no real Claude, no
# codex, no network, no repo work. Both units are extracted verbatim from the shipped script (never
# re-typed here), so the test cannot drift from the code it claims to cover.
#
# What it pins down:
#   verdict rule    - correctness signals (RISKY finding, ANY security finding, phase ERROR) decide
#                     the verdict; convergence signals (a phase stopping at its round cap, codex not
#                     running) are informational and must NEVER flip it or appear in the WHY line.
#                     FAILED outranks NEEDS-HUMAN outranks CLEAN.
#   codex sandbox   - a bubblewrap/startup failure is detected from the round's output (codex exits
#                     0 in that state, so the exit code alone never told anyone), while the SAME
#                     error text merely QUOTED by a healthy review is not; and a detection that was
#                     never confirmed by the phase must not stop later codex rounds.
#
# shellcheck disable=SC2034  # the units under test are eval'd in from review-loop.sh, so shellcheck
#                            # cannot see that these globals are the INPUTS those units read.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/review-loop.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

fail() { echo "FAIL: $1"; exit 1; }

# --- extract the units under test from the real script ----------------------------------------
# Each range runs from its first line to the next line that is exactly "}" (only a top-level
# function body ends that way in this file).
eval "$(awk '/^VERDICT="CLEAN"/{f=1} f{print} f&&/^}$/{exit}' "$SCRIPT")"
eval "$(awk '/^CODEX_SANDBOX_RE=/{f=1} f{print} f&&/^}$/{exit}' "$SCRIPT")"
command -v compute_verdict >/dev/null 2>&1 || type compute_verdict >/dev/null 2>&1 \
  || fail "could not extract compute_verdict from $SCRIPT"
type run_codex >/dev/null 2>&1 || fail "could not extract run_codex from $SCRIPT"

# === 1. the verdict rule ======================================================================
# check NAME EXPECT_VERDICT EXPECT_RC CR SI CODEX SEC RECON [SEC_FINDINGS]
check() {
  local name="$1" want="$2" want_rc="$3"
  CR_STATUS="$4"; SI_STATUS="$5"; CODEX_STATUS="$6"; SEC_STATUS="$7"; RECONCILE_STATUS="$8"
  SEC_FINDINGS="${9:-}"
  compute_verdict
  [ "$VERDICT" = "$want" ]     || fail "$name: expected verdict $want, got $VERDICT"
  [ "$VERDICT_RC" = "$want_rc" ] || fail "$name: expected exit $want_rc, got $VERDICT_RC"
  echo "  OK  $name -> $VERDICT (exit $VERDICT_RC)"
}

echo "### 1: correctness signals decide the verdict; convergence signals do not ###"
check "all-clean"              CLEAN       0 CLEAN CLEAN         CLEAN       CLEAN CLEAN
check "simplify-capped-only"   CLEAN       0 CLEAN NOT-CONVERGED CLEAN       CLEAN CLEAN
[ -z "$VERDICT_WHY" ] || fail "a round cap must not produce a WHY reason (got: $VERDICT_WHY)"
[ -n "$VERDICT_NOTES" ] || fail "a round cap must be reported as an informational note"
check "reconcile-capped-only"  CLEAN       0 CLEAN CLEAN         CLEAN       CLEAN NOT-CONVERGED
[ -z "$VERDICT_WHY" ] || fail "a reconcile cap must not produce a WHY reason (got: $VERDICT_WHY)"
check "codex-did-not-run"      CLEAN       0 CLEAN CLEAN         DID-NOT-RUN CLEAN CLEAN
[ -z "$VERDICT_WHY" ] || fail "codex not running must not produce a WHY reason (got: $VERDICT_WHY)"
case "$VERDICT_NOTES" in *"DID NOT RUN"*) ;; *) fail "codex DID-NOT-RUN must be noted, got '$VERDICT_NOTES'";; esac
check "phases-skipped"         CLEAN       0 CLEAN CLEAN         SKIPPED     SKIPPED CLEAN

echo "### 2: findings a human must judge ###"
check "code-review-risky"      NEEDS-HUMAN 3 RISKY CLEAN         CLEAN       CLEAN CLEAN
check "codex-risky"            NEEDS-HUMAN 3 CLEAN CLEAN         RISKY       CLEAN CLEAN
check "security-risky"         NEEDS-HUMAN 3 CLEAN CLEAN         CLEAN       RISKY CLEAN \
      "SECFINDING: RISKY | high | a.sh:1 | x -- NOT APPLIED: y"
check "security-finding-fixed" NEEDS-HUMAN 3 CLEAN CLEAN         CLEAN       CLEAN CLEAN \
      "SECFINDING: APPLIED | high | a.sh:1 | unquoted arg — quoted it"
case "$VERDICT_WHY" in *security*) ;; *) fail "an auto-fixed security finding must name security in WHY";; esac
check "final-risky"            NEEDS-HUMAN 3 CLEAN CLEAN         CLEAN       CLEAN RISKY

echo "### 3: a broken gate outranks findings, and is never silently CLEAN ###"
check "phase-error"            FAILED      5 ERROR CLEAN         CLEAN       CLEAN CLEAN
check "error-beats-risky"      FAILED      5 RISKY CLEAN         CLEAN       ERROR CLEAN
check "everything-at-once"     FAILED      5 ERROR NOT-CONVERGED DID-NOT-RUN RISKY NOT-CONVERGED \
      "SECFINDING: RISKY | high | a.sh:1 | x -- NOT APPLIED: y"
case "$VERDICT_WHY" in
  *"round cap"*|*"DID NOT RUN"*) fail "informational signals leaked into the WHY line: $VERDICT_WHY";;
esac
check "unknown-status"         NEEDS-HUMAN 3 CLEAN CLEAN         CLEAN       WAT   CLEAN

echo "### 4: the shipped --self-test-verdict entrypoint still runs ###"
out="$WS/selftest.txt"
bash "$SCRIPT" --self-test-verdict > "$out" 2>&1 || fail "--self-test-verdict exited non-zero"
grep -q "all-clean" "$out"   || fail "--self-test-verdict lost its all-clean case"
grep -q "NEEDS-HUMAN" "$out" || fail "--self-test-verdict covers no NEEDS-HUMAN case"
grep -q "FAILED"      "$out" || fail "--self-test-verdict covers no FAILED case"
echo "  OK  --self-test-verdict"

# === 5. codex sandbox-failure detection =======================================================
echo "### 5: a codex sandbox failure is detected, quoted error text is not ###"
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

echo
echo "ALL REVIEW-LOOP VERDICT + CODEX-SANDBOX TESTS PASSED"
