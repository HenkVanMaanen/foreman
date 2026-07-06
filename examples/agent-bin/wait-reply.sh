#!/usr/bin/env bash
# wait-reply — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Blocks (long-polling) until a human replies to a given routing id, then prints the
# reply text. Because this is one long-running command, waiting costs ~no context.
#
# Usage:
#   wait-reply <id>            # prints "#<id>"-tagged reply text (tag stripped)
#   wait-reply <id> --raw      # prints the reply with NO trailing newline — for piping a
#                              # secret straight into the store:
#   wait-reply <id> --raw | foreman secret set GITLAB_TOKEN
#
# Only Telegram long-polling is shown here; add Mattermost via its websocket or a posts poll.
# NOTE: getUpdates offset handling is simplified — a production version should persist the
# offset so replies aren't missed across restarts.
set -euo pipefail

id="${1:?usage: wait-reply <id> [--raw]}"
raw=0
[ "${2:-}" = "--raw" ] && raw=1

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN required}"
offset=0
while true; do
  resp="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=50&offset=${offset}")" || { sleep 2; continue; }
  # advance offset past everything we just saw
  last="$(echo "$resp" | jq -r '.result[-1].update_id // empty')"
  [ -n "$last" ] && offset=$((last + 1))
  # find the first message whose text contains "#<id>"
  reply="$(echo "$resp" | jq -r --arg tag "#$id" '.result[].message.text? // empty | select(contains($tag))' | head -n1)"
  if [ -n "$reply" ]; then
    # strip the "#<id>" tag and surrounding whitespace
    answer="$(echo "$reply" | sed "s/#$id//" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ "$raw" = 1 ]; then
      printf '%s' "$answer"
    else
      printf '%s\n' "$answer"
    fi
    exit 0
  fi
done
