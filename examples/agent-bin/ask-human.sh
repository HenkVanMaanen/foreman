#!/usr/bin/env bash
# ask-human — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Posts a question to the configured channel(s) tagged with a routing id, and prints
# the id on stdout. Pair with wait-reply <id> to receive the answer.
#
# Usage:
#   ask-human "Need a token for gitlab.acme.com" [--options a,b,c] [--urgency blocking|background]
#
# Env (passed through by the harness):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#   MATTERMOST_BASE_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_CHANNEL_ID
set -euo pipefail

question="${1:?usage: ask-human \"question\" [--options a,b] [--urgency blocking|background]}"
shift || true
options=""
urgency="blocking"
while [ $# -gt 0 ]; do
  case "$1" in
    --options)  options="$2"; shift 2 ;;
    --urgency)  urgency="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# A short, human-typeable routing id. Reply must include "#<id>".
id="q$(date +%s)$RANDOM"
text="[foreman #$id] ($urgency) $question"
[ -n "$options" ] && text="$text
options: $options"
text="$text
(reply with: #$id your answer)"

sent=0
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null && sent=1
fi
if [ -n "${MATTERMOST_BASE_URL:-}" ] && [ -n "${MATTERMOST_BOT_TOKEN:-}" ] && [ -n "${MATTERMOST_CHANNEL_ID:-}" ]; then
  curl -fsS "${MATTERMOST_BASE_URL%/}/api/v4/posts" \
    -H "Authorization: Bearer ${MATTERMOST_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$MATTERMOST_CHANNEL_ID" --arg m "$text" '{channel_id:$c, message:$m}')" >/dev/null && sent=1
fi

[ "$sent" = 1 ] || { echo "ask-human: no channel configured" >&2; exit 1; }
echo "$id"
