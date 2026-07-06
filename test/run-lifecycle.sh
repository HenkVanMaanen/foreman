#!/usr/bin/env bash
# Exercises the supervisor's full lifecycle against mock-claude (no real Claude, no
# network). Verifies cold-start workspace seeding + both recycle paths:
#   1. context watchdog: soft mark → hard mark → checkpoint → recycle
#   2. agent-initiated: clear-request sentinel → recycle
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

export FOREMAN_CLAUDE_BIN="$HERE/test/mock-claude.ts"
export FOREMAN_BOOTSTRAP_PROMPT="$HERE/prompts/bootstrap.md"
export FOREMAN_CONTEXT_WINDOW=1000 MOCK_STEP=300
cd "$WS"

fail() { echo "FAIL: $1"; exit 1; }
assert_grep() { grep -q "$1" "$2" || fail "expected to see: $1"; }

echo "### scenario 1: context watchdog recycle ###"
rm -rf "$WS"/{state,notes,bin,worktrees}
timeout 30 bun run "$HERE/src/foreman.ts" supervise >"$WS/s1.log" 2>&1 || fail "supervisor errored"
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
MOCK_MODE=clear timeout 30 bun run "$HERE/src/foreman.ts" supervise >"$WS/s2.log" 2>&1 || fail "supervisor errored"
cat "$WS/s2.log"
assert_grep "agent requested clear → recycling" "$WS/s2.log"
assert_grep "relaunching fresh" "$WS/s2.log"
echo "  scenario 2 OK"

echo
echo "ALL LIFECYCLE TESTS PASSED"
