#!/usr/bin/env bash
# Engine dispatch and completion contract against harmless CLI shims in temporary state.
# Sandbox prose is only a hint: omitted result.json cannot prove that no commands ran.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/spawn-worker.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

fail() { echo "FAIL: $1"; exit 1; }
ok()   { echo "  ok: $1"; }

# --- 0. syntax guard --------------------------------------------------------------------------
# The cheapest possible regression net: a worker that cannot even parse is a harness outage, and
# spawn-worker is edited far more often than it is exercised.
bash -n "$SCRIPT" || fail "spawn-worker.sh does not parse (bash -n)"
ok "spawn-worker.sh parses"
for s in "$HERE/examples/agent-bin/worker-status.sh"; do
  bash -n "$s" || fail "$(basename "$s") does not parse (bash -n)"
done
ok "worker-status.sh parses"

# --- extract the units under test from the real script ------------------------------------------
# Same convention as review-loop-verdict.sh: a function body runs from its opening line to the next
# line that is exactly "}" (only a top-level function body ends that way in this file).
extract_fn()   { awk -v pat="$1" '$0 ~ pat {f=1} f{print} f&&/^}$/{exit}' "$SCRIPT"; }
extract_line() { grep -m1 -E "$1" "$SCRIPT"; }
eval "$(extract_line '^CODEX_SANDBOX_RE=')"
eval "$(extract_fn '^worker_run_cmd[(][)]')"
eval "$(extract_fn '^codex_sandbox_hint[(][)]')"
[ -n "${CODEX_SANDBOX_RE:-}" ] || fail "could not extract CODEX_SANDBOX_RE"

# --- 1. engine dispatch -------------------------------------------------------------------------
unset FOREMAN_CODEX_MODEL
cl="$(worker_run_cmd claude /BRIEF /LOG /LAST)" || fail "worker_run_cmd claude failed"
case "$cl" in
  "claude -p --dangerously-skip-permissions \"\$(cat /BRIEF)\" > /LOG 2>&1"*) ;;
  *) fail "claude engine line changed — today's behaviour must be byte-identical: $cl";;
esac
case "$cl" in *codex*) fail "claude engine line mentions codex: $cl";; esac
ok "engine=claude reproduces the established claude -p line"

cx="$(worker_run_cmd codex /BRIEF /LOG /LAST)" || fail "worker_run_cmd codex failed"
case "$cx" in "codex exec "*) ;; *) fail "codex engine does not run 'codex exec': $cx";; esac
case "$cx" in *"-s danger-full-access"*) ;; *) fail "codex engine lost -s danger-full-access: $cx";; esac
case "$cx" in *"- < /BRIEF"*) ;; *) fail "codex engine must read the brief from STDIN: $cx";; esac
case "$cx" in *"\"\$(cat"*) fail "codex engine passes the brief as an argv string: $cx";; esac
case "$cx" in *"-o /LAST"*) ;; *) fail "codex engine does not capture the last message: $cx";; esac
case "$cx" in *"> /LOG 2>&1"*) ;; *) fail "codex engine does not write the standard log: $cx";; esac
ok "engine=codex runs 'codex exec', brief on stdin, danger-full-access, same log path"

case "$cx" in *"-m gpt-6-astra"*) ;; *) fail "codex engine lost its gpt-6-astra default: $cx";; esac
case "$cx" in *"model_reasoning_effort=xhigh"*) ;; *) fail "codex engine lost its xhigh default: $cx";; esac
cxm="$(FOREMAN_CODEX_MODEL='gpt-5.6-sol' worker_run_cmd codex /BRIEF /LOG /LAST)"
case "$cxm" in *"-m gpt-5.6-sol"*) ;; *) fail "FOREMAN_CODEX_MODEL not honoured: $cxm";; esac
ok "Codex workers default to gpt-6-astra/xhigh; FOREMAN_CODEX_MODEL overrides the model"

rc=0; worker_run_cmd gemini /BRIEF /LOG /LAST >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "unknown engine should return 2, got $rc"
ok "unknown engine is rejected"

# --- 2. sandbox diagnostics -------------------------------------------------------------------
# A REAL captured bubblewrap failure: codex warns, every command dies, the model answers anyway, and
# codex exits 0. Reproduced on this box with `codex exec -s workspace-write` on 2026-08-24.
broken="$WS/broken.log"
cat > "$broken" <<'EOF'
OpenAI Codex v0.144.6
warning: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.
codex
Unable to complete: the sandbox rejected the command with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
EOF
# A HEALTHY worker whose JOB touched the sandbox notes, so its output quotes the same strings.
quoted="$WS/quoted.log"
cat > "$quoted" <<'EOF'
codex
exec /usr/bin/bash -lc 'git diff' in /repo
 succeeded in 0ms:
+  #   -s workspace-write -> 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'
EOF
res="$WS/w.result.json"; rm -f "$res"

codex_sandbox_hint "$broken" "$res" || fail "a sandbox hint was NOT detected"
ok "sandbox prose is detected as a hint despite codex exiting 0"

printf '{"status":"done"}\n' > "$res"
! codex_sandbox_hint "$broken" "$res" \
  || fail "detection fired even though the worker wrote its own result.json"
rm -f "$res"
ok "a worker that wrote result.json is never called did-not-run (it demonstrably ran)"

! codex_sandbox_hint "$quoted" "$res" \
  || fail "quoted sandbox text false-triggered the detection (regex is not line-anchored enough)"
ok "the same error text quoted mid-line does not false-trigger"

: > "$WS/clean.log"
! codex_sandbox_hint "$WS/clean.log" "$res" || fail "a clean log triggered the detection"
! codex_sandbox_hint "$WS/nope.log" "$res"  || fail "a missing log triggered the detection"
ok "a clean or missing log never triggers the detection"

# --- 3. end-to-end, both engines ------------------------------------------------------------------
# Drive the REAL spawn-worker against shim binaries. Each leg asserts the full shared contract, which
# is what "the interface must not change" actually means.
export FOREMAN_STATE_DIR="$WS/state"
mkdir -p "$FOREMAN_STATE_DIR" "$WS/bin"
printf 'do the thing\n' > "$WS/brief.txt"
# claude shim: echoes its argv so we can prove the brief still arrives as ONE argument.
cat > "$WS/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "CLAUDE_ARGC=$#"
echo "CLAUDE_BRIEF_HEAD=$(printf '%s' "$3" | head -n1)"
EOF
chmod +x "$WS/bin/claude"
export PATH="$WS/bin:$PATH"

run_worker() {
  ( cd "$WS" && env -i PATH="$WS/bin:/usr/bin:/bin" FOREMAN_STATE_DIR="$FOREMAN_STATE_DIR" \
      FOREMAN_WORKER_ENGINE="${FOREMAN_WORKER_ENGINE:-claude}" bash "$SCRIPT" --force "$@" >/dev/null )
}
await() { # the wrapper is detached; wait for its done-marker
  local n="$1" i=0
  while [ ! -e "$FOREMAN_STATE_DIR/$n.done" ]; do
    i=$((i + 1)); [ "$i" -gt 100 ] && fail "worker '$n' never produced a done-marker"
    sleep 0.1
  done
}
assert_contract() {
  local n="$1" want_exit="$2" want_status="$3"
  local log="$FOREMAN_STATE_DIR/$n-worker.log"
  [ -f "$log" ] || fail "$n: no log at the contracted path"
  grep -q "^WORKER_EXIT=$want_exit\$" "$log" || fail "$n: expected WORKER_EXIT=$want_exit, got '$(grep '^WORKER_EXIT=' "$log")'"
  grep -q "\"name\":\"$n\"" "$FOREMAN_STATE_DIR/workers.jsonl" || fail "$n: no registry entry"
  grep -q "\"exit\":$want_exit" "$FOREMAN_STATE_DIR/workers.jsonl" || fail "$n: registry exit code wrong"
  grep -q "\"status\":\"$want_status\"" "$FOREMAN_STATE_DIR/$n.result.json" \
    || fail "$n: expected result.json status '$want_status', got $(cat "$FOREMAN_STATE_DIR/$n.result.json")"
  ( cd "$HERE" && bash examples/agent-bin/worker-status.sh "$n" >/dev/null ) \
    || fail "$n: worker-status could not read this worker"
}

FOREMAN_WORKER_ENGINE=claude run_worker e2eclaude "$WS/brief.txt"
await e2eclaude
grep -q '^CLAUDE_ARGC=3$' "$FOREMAN_STATE_DIR/e2eclaude-worker.log" \
  || fail "claude engine no longer passes the brief as a single argv argument"
grep -q '^CLAUDE_BRIEF_HEAD=do the thing$' "$FOREMAN_STATE_DIR/e2eclaude-worker.log" \
  || fail "claude engine did not deliver the composed brief"
assert_contract e2eclaude 0 needs-verify
ok "engine=claude: brief as one argv arg, WORKER_EXIT/done/result.json/registry all as before"

# codex shim #1 — replay sandbox prose and exit 0 without a result. This remains unverified.
cat > "$WS/bin/codex" <<EOF
#!/usr/bin/env bash
cat > "$WS/codex-stdin.txt"
cat "$broken"
exit 0
EOF
chmod +x "$WS/bin/codex"
FOREMAN_WORKER_ENGINE=codex run_worker e2ebroken "$WS/brief.txt"
await e2ebroken
head -n1 "$WS/codex-stdin.txt" | grep -q '^do the thing$' \
  || fail "codex engine did not deliver the brief on stdin"
grep -q 'Definition of done' "$WS/codex-stdin.txt" \
  || fail "codex engine did not deliver the definition-of-done footer"
assert_contract e2ebroken 0 needs-verify
grep -q 'execution unverified' "$FOREMAN_STATE_DIR/e2ebroken.result.json" \
  || fail "sandbox evidence must remain unverified"
ok "engine=codex: sandbox prose without a result requires verification and preserves the real exit"

# codex shim #2 — really ran (writes its own result.json) but its OUTPUT quotes the sandbox errors.
cat > "$WS/bin/codex" <<EOF
#!/usr/bin/env bash
cat > /dev/null
cat "$broken"
printf '{"status":"done","branch":"b","mr_url":"","summary":"s","follow_ups":[]}\n' \
  > "\$FOREMAN_STATE_DIR/e2equoter.result.json"
exit 0
EOF
chmod +x "$WS/bin/codex"
FOREMAN_WORKER_ENGINE=codex run_worker e2equoter "$WS/brief.txt"
await e2equoter
assert_contract e2equoter 0 done
if grep -q 'CODEX DID NOT RUN' "$FOREMAN_STATE_DIR/e2equoter-worker.log"; then
  fail "a worker that really ran was reported as did-not-run"
fi
ok "engine=codex: a worker that really ran keeps its own result.json and exit code"

# An unknown engine must be refused BEFORE anything is spawned.
rc=0
FOREMAN_WORKER_ENGINE=gemini run_worker e2ebad "$WS/brief.txt" 2>/dev/null || rc=$?
[ "$rc" -eq 2 ] || fail "spawn-worker accepted an unknown engine (rc=$rc)"
if [ -e "$FOREMAN_STATE_DIR/e2ebad.done" ]; then
  fail "spawn-worker spawned a worker for an unknown engine"
fi
ok "an unknown FOREMAN_WORKER_ENGINE is refused before spawning"

echo "PASS: spawn-worker engine selection + conservative sandbox diagnostics"
