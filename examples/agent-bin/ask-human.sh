#!/usr/bin/env bash
# ask-human — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Posts a question to the configured channel(s) and prints a routing id on stdout. Pair
# with `wait-reply <id>` to receive the answer. The human replies in-thread (Mattermost)
# or by replying to the message (Telegram) — no tag to type.
#
# Usage:
#   ask-human "Need a token for gitlab.acme.com" [--options a,b,c] [--urgency blocking|background]
#
# Channels (any that are configured are used):
#   Mattermost DM:   MATTERMOST_BASE_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_TARGET_USER
#                    (or MATTERMOST_CHANNEL_ID to post to a specific channel instead of a DM)
#   Telegram:        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Routing id: on Mattermost it is the question's post id (so replies correlate by thread
# root_id). On Telegram-only it is a generated id embedded as "#id" in the message.
set -euo pipefail

question="${1:?usage: ask-human \"question\" [--options a,b] [--urgency blocking|background]}"
shift || true
options=""; urgency="blocking"
while [ $# -gt 0 ]; do
  case "$1" in
    --options) options="$2"; shift 2 ;;
    --urgency) urgency="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

gen_id="q$(date +%s)$RANDOM"
routing=""

# --- Mattermost ---
if [ -n "${MATTERMOST_BASE_URL:-}" ] && [ -n "${MATTERMOST_BOT_TOKEN:-}" ]; then
  api="${MATTERMOST_BASE_URL%/}/api/v4"
  mm=(-fsS -H "Authorization: Bearer ${MATTERMOST_BOT_TOKEN}" -H "Content-Type: application/json")
  chan="${MATTERMOST_CHANNEL_ID:-}"
  if [ -z "$chan" ] && [ -n "${MATTERMOST_TARGET_USER:-}" ]; then
    bot_id="$(curl "${mm[@]}" "$api/users/me" | jq -r .id)"
    tgt_id="$(curl "${mm[@]}" "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id)"
    chan="$(curl "${mm[@]}" -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id)"
  fi
  if [ -n "$chan" ]; then
    # Human tone: no "[foreman]"/urgency tags — the message already comes from the bot
    # account, and the question text is written like a person. Add a light nudge only when
    # the agent is actually blocked.
    text="$question"
    [ -n "$options" ] && text="$text"$'\n'"($options?)"
    [ "$urgency" = "blocking" ] && text="$text"$'\n\n'"(I'm blocked on this one — whenever you get a sec.)"
    resp="$(curl "${mm[@]}" -X POST "$api/posts" \
      -d "$(jq -n --arg c "$chan" --arg m "$text" '{channel_id:$c, message:$m}')")"
    routing="$(echo "$resp" | jq -r .id)"
  fi
fi

# --- Telegram ---
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  ttext="$question"
  [ -n "$options" ] && ttext="$ttext"$'\n'"($options?)"
  [ "$urgency" = "blocking" ] && ttext="$ttext"$'\n\n'"(blocked on this one — whenever you get a sec.)"
  ttext="$ttext"$'\n'"(ref #$gen_id)"  # keep the #id so wait-reply can correlate on Telegram
  curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${ttext}" >/dev/null && : "${routing:=$gen_id}"
fi

[ -n "$routing" ] || { echo "ask-human: no channel configured/reachable" >&2; exit 1; }
echo "$routing"
