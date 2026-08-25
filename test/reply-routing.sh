#!/usr/bin/env bash
# Regression test for the inbox routing-field foot-gun in reply.sh. No network calls.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/reply.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

fail() { echo "FAIL: $1"; exit 1; }

# Force the Telegram dry-run branch: it prints the parsed body without contacting Telegram.
unset MATTERMOST_BASE_URL MATTERMOST_BOT_TOKEN MATTERMOST_CHANNEL_ID MATTERMOST_TARGET_USER
export TELEGRAM_BOT_TOKEN="test-token"
export TELEGRAM_CHAT_ID="42"

body() { sed -n '/^text:$/,$p' | tail -n +2; }

normal="$(printf '%s\n' 'normal stdin body' | bash "$SCRIPT" 123 --dry-run | body)"
[ "$normal" = "normal stdin body" ] || fail "ordinary stdin message changed: '$normal'"

# Reproduces Foreman's malformed call from production: the post id and root metadata were both
# passed, so the old parser sent '-' and ignored stdin. The hardened parser keeps the real body.
recovered="$(printf '%s\n' 'intended Telegram reply' \
  | bash "$SCRIPT" 123 --dry-run - 2>"$WS/recovery.err" \
  | body)"
[ "$recovered" = "intended Telegram reply" ] \
  || fail "stray root field replaced the piped message: '$recovered'"
grep -q "ignored stray root-field '-'" "$WS/recovery.err" \
  || fail "malformed invocation should emit a diagnostic"

# Preserve the documented positional-message behavior when no piped body exists.
literal="$(bash "$SCRIPT" 123 --dry-run - </dev/null | body)"
[ "$literal" = "-" ] || fail "literal positional dash changed: '$literal'"

echo "ALL REPLY ROUTING TESTS PASSED"
