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
if [ "$#" -ge 1 ]; then
  message="$1"
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
  echo "reply: Mattermost not configured (need MATTERMOST_BASE_URL + MATTERMOST_BOT_TOKEN)" >&2
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
