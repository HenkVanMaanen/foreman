#!/usr/bin/env bash
# wait-reply — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Blocks (polling) until a human answers the question identified by <id>, then prints the
# reply text. Because this is one long-running command, waiting costs ~no context.
#
# Correlation (no tag to type):
#   Mattermost — a reply in the question's THREAD (root_id == <id>) matches unambiguously.
#                When only one question is outstanding, a plain message also matches.
#   Telegram   — a reply carrying the "#<id>" tag matches.
#
# Usage:
#   wait-reply <id>            # prints the reply text + newline
#   wait-reply <id> --raw      # prints the reply with NO trailing newline — for piping a
#                              # secret straight into the store, e.g.:
#   wait-reply <id> --raw | foreman secret set GITLAB_TOKEN
#
# Optional: FOREMAN_WAIT_TIMEOUT seconds (default: no timeout).
set -euo pipefail

id="${1:?usage: wait-reply <id> [--raw]}"
raw=0; [ "${2:-}" = "--raw" ] && raw=1
deadline=0
[ -n "${FOREMAN_WAIT_TIMEOUT:-}" ] && deadline=$(( $(date +%s) + FOREMAN_WAIT_TIMEOUT ))

emit() { if [ "$raw" = 1 ]; then printf '%s' "$1"; else printf '%s\n' "$1"; fi; }
timed_out() { [ "$deadline" != 0 ] && [ "$(date +%s)" -ge "$deadline" ]; }

# --- Mattermost ---
if [ -n "${MATTERMOST_BASE_URL:-}" ] && [ -n "${MATTERMOST_BOT_TOKEN:-}" ]; then
  api="${MATTERMOST_BASE_URL%/}/api/v4"
  mm=(-fsS -H "Authorization: Bearer ${MATTERMOST_BOT_TOKEN}" -H "Content-Type: application/json")
  bot_id="$(curl "${mm[@]}" "$api/users/me" | jq -r .id)"
  chan="${MATTERMOST_CHANNEL_ID:-}"
  if [ -z "$chan" ] && [ -n "${MATTERMOST_TARGET_USER:-}" ]; then
    tgt_id="$(curl "${mm[@]}" "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id)"
    chan="$(curl "${mm[@]}" -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id)"
  fi
  # One-shot pre-check: a threaded reply may have arrived while no waiter was running
  # (e.g. between context recycles). since=now would miss it, so check thread history first.
  pre="$(curl "${mm[@]}" "$api/posts/$id/thread" 2>/dev/null \
    | jq -r --arg q "$id" --arg bot "$bot_id" \
      '[.posts[]? | select(.user_id != $bot) | select(.root_id == $q)]
       | sort_by(.create_at) | (.[0].message // empty)' 2>/dev/null || true)"
  if [ -n "$pre" ]; then emit "$pre"; exit 0; fi

  since="$(( $(date +%s) * 1000 ))"  # only consider posts from now on
  while true; do
    resp="$(curl "${mm[@]}" "$api/channels/$chan/posts?since=$since" || true)"
    # 1) a reply in this question's thread — unambiguous under concurrency
    reply="$(echo "$resp" | jq -r --arg q "$id" --arg bot "$bot_id" \
      '[.posts[]? | select(.user_id != $bot) | select(.root_id == $q)]
       | sort_by(.create_at) | (.[0].message // empty)' 2>/dev/null || true)"
    # 2) fallback: a plain (non-threaded) human message — fine when one question is pending
    if [ -z "$reply" ]; then
      reply="$(echo "$resp" | jq -r --arg bot "$bot_id" \
        '[.posts[]? | select(.user_id != $bot) | select(.root_id == "")]
         | sort_by(.create_at) | (.[0].message // empty)' 2>/dev/null || true)"
    fi
    if [ -n "$reply" ]; then emit "$reply"; exit 0; fi
    timed_out && { echo "wait-reply: timed out waiting for $id" >&2; exit 3; }
    sleep 3
  done
fi

# --- Telegram ---
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  offset=0
  while true; do
    resp="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}")" || { sleep 2; continue; }
    last="$(echo "$resp" | jq -r '.result[-1].update_id // empty')"
    [ -n "$last" ] && offset=$((last + 1))
    reply="$(echo "$resp" | jq -r --arg tag "#$id" '.result[].message.text? // empty | select(contains($tag))' | head -n1 | sed "s/#$id//; s/^[[:space:]]*//; s/[[:space:]]*$//")"
    if [ -n "$reply" ]; then emit "$reply"; exit 0; fi
    timed_out && { echo "wait-reply: timed out waiting for $id" >&2; exit 3; }
  done
fi

echo "wait-reply: no channel configured" >&2; exit 1
