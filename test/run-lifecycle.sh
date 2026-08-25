#!/usr/bin/env bash
# Exercises the supervisor's full lifecycle against mock-claude (no real Claude, no
# network). Verifies cold-start workspace seeding + both recycle paths:
#   1. context watchdog: soft mark → hard mark → checkpoint → recycle
#   2. agent-initiated: clear-request sentinel → recycle
#   3. claude auth-required: injected frame → established relay → relaunch
#   4. codex auth-required: injected frame → codex-only safe rehearsal → real-call verifier
#   5. codex verification failure: the relay refuses to declare recovery or relaunch
#   6. production-shaped codex device flow: mock login + post-login PONG, never local status
#   7. codex supervising session: initial exec → resumed turns → checkpoint/recycle
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

# Pin every FOREMAN_* path into the temp workspace so the suite is hermetic
# regardless of ambient env. On the foreman box these are exported as absolute
# real-repo paths, which (config defaults being relative) would otherwise leak
# in and split state/notes between the real repo and $WS → spurious failures.
export FOREMAN_STATE_DIR="$WS/state" FOREMAN_NOTES_DIR="$WS/notes" \
       FOREMAN_WORKTREES_DIR="$WS/worktrees" FOREMAN_AGE_IDENTITY="$WS/state/age-identity.txt"
unset FOREMAN_STATE_REPO FOREMAN_CLAUDE_EXTRA_ARGS FOREMAN_AGE_RECIPIENT \
      FOREMAN_RELOGIN_ENGINE FOREMAN_CODEX_BIN FOREMAN_SESSION_ENGINE \
      FOREMAN_CODEX_EXTRA_ARGS

export FOREMAN_CLAUDE_BIN="$HERE/test/mock-claude.ts"
export FOREMAN_BOOTSTRAP_PROMPT="$HERE/prompts/bootstrap.md"
export FOREMAN_CONTEXT_WINDOW=1000 MOCK_STEP=300
cd "$WS"

fail() { echo "FAIL: $1"; exit 1; }
assert_grep() { grep -q "$1" "$2" || fail "expected to see: $1"; }
# Negative assertion. Checks the file EXISTS first: a bare `grep -q X f && fail` also "passes"
# when f is missing or unreadable, so a renamed log would silently turn the guard into a no-op.
refute_grep() {
  [ -r "$2" ] || fail "expected $2 to exist (cannot check for absence of: $1)"
  grep -q "$1" "$2" && fail "did NOT expect to see: $1"
  return 0
}

echo "### scenario 1: context watchdog recycle ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
timeout 30 bun run "$HERE/src/foreman.ts" supervise >"$WS/s1.log" 2>&1 \
  || { cat "$WS/s1.log"; fail "supervisor errored"; }
cat "$WS/s1.log"
assert_grep "agent launched; bootstrap sent" "$WS/s1.log"
assert_grep "hard mark hit" "$WS/s1.log"
assert_grep "checkpoint turn complete → recycling" "$WS/s1.log"
assert_grep "relaunching fresh" "$WS/s1.log"
assert_grep "agent process ended" "$WS/s1.log"
[ -f "$WS/notes/INDEX.md" ] || fail "notes not seeded on cold start"
[ -x "$WS/bin/ask-human" ] || fail "bin/ask-human not seeded/executable"
[ -x "$WS/bin/foreman" ] || fail "bin/foreman shim not seeded"
echo "  scenario 1 OK"

echo "### scenario 2: agent-initiated clear-request recycle ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
MOCK_MODE=clear timeout 30 bun run "$HERE/src/foreman.ts" supervise >"$WS/s2.log" 2>&1 \
  || { cat "$WS/s2.log"; fail "supervisor errored"; }
cat "$WS/s2.log"
assert_grep "agent requested clear → recycling" "$WS/s2.log"
assert_grep "relaunching fresh" "$WS/s2.log"
echo "  scenario 2 OK"

echo "### scenario 3: auth-required → re-login relay → relaunch ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
# Pre-seed the two bin/ scripts the relay shells out to. ensureWorkspace() only copies a
# reference script when the destination is absent, so these stubs win — the relay is exercised
# without a Mattermost/Telegram credential anywhere in sight.
mkdir -p "$WS/bin" "$WS/state"
cat > "$WS/bin/reply" <<'STUB'
#!/usr/bin/env bash
{ echo "--- relay message ---"; cat; echo; } >> "$FOREMAN_STATE_DIR/relay-sent.txt"
STUB
cat > "$WS/bin/wait-reply" <<'STUB'
#!/usr/bin/env bash
# The human relaying the sign-in code back. The always-on poller is the only caller (the relay
# reads the queue that poller fills), so this stub has to behave like a real inbox poll:
#   • answer only AFTER the relay has actually sent the link (bin/reply writes relay-sent.txt) —
#     a code "sent" before the human was asked for one is a pre-lockout message, which the
#     supervisor deliberately holds back from the relay,
#   • answer exactly ONCE, then go quiet with exit 3 ("nothing new"), because the poller loops
#     for the harness's whole lifetime and would otherwise re-feed the same code forever.
sent="$FOREMAN_STATE_DIR/relay-sent.txt"
once="$FOREMAN_STATE_DIR/code-relayed"
if [ -f "$sent" ] && [ ! -f "$once" ]; then
  : > "$once"
  echo "MSG 1 - GOODCODE"
  exit 0
fi
sleep 1  # a real poll blocks; keep it short so the loop's exit isn't held up by an in-flight one
exit 3
STUB
chmod +x "$WS/bin/reply" "$WS/bin/wait-reply"
# FOREMAN_FAKE_AUTH_REQUIRED reports life 1's first frame as an auth failure — the whole point
# of the seam — so the relay runs for real against mock-claude's `auth login`.
FOREMAN_FAKE_AUTH_REQUIRED=1 timeout 60 bun run "$HERE/src/foreman.ts" supervise \
  >"$WS/s3.log" 2>&1 || { cat "$WS/s3.log"; fail "supervisor errored"; }
cat "$WS/s3.log"
assert_grep "auth required (injected" "$WS/s3.log"
# The relayed code reached the login command's tty. (Checked on disk, not in the log: the
# login child runs under a pty whose output the relay drains once it has the URL.)
assert_grep "GOODCODE" "$WS/state/mock-auth-ok.code"
# Recovered → the loop relaunches rather than exiting for the keeper. Asserted on the SECOND
# life specifically: life 1 logs "agent launched" before the injected auth frame ever fires, so
# a bare grep for it would pass even if the relay had never relaunched anything.
assert_grep "life 2 started" "$WS/s3.log"
refute_grep "re-login .* → exiting" "$WS/s3.log"
assert_grep "1. Open: https://claude.ai/oauth/authorize" "$WS/state/relay-sent.txt"
assert_grep "re-authenticated" "$WS/state/relay-sent.txt"
grep -q '"kind":"auth-required"' "$WS/state/events.jsonl" || fail "no auth-required event recorded"
grep -q '"kind":"relogin","detail":"recovered"' "$WS/state/events.jsonl" \
  || fail "no recovered relogin event recorded"
echo "--- claude relay transcript ---"
cat "$WS/state/relay-sent.txt"
echo "  scenario 3 OK"

echo "### scenario 4: codex auth-required → codex relay only → verified relaunch ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
mkdir -p "$WS/bin" "$WS/state"
cat > "$WS/bin/reply" <<'STUB'
#!/usr/bin/env bash
{ echo "--- relay message ---"; cat; echo; } >> "$FOREMAN_STATE_DIR/relay-sent.txt"
STUB
cat > "$WS/bin/wait-reply" <<'STUB'
#!/usr/bin/env bash
sleep 1
exit 3
STUB
chmod +x "$WS/bin/reply" "$WS/bin/wait-reply"
FOREMAN_RELOGIN_ENGINE=codex FOREMAN_CODEX_BIN="$HERE/test/mock-codex.ts" \
  FOREMAN_FAKE_AUTH_REQUIRED=1 MOCK_CODEX_VERIFY=healthy \
  timeout 60 bun run "$HERE/src/foreman.ts" supervise >"$WS/s4.log" 2>&1 \
  || { cat "$WS/s4.log"; fail "codex supervisor rehearsal errored"; }
cat "$WS/s4.log"
assert_grep "auth required (injected" "$WS/s4.log"
assert_grep "codex verification passed (real PONG call)" "$WS/s4.log"
assert_grep "life 2 started" "$WS/s4.log"
assert_grep "Rehearsal: Codex auth is being treated as dead" "$WS/state/relay-sent.txt"
assert_grep "Codex auth works again" "$WS/state/relay-sent.txt"
refute_grep "claude needs re-authentication" "$WS/state/relay-sent.txt"
refute_grep "\[harness\]" "$WS/state/relay-sent.txt"
assert_grep "exec --skip-git-repo-check --color never reply with exactly: PONG" \
  "$WS/state/mock-codex-calls.txt"
refute_grep "login status" "$WS/state/mock-codex-calls.txt"
refute_grep "login --device-auth" "$WS/state/mock-codex-calls.txt"
echo "--- codex rehearsal relay transcript ---"
cat "$WS/state/relay-sent.txt"
echo "  scenario 4 OK"

echo "### scenario 5: still-dead codex auth → verification rejects → no relaunch ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
mkdir -p "$WS/bin" "$WS/state"
cat > "$WS/bin/reply" <<'STUB'
#!/usr/bin/env bash
{ echo "--- relay message ---"; cat; echo; } >> "$FOREMAN_STATE_DIR/relay-sent.txt"
STUB
cat > "$WS/bin/wait-reply" <<'STUB'
#!/usr/bin/env bash
sleep 1
exit 3
STUB
chmod +x "$WS/bin/reply" "$WS/bin/wait-reply"
FOREMAN_RELOGIN_ENGINE=codex FOREMAN_CODEX_BIN="$HERE/test/mock-codex.ts" \
  FOREMAN_FAKE_AUTH_REQUIRED=1 MOCK_CODEX_VERIFY=dead \
  timeout 60 bun run "$HERE/src/foreman.ts" supervise >"$WS/s5.log" 2>&1 \
  || { cat "$WS/s5.log"; fail "codex failed-verification rehearsal errored"; }
cat "$WS/s5.log"
assert_grep "codex verification failed (real PONG call exited 1" "$WS/s5.log"
assert_grep "re-login failed → exiting" "$WS/s5.log"
assert_grep "Foreman will not declare success or resume" "$WS/state/relay-sent.txt"
refute_grep "Codex auth works again" "$WS/state/relay-sent.txt"
refute_grep "life 2 started" "$WS/s5.log"
refute_grep "login status" "$WS/state/mock-codex-calls.txt"
echo "--- still-dead relay transcript ---"
cat "$WS/state/relay-sent.txt"
echo "  scenario 5 OK"

echo "### scenario 6: codex device-auth shape → human relay → real-call verification ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
mkdir -p "$WS/bin" "$WS/state"
cat > "$WS/bin/reply" <<'STUB'
#!/usr/bin/env bash
{ echo "--- relay message ---"; cat; echo; } >> "$FOREMAN_STATE_DIR/relay-sent.txt"
STUB
chmod +x "$WS/bin/reply"
FOREMAN_CODEX_BIN="$HERE/test/mock-codex.ts" MOCK_CODEX_VERIFY=state \
  timeout 30 bun run "$HERE/src/foreman.ts" relogin codex >"$WS/s6.log" 2>&1 \
  || { cat "$WS/s6.log"; fail "production-shaped codex relay errored"; }
cat "$WS/s6.log"
assert_grep "codex verification failed (real PONG call exited 1" "$WS/s6.log"
assert_grep "codex verification passed (real PONG call)" "$WS/s6.log"
assert_grep "Codex auth is dead, so foreman cannot continue" "$WS/state/relay-sent.txt"
assert_grep "Codex auth works again" "$WS/state/relay-sent.txt"
refute_grep "\[harness\]" "$WS/state/relay-sent.txt"
assert_grep "login --device-auth" "$WS/state/mock-codex-calls.txt"
refute_grep "login status" "$WS/state/mock-codex-calls.txt"
echo "--- production-shaped codex relay transcript ---"
cat "$WS/state/relay-sent.txt"
echo "  scenario 6 OK"

echo "### scenario 7: codex supervising session → exec resume → recycle ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
FOREMAN_SESSION_ENGINE=codex FOREMAN_RELOGIN_ENGINE=codex \
  FOREMAN_CODEX_BIN="$HERE/test/mock-codex.ts" MOCK_STEP=300 \
  timeout 30 bun run "$HERE/src/foreman.ts" supervise >"$WS/s7.log" 2>&1 \
  || { cat "$WS/s7.log"; fail "codex resident-session lifecycle errored"; }
cat "$WS/s7.log"
assert_grep "agent launched; bootstrap sent (engine=codex)" "$WS/s7.log"
assert_grep "turn complete; context ≈ 300/1000" "$WS/s7.log"
assert_grep "turn complete; context ≈ 600/1000" "$WS/s7.log"
assert_grep "turn complete; context ≈ 900/1000" "$WS/s7.log"
assert_grep "hard mark hit" "$WS/s7.log"
assert_grep "checkpoint turn complete → recycling" "$WS/s7.log"
assert_grep "relaunching fresh" "$WS/s7.log"
assert_grep "agent process ended" "$WS/s7.log"
assert_grep "exec --json --skip-git-repo-check" "$WS/state/mock-codex-calls.txt"
assert_grep "exec resume --json --skip-git-repo-check" "$WS/state/mock-codex-calls.txt"
assert_grep "mock-codex-life-1" "$WS/state/mock-codex-calls.txt"
assert_grep "life=1 turn=4 .*checkpoint NOW" "$WS/state/mock-codex-prompts.txt"
# cached_input_tokens is already included in Codex input_tokens, and output tokens are not context
# occupancy. Neither may be added again (300 + 250 + 999 would otherwise produce 1549 here).
refute_grep "context ≈ 1549/1000" "$WS/s7.log"
refute_grep "mock-claude" "$WS/s7.log"
echo "  scenario 7 OK"

echo
echo "ALL LIFECYCLE TESTS PASSED"
