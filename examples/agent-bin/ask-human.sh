#!/usr/bin/env bash
# ask-human — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Posts a question to the configured channel(s) and prints a routing id on stdout. Pair
# with `wait-reply <id>` to receive the answer. The human replies in-thread (Mattermost)
# or by replying to the message (Telegram) — no tag to type.
#
# Usage:
#   ask-human "Need a token for gitlab.acme.com" [--options a,b,c] [--urgency blocking|background]
#   ask-human "Send the new value" --secret  # Telegram: reserve before posting; lasts one hour
#
# Channels (any that are configured are used):
#   Mattermost DM:   MATTERMOST_BASE_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_TARGET_USER
#                    (or MATTERMOST_CHANNEL_ID to post to a specific channel instead of a DM)
#   Telegram:        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Routing id: on Mattermost it is the question's post id (so replies correlate by thread
# root_id). On Telegram-only it is a generated id embedded as "#id" in the message.
set +x # Questions and channel credentials must never reach shell tracing.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/channel-mode.sh"
if [ -n "${FOREMAN_ROUTER_TOKEN:-}" ]; then
  helper="${FOREMAN_HOME:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}/src/thread-cli.ts"
  exec bun "$helper" ask-human "$@"
fi
if [ -n "${FOREMAN_THREAD_KEY:-}" ]; then
  echo 'Use thread-reply with text on stdin; questions resume on the next human message.' >&2
  exit 2
fi

question="${1:?usage: ask-human \"question\"|- [--secret] [--options a,b] [--urgency blocking|background]}"
shift || true
# "-" reads the question from stdin instead of argv. Use it whenever the text carries anything
# sensitive (a sign-in URL, a one-time device code): /proc/<pid>/cmdline is world-readable, so an
# argv-passed secret is visible to every local user for the life of the process. Matches `reply -`.
[ "$question" = "-" ] && question="$(cat)"
options=""; urgency="blocking"; secret=0
while [ $# -gt 0 ]; do
  case "$1" in
    --secret) secret=1; shift ;;
    --options) options="$2"; shift 2 ;;
    --urgency) urgency="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Reserve BEFORE sendMessage: a reply can arrive before this script returns its id.
# Secret capture is Telegram-only and requires the updated resident inbox + age setup.
if [ "$secret" = 1 ]; then
  umask 077
  export FOREMAN_STATE_DIR="${FOREMAN_STATE_DIR:-$HOME/.foreman}"
  wm_dir="$FOREMAN_STATE_DIR/wait-reply"
  mkdir -p "$wm_dir"
  helper="${FOREMAN_HOME:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}/src/secret-replies.ts"
  id="$(flock "$wm_dir/.secret.lock" bun "$helper" reserve)"
  sent=0
  trap '[ "$sent" = 1 ] || flock "$wm_dir/.secret.lock" bun "$helper" cancel "$id" >/dev/null 2>&1' EXIT
  # A failed/ambiguous send leaves a tombstone; any late reply is still suppressed.
  printf '%s\n' "url = \"https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage\"" |
    curl -fsS -K - --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${question}
Reply to this message with the value only. This capture expires in one hour.
(ref #${id})" --data-urlencode 'disable_web_page_preview=true' |
    jq -e '.ok == true' >/dev/null
  sent=1
  printf '%s\n' "$id"
  exit 0
fi

gen_id="q$(date +%s)$RANDOM"
routing=""

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
  chan="${MATTERMOST_CHANNEL_ID:-}"
  # Setup/post calls are guarded (|| true) so a transient Mattermost failure degrades to the
  # next configured channel (Telegram, below) instead of aborting the whole script under
  # `set -e` — matching the header's "any channel that is configured is used".
  if [ -z "$chan" ] && [ -n "${MATTERMOST_TARGET_USER:-}" ]; then
    bot_id="$(curl "${mm[@]}" "$api/users/me" | jq -r .id || true)"
    tgt_id="$(curl "${mm[@]}" "$api/users/username/${MATTERMOST_TARGET_USER}" | jq -r .id || true)"
    if [ -n "$bot_id" ] && [ "$bot_id" != "null" ] && [ -n "$tgt_id" ] && [ "$tgt_id" != "null" ]; then
      chan="$(curl "${mm[@]}" -X POST "$api/channels/direct" -d "[\"$bot_id\",\"$tgt_id\"]" | jq -r .id || true)"
    fi
  fi
  [ "$chan" = "null" ] && chan=""
  if [ -n "$chan" ]; then
    # Human tone: no "[foreman]"/urgency tags — the message already comes from the bot
    # account, and the question text is written like a person. Add a light nudge only when
    # the agent is actually blocked.
    text="$question"
    [ -n "$options" ] && text="$text"$'\n'"($options?)"
    [ "$urgency" = "blocking" ] && text="$text"$'\n\n'"(I'm blocked on this one — whenever you get a sec.)"
    resp="$(curl "${mm[@]}" -X POST "$api/posts" \
      -d "$(jq -n --arg c "$chan" --arg m "$text" '{channel_id:$c, message:$m}')" || true)"
    routing="$(echo "$resp" | jq -r .id || true)"
    [ "$routing" = "null" ] && routing=""
  fi
fi

# --- Telegram ---
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  ttext="$question"
  [ -n "$options" ] && ttext="$ttext"$'\n'"($options?)"
  [ "$urgency" = "blocking" ] && ttext="$ttext"$'\n\n'"(blocked on this one — whenever you get a sec.)"
  ttext="$ttext"$'\n'"(ref #$gen_id)"  # keep the #id so wait-reply can correlate on Telegram
  # Token stays out of argv (else visible via ps / /proc/<pid>/cmdline): pass the URL (which
  # embeds the token) via a curl config read from stdin with -K -. chat_id/text are not secret
  # and text may contain newlines (awkward to quote in a config), so they stay as args.
  curl -fsS -K - \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${ttext}" \
    --data-urlencode "disable_web_page_preview=true" >/dev/null <<EOF && : "${routing:=$gen_id}"
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
EOF
fi

[ -n "$routing" ] || { echo "ask-human: no channel configured/reachable" >&2; exit 1; }
echo "$routing"
