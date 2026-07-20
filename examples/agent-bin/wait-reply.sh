#!/usr/bin/env bash
# wait-reply — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Two modes:
#
#   SINGLE-THREAD (an <id> is given) — the original safety-net behavior, unchanged.
#     Blocks (polling) until a human answers the question identified by <id>, then prints the
#     reply text. Because this is one long-running command, waiting costs ~no context.
#
#   INBOX (no <id>, or --inbox) — returns EVERYTHING unread since we last looked. Solves the
#     "human sent a rapid follow-up / replied in a different thread and we only caught the first
#     reply" problem: single-thread mode blocks on ONE thread and returns the FIRST match; inbox
#     mode drains all new messages from the target human across the whole channel in one call.
#
# Correlation (single-thread, no tag to type):
#   Mattermost — a reply in the question's THREAD (root_id == <id>) matches unambiguously.
#                When only one question is outstanding, a plain message also matches.
#                A 👍 (+1) reaction from the target human on the question post also counts
#                as an ack (emits "ACK").
#   Telegram   — a reply carrying the "#<id>" tag matches.
#
# Usage:
#   wait-reply <id>            # single-thread: prints the reply text + newline
#   wait-reply <id> --raw      # single-thread, NO trailing newline — for piping a secret
#                              # straight into the store, e.g.:
#                              #   wait-reply <id> --raw | foreman secret set GITLAB_TOKEN
#   wait-reply                 # INBOX: drain all new human messages since the last look
#   wait-reply --inbox         # same as the no-arg inbox form (explicit)
#
# Inbox output — one line per new post from the target human, chronological:
#   MSG <post_id> <root_id_or_-> <text-with-newlines-collapsed-to-spaces>
# <root_id_or_-> is the thread root, or "-" for a root/non-threaded post. Advances a persistent
# CHANNEL watermark (last-seen human create_at) so the next call resumes where this one stopped.
# On the FIRST ever call the watermark is seeded to "now" (no history dump); we then block for
# the next new message. Each returned post is 👀-reacted, same as single-thread mode.
#
# Optional: FOREMAN_WAIT_TIMEOUT seconds (default: no timeout). Timeout with nothing new → exit 3
# in either mode, so the caller can cheaply re-block.
set -euo pipefail

# --- Mode + arg parsing ---------------------------------------------------------------------
# Inbox mode when no positional <id> is given (or the explicit --inbox flag). Otherwise the
# first arg is the question id and the original single-thread behavior applies, byte-for-byte.
mode="single"; id=""; raw=0
if [ "$#" -eq 0 ] || [ "${1:-}" = "--inbox" ]; then
  mode="inbox"
else
  id="$1"
  # Sanitize <id>: it is interpolated into a watermark file path (wm_dir/$id) and a sed
  # expression (s/#$id//) below, so reject anything outside a safe charset to block
  # path-traversal and sed-injection. Mirrors secretFileName()'s posture in src/.
  if ! [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "wait-reply: invalid id '$id' (allowed chars: A-Za-z0-9_-)" >&2; exit 2
  fi
  [ "${2:-}" = "--raw" ] && raw=1
fi

deadline=0
[ -n "${FOREMAN_WAIT_TIMEOUT:-}" ] && deadline=$(( $(date +%s) + FOREMAN_WAIT_TIMEOUT ))

emit() { if [ "$raw" = 1 ]; then printf '%s' "$1"; else printf '%s\n' "$1"; fi; }
timed_out() { [ "$deadline" != 0 ] && [ "$(date +%s)" -ge "$deadline" ]; }

# Watermark dir — shared by both modes and both channels. Falls back to a sane dir when
# FOREMAN_STATE_DIR is unset, mirroring the per-id path derivation.
wm_dir="${FOREMAN_STATE_DIR:-$HOME/.foreman}/wait-reply"
mkdir -p "$wm_dir" 2>/dev/null || true

# --- Mattermost ---
if [ -n "${MATTERMOST_BASE_URL:-}" ] && [ -n "${MATTERMOST_BOT_TOKEN:-}" ]; then
  api="${MATTERMOST_BASE_URL%/}/api/v4"
  # Keep the bot token out of argv (else visible via ps / /proc/<pid>/cmdline while a request
  # is in flight): write the Authorization header to a 0600 temp file and have curl read it
  # with -H @file. Cleaned up on exit. (curl >= 7.55 for -H @file.)
  auth_hdr="$(mktemp "${TMPDIR:-/tmp}/mm-auth.XXXXXX")"
  chmod 600 "$auth_hdr"
  trap 'rm -f "$auth_hdr"' EXIT
  printf 'Authorization: Bearer %s\n' "$MATTERMOST_BOT_TOKEN" > "$auth_hdr"
  mm=(-fsS -H @"$auth_hdr" -H "Content-Type: application/json")
  # Setup calls are guarded (|| true) so a transient Mattermost failure degrades to the next
  # configured channel (Telegram, below) instead of aborting the whole script under `set -e`.
  bot_id="$(curl "${mm[@]}" "$api/users/me" | jq -r .id || true)"; [ "$bot_id" = "null" ] && bot_id=""
  # Resolve the target human's id once — needed to open the DM channel, to attribute an inbound
  # 👍 reaction to the human (single-thread Task B), and to filter the inbox to just that human.
  tgt_id=""
  [ -n "${MATTERMOST_TARGET_USER:-}" ] && \
    tgt_id="$(curl "${mm[@]}" "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id || true)"
  [ "$tgt_id" = "null" ] && tgt_id=""
  chan="${MATTERMOST_CHANNEL_ID:-}"
  if [ -z "$chan" ] && [ -n "$tgt_id" ] && [ -n "$bot_id" ]; then
    chan="$(curl "${mm[@]}" -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id || true)"
  fi
  [ "$chan" = "null" ] && chan=""
  # Acknowledge a human reply with a 👀 so the human can see, at a glance, that foreman read it.
  react() {
    local pid="$1"; [ -n "$pid" ] || return 0
    curl "${mm[@]}" -X POST "$api/reactions" \
      -d "{\"user_id\":\"$bot_id\",\"post_id\":\"$pid\",\"emoji_name\":\"eyes\"}" >/dev/null 2>&1 || true
  }

  # Only engage Mattermost if setup actually resolved the bot identity; otherwise fall through
  # to the next configured channel (Telegram) rather than polling a broken/absent channel.
  if [ -n "$bot_id" ]; then
    if [ "$mode" = "inbox" ]; then
      # ---- INBOX over Mattermost -----------------------------------------------------------
      # Persistent CHANNEL watermark (last-seen human create_at, ms). First-ever call seeds it
      # to "now" so we don't dump the whole channel history; then we block for the next message.
      inbox_wm_file="$wm_dir/inbox.watermark"
      if [ ! -f "$inbox_wm_file" ]; then
        printf '%s' "$(( $(date +%s) * 1000 ))" > "$inbox_wm_file" 2>/dev/null || true
      fi
      wm="$(cat "$inbox_wm_file" 2>/dev/null || echo 0)"; [[ "$wm" =~ ^[0-9]+$ ]] || wm=0

      # Separate persistent watermark for reaction-acks: the target human adding a 👍 (+1) to one
      # of the BOT's own recent posts counts as an ack, even while parked (single-thread mode has
      # long done this on the question post; inbox mode now does it channel-wide). Seed to "now" on
      # the first-ever call so a pre-existing 👍 doesn't fire, and persist the newest handled
      # reaction's create_at so a +1 fires exactly once and never re-fires on restart.
      inbox_react_file="$wm_dir/inbox.react"
      if [ ! -f "$inbox_react_file" ]; then
        printf '%s' "$(( $(date +%s) * 1000 ))" > "$inbox_react_file" 2>/dev/null || true
      fi
      rwm="$(cat "$inbox_react_file" 2>/dev/null || echo 0)"; [[ "$rwm" =~ ^[0-9]+$ ]] || rwm=0

      # Given a channel posts JSON (with embedded post metadata) on stdin, emit
      # "<post_id>\t<reaction_create_at>\t<root_or_->" for every FRESH +1 the target human placed
      # on one of the bot's own posts (reaction create_at > $rwm), chronological. Bounded to the
      # posts the caller fetched (last ~30). Root is "-" for a root/non-threaded post. Requires the
      # target id to attribute the reaction to the human; caller skips this when it's unresolved.
      inbox_react_pick() {
        jq -r --arg bot "$bot_id" --arg tgt "$tgt_id" --argjson rwm "$rwm" '
          [ .posts[]?
            | select(.user_id == $bot)                       # only posts authored by the bot
            | . as $post
            | (.metadata.reactions // [])[]
            | select(.user_id == $tgt and .emoji_name == "+1" and .create_at > $rwm)
            | { pid: $post.id, rat: .create_at,
                root: (if ($post.root_id // "") == "" then "-" else $post.root_id end) }
          ]
          | sort_by(.rat)
          | .[]
          | ( .pid + "\t" + (.rat|tostring) + "\t" + .root )' 2>/dev/null || true
      }

      # Given channel posts JSON on stdin, emit the target human's posts NEWER than $wm, in
      # chronological order, as "<id>\t<create_at>\t<root_or_->\t<message>" (message newlines/tabs
      # collapsed to spaces so each post is exactly one tab-delimited line). The root field is "-"
      # for a root/non-threaded post — never empty, so the tab-split (IFS=tab, a whitespace IFS
      # char that would otherwise collapse an empty field) keeps all four columns aligned. When
      # the target id couldn't be resolved, fall back to "any non-bot user".
      inbox_pick() {
        jq -r --arg bot "$bot_id" --arg tgt "$tgt_id" --argjson wm "$wm" '
          [ .posts[]?
            | select(.create_at > $wm)
            | select( if $tgt != "" then .user_id == $tgt else .user_id != $bot end )
          ]
          | sort_by(.create_at)
          | .[]
          | ( .id + "\t" + (.create_at|tostring)
              + "\t" + (if (.root_id // "") == "" then "-" else .root_id end)
              + "\t" + (.message | gsub("[\t\r\n]+"; " ")) )' 2>/dev/null || true
      }

      if [ -n "$chan" ]; then
        while true; do
          # since=$wm fetches the candidate window; inbox_pick re-filters on create_at > wm so a
          # boundary post is never re-returned across calls.
          resp="$(curl "${mm[@]}" "$api/channels/$chan/posts?since=$wm" || true)"
          out="$(printf '%s' "$resp" | inbox_pick)"
          if [ -n "$out" ]; then
            newest="$wm"
            # Heredoc (not a pipe) so react()/newest run in THIS shell and side effects stick.
            while IFS=$'\t' read -r pid cat root msg; do
              [ -n "$pid" ] || continue
              react "$pid"
              [ -n "$root" ] || root="-"
              printf 'MSG %s %s %s\n' "$pid" "$root" "$msg"
              [ "$cat" -gt "$newest" ] 2>/dev/null && newest="$cat"
            done <<INBOX
$out
INBOX
            printf '%s' "$newest" > "$inbox_wm_file" 2>/dev/null || true
            exit 0
          fi
          # No new POST — also check for a fresh 👍 (+1) reaction from the human on the bot's own
          # recent posts (bounded to the channel's last ~30). A reaction carries no post text, so
          # since=$wm above would never surface it; fetch the recent window separately.
          if [ -n "$tgt_id" ]; then
            rresp="$(curl "${mm[@]}" "$api/channels/$chan/posts?per_page=30" || true)"
            racts="$(printf '%s' "$rresp" | inbox_react_pick)"
            if [ -n "$racts" ]; then
              newest_r="$rwm"
              # Heredoc (not a pipe) so newest_r updates in THIS shell and the watermark sticks.
              while IFS=$'\t' read -r pid rat root; do
                [ -n "$pid" ] || continue
                [ -n "$root" ] || root="-"
                printf 'ACK %s %s +1\n' "$pid" "$root"
                [ "$rat" -gt "$newest_r" ] 2>/dev/null && newest_r="$rat"
              done <<RACT
$racts
RACT
              printf '%s' "$newest_r" > "$inbox_react_file" 2>/dev/null || true
              exit 0
            fi
          fi
          timed_out && { echo "wait-reply: inbox timed out (nothing new)" >&2; exit 3; }
          sleep 3
        done
      fi
      # chan unresolved → fall through to Telegram.
    else
      # ---- SINGLE-THREAD over Mattermost (original behavior, unchanged) ---------------------
      # Watermark: persist the create_at (ms) of the last handled human post so re-arming a
      # catcher on a thread that ALREADY has replies (e.g. across context recycles) does not
      # instantly re-return an already-handled message. Keyed by question/thread id.
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

      if [ -n "$chan" ]; then
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
    fi
  fi
fi

# --- Telegram ---
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  if [ "$mode" = "inbox" ]; then
    # ---- INBOX over Telegram -----------------------------------------------------------------
    # Telegram has no threads, so <root_id_or_-> is always "-". The update_id acts as a natural
    # watermark; we persist it so a re-armed catcher resumes past already-seen updates. First-ever
    # call seeds the offset past the latest update (no history dump), then blocks for the next one.
    # Token stays out of argv (URL embeds it): passed via a curl config read from stdin (-K -).
    tg_off_file="$wm_dir/inbox.tg.offset"
    if [ ! -f "$tg_off_file" ]; then
      seed="$(curl -fsS -K - <<EOF | jq -r '.result[-1].update_id // empty' || true
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&offset=-1"
EOF
)"
      if [ -n "$seed" ]; then printf '%s' "$((seed + 1))" > "$tg_off_file" 2>/dev/null || true
      else printf '0' > "$tg_off_file" 2>/dev/null || true; fi
    fi
    offset="$(cat "$tg_off_file" 2>/dev/null || echo 0)"; [[ "$offset" =~ ^[0-9]+$ ]] || offset=0
    # Acknowledge a human message with a 👀 (same as Mattermost inbox) so the human sees at a
    # glance that foreman read it. 👀 (U+1F440) is in Telegram's allowed reaction set. Token stays
    # out of argv (-K -); best-effort (|| true) so a react failure never drops the message.
    tg_react() {
      local cid="$1" mid="$2"; [ -n "$cid" ] && [ -n "$mid" ] || return 0
      curl -fsS -K - >/dev/null 2>&1 \
        --data-urlencode "chat_id=${cid}" \
        --data-urlencode "message_id=${mid}" \
        --data-urlencode 'reaction=[{"type":"emoji","emoji":"👀"}]' <<EOF || true
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMessageReaction"
EOF
    }
    while true; do
      resp="$(curl -fsS -K - <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}"
EOF
)" || { sleep 2; continue; }
      # SECURITY: a Telegram bot can be DM'd by anyone who knows its @username. Restrict the inbox
      # to the owner's chat (TELEGRAM_CHAT_ID) so a stranger's message can't reach us as if it were
      # the human (a prompt-injection vector). Strangers' updates are still consumed (offset advances
      # via $last below) but never returned. If TELEGRAM_CHAT_ID is unset, fall back to no filter.
      out="$(echo "$resp" | jq -r --arg cid "${TELEGRAM_CHAT_ID:-}" '.result[]
        | select(.message.text != null)
        | select($cid == "" or ((.message.chat.id|tostring) == $cid))
        | ((.update_id|tostring) + "\t" + (.message.message_id|tostring) + "\t" + (.message.chat.id|tostring) + "\t" + (.message.text | gsub("[\t\r\n]+"; " ")))' 2>/dev/null || true)"
      last="$(echo "$resp" | jq -r '.result[-1].update_id // empty')"
      if [ -n "$out" ]; then
        while IFS=$'\t' read -r uid mid cid text; do
          [ -n "$uid" ] || continue
          tg_react "$cid" "$mid"
          printf 'MSG %s - %s\n' "$uid" "$text"
        done <<TGINBOX
$out
TGINBOX
        [ -n "$last" ] && { printf '%s' "$((last + 1))" > "$tg_off_file" 2>/dev/null || true; }
        exit 0
      fi
      [ -n "$last" ] && { offset=$((last + 1)); printf '%s' "$offset" > "$tg_off_file" 2>/dev/null || true; }
      timed_out && { echo "wait-reply: inbox timed out (nothing new)" >&2; exit 3; }
    done
  else
    # ---- SINGLE-THREAD over Telegram (original behavior, unchanged) ---------------------------
    offset=0
    while true; do
      # Token stays out of argv (else visible via ps / /proc/<pid>/cmdline): pass the URL (which
      # embeds the token) via a curl config read from stdin with -K -.
      resp="$(curl -fsS -K - <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}"
EOF
)" || { sleep 2; continue; }
      last="$(echo "$resp" | jq -r '.result[-1].update_id // empty')"
      [ -n "$last" ] && offset=$((last + 1))
      # SECURITY: restrict to the owner's chat (TELEGRAM_CHAT_ID) so a stranger can't answer for the
      # human (see the inbox note above). No filter if TELEGRAM_CHAT_ID is unset.
      reply="$(echo "$resp" | jq -r --arg tag "#$id" --arg cid "${TELEGRAM_CHAT_ID:-}" \
        '.result[] | select($cid == "" or ((.message.chat.id|tostring) == $cid))
         | .message.text? // empty | select(contains($tag))' | head -n1 | sed "s/#$id//; s/^[[:space:]]*//; s/[[:space:]]*$//")"
      if [ -n "$reply" ]; then emit "$reply"; exit 0; fi
      timed_out && { echo "wait-reply: timed out waiting for $id" >&2; exit 3; }
    done
  fi
fi

echo "wait-reply: no channel configured" >&2; exit 1
