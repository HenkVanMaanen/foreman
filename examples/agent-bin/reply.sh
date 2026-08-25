#!/usr/bin/env bash
# reply — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Post a Mattermost message to the human in the CORRECT thread, without hand-rolling curl.
# Replaces the two recurring foot-guns of doing it by hand:
#   1) HTTP 400 from posting with a reply's id as root_id — Mattermost wants the THREAD ROOT,
#      not an in-thread post id. This script auto-resolves the root (see below) so passing
#      EITHER a root or any in-thread reply id just works.
#   2) apostrophes/newlines breaking single-quoted `-d '{...}'` bodies — the body is built with
#      jq and the message text is read from stdin, so quotes and multi-line text are always safe.
#
# Usage:
#   reply <root_or_post_id_or_-> [message]
#     <arg1> = a real post id  → resolve its thread root and reply there.
#            = - | new | ""     → start a NEW root thread (root_id="").
#     [message] = the text. If omitted, the message is read from STDIN (the primary path — it
#                 makes multi-line bodies and apostrophes safe). Examples:
#                   reply <id> "quick one-liner"
#                   printf 'multi\nline\nwith '\''quotes'\'' \n' | reply <id>
#                   reply new <<'EOF'
#                   a fresh root thread
#                   EOF
#   reply <arg1> --dry-run [message]   # print the resolved {channel_id,root_id,message} body
#                                      # and the channel/root, but DO NOT post.
#
# On success prints the new post id; on failure prints the API error and exits non-zero.
#
# Env (same contract as wait-reply.sh):
#   MATTERMOST_BASE_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_TARGET_USER (the human's username).
#   MATTERMOST_CHANNEL_ID is used only if non-empty; otherwise the human DM channel is resolved
#   dynamically from the API (bot id + target-user id → direct channel), same as wait-reply.
set -euo pipefail

# --- Arg parsing --------------------------------------------------------------------------
arg1="${1-}"
[ "$#" -ge 1 ] && shift || true
dry_run=0
if [ "${1-}" = "--dry-run" ]; then dry_run=1; shift || true; fi
# Message: $1 if present, otherwise stdin (the safe, primary path for quotes/newlines).
#
# Inbox lines contain TWO routing-looking fields: `MSG <post_id> <root_or_-> <text>`. The reply
# command accepts only the post id; it resolves a Mattermost root itself, and Telegram ignores the
# routing value. If an agent accidentally copies both fields (`... | reply <post_id> -`), the old
# parser treated `-` as the message and silently discarded the real piped text. Recover that exact
# misuse when stdin is a pipe so the intended response reaches the human instead of a bare dash.
if [ "$#" -ge 1 ]; then
  message="$1"
  if [ "$message" = "-" ] && [[ -p /dev/stdin ]]; then
    piped_message="$(cat)"
    if [ -n "$piped_message" ]; then
      echo "reply: ignored stray root-field '-'; using piped message (pass only <post_id>)" >&2
      message="$piped_message"
    fi
  fi
else
  message="$(cat)"
fi

# Empty / `-` / `new` first arg → a new root thread. Otherwise it must be a Mattermost post id
# (an alphanumeric handle); reject anything else so it can't be a malformed value we then
# interpolate into an API path.
root_arg=""
case "$arg1" in
  ""|-|new) root_arg="" ;;
  *)
    if ! [[ "$arg1" =~ ^[A-Za-z0-9]+$ ]]; then
      echo "reply: invalid post id '$arg1' (allowed: A-Za-z0-9, or - / new for a fresh thread)" >&2
      exit 2
    fi
    root_arg="$arg1"
    ;;
esac

if [ -z "${MATTERMOST_BASE_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ]; then
  # No Mattermost → Telegram fallback. Telegram DMs have no threads, so <arg1> (a wait-reply
  # update_id ref for interface parity) is not used to thread; we just post the message to the
  # chat. Token stays out of argv via a curl config read from stdin (-K -); chat_id/text (which
  # may contain newlines/quotes) go through --data-urlencode so they're always safe.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    if [ "$dry_run" = 1 ]; then
      echo "channel: telegram chat ${TELEGRAM_CHAT_ID}"
      echo "text:"
      printf '%s\n' "$message"
      exit 0
    fi
    # Render [label](url) markdown as a clickable Telegram link (parse_mode=HTML), so a short ref
    # like [#15](https://…) shows as clickable "#15". To keep this from ever breaking on stray
    # < > & in prose, HTML-escape the WHOLE message FIRST (& before < > so it isn't double-escaped),
    # THEN convert the link syntax — bracket/paren chars aren't HTML-special so they survive intact,
    # and the <a …> tags we add afterwards are the only real markup. URLs restricted to a safe charset.
    html="$(printf '%s' "$message" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
    html="$(printf '%s' "$html" | sed -E 's#\[([^][]*)\]\((https?://[^() ]+)\)#<a href="\2">\1</a>#g')"
    resp="$(curl -fsS -K - \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${html}" \
      --data-urlencode "parse_mode=HTML" \
      --data-urlencode "disable_web_page_preview=true" <<EOF || true
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
EOF
)"
    mid="$(printf '%s' "$resp" | jq -r '.result.message_id // empty' 2>/dev/null || true)"
    if [ -n "$mid" ]; then echo "$mid"; exit 0; fi
    err="$(printf '%s' "$resp" | jq -r '.description // empty' 2>/dev/null || true)"
    echo "reply: telegram send failed${err:+: $err}" >&2
    exit 1
  fi
  echo "reply: no channel configured (need Mattermost or Telegram env)" >&2
  exit 1
fi
api="${MATTERMOST_BASE_URL%/}/api/v4"

# Keep the bot token out of argv (else visible via ps / /proc/<pid>/cmdline while a request is
# in flight): write the Authorization header to a 0600 temp file and have curl read it with
# -H @file. Cleaned up on exit. (curl >= 7.55 for -H @file.)
auth_hdr="$(mktemp "${TMPDIR:-/tmp}/mm-auth.XXXXXX")"
chmod 600 "$auth_hdr"
trap 'rm -f "$auth_hdr"' EXIT
printf 'Authorization: Bearer %s\n' "$MATTERMOST_BOT_TOKEN" > "$auth_hdr"
mm=(-sS -H @"$auth_hdr" -H "Content-Type: application/json")   # -sS (not -f): keep 4xx bodies

# --- Resolve the DM channel (same as wait-reply.sh) ---------------------------------------
bot_id="$(curl "${mm[@]}" -f "$api/users/me" | jq -r .id || true)"; [ "$bot_id" = "null" ] && bot_id=""
[ -n "$bot_id" ] || { echo "reply: could not resolve bot identity (bad token?)" >&2; exit 1; }
tgt_id=""
[ -n "${MATTERMOST_TARGET_USER:-}" ] && \
  tgt_id="$(curl "${mm[@]}" -f "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id || true)"
[ "$tgt_id" = "null" ] && tgt_id=""
chan="${MATTERMOST_CHANNEL_ID:-}"
if [ -z "$chan" ] && [ -n "$tgt_id" ]; then
  chan="$(curl "${mm[@]}" -f -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id || true)"
fi
[ "$chan" = "null" ] && chan=""
[ -n "$chan" ] || { echo "reply: could not resolve DM channel (set MATTERMOST_CHANNEL_ID or MATTERMOST_TARGET_USER)" >&2; exit 1; }

# --- Thread-root auto-resolve (kills the 400) ---------------------------------------------
# Mattermost rejects a post whose root_id is itself a reply. Given arg1, GET the post and use
# its .root_id when non-empty (arg1 was an in-thread reply → reply on its root), otherwise arg1
# itself (arg1 was already a root → a post is its own root). Empty arg1 stays a new root.
root_id=""
if [ -n "$root_arg" ]; then
  post="$(curl "${mm[@]}" -f "$api/posts/$root_arg" || true)"
  [ -n "$post" ] || { echo "reply: post '$root_arg' not found" >&2; exit 1; }
  root_id="$(printf '%s' "$post" | jq -r '.root_id // ""')"
  [ "$root_id" = "null" ] && root_id=""
  [ -n "$root_id" ] || root_id="$root_arg"
fi

# --- Build the body with jq (quotes/newlines in $message are safe) -------------------------
body="$(jq -n --arg c "$chan" --arg r "$root_id" --arg m "$message" \
  '{channel_id:$c, root_id:$r, message:$m}')"

if [ "$dry_run" = 1 ]; then
  echo "channel_id: $chan"
  echo "root_id: ${root_id:-<new root>}"
  echo "body:"
  printf '%s\n' "$body"
  exit 0
fi

# --- Post -----------------------------------------------------------------------------------
resp="$(curl "${mm[@]}" -X POST "$api/posts" -d "$body" || true)"
new_id="$(printf '%s' "$resp" | jq -r '.id // ""' 2>/dev/null || true)"
if [ -n "$new_id" ] && [ "$new_id" != "null" ]; then
  echo "$new_id"
  exit 0
fi
# Surface the API error (message/detailed_error) so the caller sees WHY, not a bare non-zero.
err="$(printf '%s' "$resp" | jq -r '[.message, .detailed_error] | map(select(. != null and . != "")) | join(" — ")' 2>/dev/null || true)"
echo "reply: post failed${err:+: $err}" >&2
exit 1
