#!/usr/bin/env bash
# wait-reply — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Blocks (polling) until a human answers the question identified by <id>, then prints the
# reply text. Because this is one long-running command, waiting costs ~no context.
#
# Correlation (no tag to type):
#   Mattermost — a reply in the question's THREAD (root_id == <id>) matches unambiguously.
#                When only one question is outstanding, a plain message also matches.
#                A 👍 (+1) reaction from the target human on the question post also counts
#                as an ack (emits "ACK").
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
  # Resolve the target human's id once — needed both to open the DM channel and to attribute
  # an inbound 👍 reaction to the human (Task B, below).
  tgt_id=""
  [ -n "${MATTERMOST_TARGET_USER:-}" ] && \
    tgt_id="$(curl "${mm[@]}" "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id)"
  chan="${MATTERMOST_CHANNEL_ID:-}"
  if [ -z "$chan" ] && [ -n "$tgt_id" ]; then
    chan="$(curl "${mm[@]}" -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id)"
  fi
  # Acknowledge a human reply with a 👀 so the human can see, at a glance, that foreman read it.
  react() {
    local pid="$1"; [ -n "$pid" ] || return 0
    curl "${mm[@]}" -X POST "$api/reactions" \
      -d "{\"user_id\":\"$bot_id\",\"post_id\":\"$pid\",\"emoji_name\":\"eyes\"}" >/dev/null 2>&1 || true
  }
  # Watermark: persist the create_at (ms) of the last handled human post so re-arming a
  # catcher on a thread that ALREADY has replies (e.g. across context recycles) does not
  # instantly re-return an already-handled message. Keyed by question/thread id.
  wm_dir="${FOREMAN_STATE_DIR:-$HOME/.foreman}/wait-reply"
  mkdir -p "$wm_dir" 2>/dev/null || true
  wm_file="$wm_dir/$id"
  wm_val="$(cat "$wm_file" 2>/dev/null || echo 0)"; [ -n "$wm_val" ] || wm_val=0
  # Separate watermark for inbound reaction-acks (Task B). Reactions carry their own create_at
  # (ms); persisting the last handled one keeps a re-armed catcher from re-firing on an old 👍.
  rwm_file="$wm_dir/$id.react"
  rwm_val="$(cat "$rwm_file" 2>/dev/null || echo 0)"; [ -n "$rwm_val" ] || rwm_val=0

  # Given a channel/thread posts JSON on stdin, print "<post_id>\t<create_at>\t<message>" of
  # the oldest matching human post NEWER than the watermark, or nothing. $1 = root_id selector.
  pick() { jq -r --arg q "$id" --arg bot "$bot_id" --argjson wm "$wm_val" \
    "[.posts[]? | select(.user_id != \$bot) | select(.create_at > \$wm) | select($1)]
     | sort_by(.create_at)
     | (.[0] | if . then (.id + \"\t\" + (.create_at|tostring) + \"\t\" + .message) else empty end)" 2>/dev/null || true; }
  handle() {  # $1 = "<id>\t<create_at>\t<message>"; advance watermark, react, emit; 1 if empty
    [ -n "$1" ] || return 1
    local pid rest cat msg
    pid="${1%%$'\t'*}"; rest="${1#*$'\t'}"
    cat="${rest%%$'\t'*}"; msg="${rest#*$'\t'}"
    [ -n "$wm_file" ] && { printf '%s' "$cat" > "$wm_file" || true; }
    react "$pid"; emit "$msg"; return 0
  }
  # Task B: the target human adding a 👍 (+1) reaction to the bot's question post counts as an
  # ack — same as a reply. The routing id IS the bot's question post id, so reactions hang off
  # exactly it. Returns 0 (and emits "ACK") on a fresh human 👍; 1 otherwise. Advances the
  # reaction watermark.
  check_ack() {
    [ -n "$tgt_id" ] || return 1   # need the human's id to attribute the reaction to them
    local cat
    cat="$(curl "${mm[@]}" "$api/posts/$id/reactions" 2>/dev/null \
      | jq -r --arg u "$tgt_id" --argjson wm "$rwm_val" \
        '[.[]? | select(.user_id==$u) | select(.emoji_name=="+1") | select(.create_at > $wm)]
         | sort_by(.create_at) | (.[0].create_at // empty)' 2>/dev/null || true)"
    [ -n "$cat" ] || return 1
    rwm_val="$cat"; [ -n "$rwm_file" ] && { printf '%s' "$cat" > "$rwm_file" || true; }
    emit "ACK"; return 0
  }

  # One-shot pre-check: a threaded reply may have arrived while no waiter was running
  # (e.g. between context recycles). since=now would miss it, so check thread history first.
  # The watermark filter ensures only replies newer than the last handled one match.
  pre="$(curl "${mm[@]}" "$api/posts/$id/thread" 2>/dev/null | pick '.root_id == $q')"
  handle "$pre" && exit 0
  check_ack && exit 0   # a 👍 may already sit on the question post (e.g. across a recycle)

  since="$(( $(date +%s) * 1000 ))"  # only consider posts from now on
  while true; do
    resp="$(curl "${mm[@]}" "$api/channels/$chan/posts?since=$since" || true)"
    # 1) a reply in this question's thread — unambiguous under concurrency
    reply="$(echo "$resp" | pick '.root_id == $q')"
    # 2) fallback: a plain (non-threaded) human message — fine when one question is pending
    [ -n "$reply" ] || reply="$(echo "$resp" | pick '.root_id == ""')"
    handle "$reply" && exit 0
    check_ack && exit 0   # ...or the human 👍'd the question post instead of replying
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
