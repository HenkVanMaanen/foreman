#!/usr/bin/env bash
# Unit test for wait-reply.sh INBOX mode — no real Claude, no network.
#
# Drives examples/agent-bin/wait-reply.sh against a PATH-shim `curl` that returns canned
# Mattermost JSON, and asserts the inbox contract:
#   - first-ever call seeds the channel watermark to "now" and blocks (→ exit 3 on timeout)
#   - a canned new human post prints as ONE `MSG <id> <root> <text>` line, watermark advances,
#     and the post is 👀-reacted
#   - two queued posts both print, chronologically; watermark advances to the newest
#   - a non-target (bot) post is filtered out; newlines/tabs in a message collapse to spaces
#   - nothing new before the timeout → exit 3
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/examples/agent-bin/wait-reply.sh"
WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

fail() { echo "FAIL: $1"; exit 1; }

# --- PATH-shim curl: canned Mattermost responses, keyed by the request URL. ------------------
mkdir -p "$WS/bin"
cat > "$WS/bin/curl" <<'CURL'
#!/usr/bin/env bash
# Fake curl: find the http(s) URL among the args and reply with canned JSON. Records the
# post_id of any /reactions POST to $MOCK_REACT_LOG so the caller can assert the 👀 side effect.
url=""; data=""; prev=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a";; esac
  [ "$prev" = "-d" ] && data="$a"
  prev="$a"
done
case "$url" in
  */users/me)            echo '{"id":"bot123"}';;
  */users/username/*)    echo '{"id":"human456"}';;
  */channels/direct)     echo '{"id":"chanABC"}';;
  */reactions)           [ -n "${MOCK_REACT_LOG:-}" ] && echo "$data" | jq -r '.post_id' >> "$MOCK_REACT_LOG"; echo '{}';;
  */channels/*/posts*)
     if [ -n "${MOCK_POSTS_FILE:-}" ] && [ -f "$MOCK_POSTS_FILE" ]; then cat "$MOCK_POSTS_FILE"; else echo '{"posts":{}}'; fi;;
  *) echo '{}';;
esac
CURL
chmod +x "$WS/bin/curl"

export PATH="$WS/bin:$PATH"
export MATTERMOST_BASE_URL="http://mm.test"
export MATTERMOST_BOT_TOKEN="tok"
export MATTERMOST_CHANNEL_ID="chanABC"
export MATTERMOST_TARGET_USER="human"
export FOREMAN_STATE_DIR="$WS/state"
WM_FILE="$WS/state/wait-reply/inbox.watermark"

run_inbox() {  # $1=timeout(seconds) $2=stdout-file ; returns wait-reply's exit code
  FOREMAN_WAIT_TIMEOUT="$1" bash "$SCRIPT" >"$2" 2>"$2.err"
}

# === 1. First-ever call: seeds watermark to ~now, no history dumped, blocks → exit 3 =========
echo "### 1: first call seeds watermark and blocks (timeout → exit 3) ###"
rm -rf "$WS/state"
unset MOCK_POSTS_FILE
before="$(( $(date +%s) * 1000 ))"
rc=0; run_inbox 1 "$WS/o1" || rc=$?
[ "$rc" = 3 ] || fail "expected exit 3 on timeout, got $rc"
[ -f "$WM_FILE" ] || fail "watermark file not created on first call"
wm="$(cat "$WM_FILE")"
[[ "$wm" =~ ^[0-9]+$ ]] || fail "watermark not numeric: '$wm'"
[ "$wm" -ge "$before" ] || fail "watermark ($wm) not seeded to ~now (>= $before)"
[ -s "$WS/o1" ] && fail "first call must not print any MSG (history not dumped)"
echo "  OK (watermark=$wm, exit 3, no output)"

# === 2. One new human post → one MSG line, watermark advances, post 👀-reacted ==============
echo "### 2: one new post prints one MSG line and advances the watermark ###"
printf '1000' > "$WM_FILE"                       # pretend last-seen was create_at 1000
cat > "$WS/posts2.json" <<'JSON'
{"posts":{
  "p1":  {"id":"p1","create_at":5000,"user_id":"human456","root_id":"","message":"hello there"},
  "pbot":{"id":"pbot","create_at":5500,"user_id":"bot123","root_id":"","message":"bot noise"}
}}
JSON
export MOCK_POSTS_FILE="$WS/posts2.json"
export MOCK_REACT_LOG="$WS/react2.log"; : > "$MOCK_REACT_LOG"
rc=0; run_inbox 5 "$WS/o2" || rc=$?
[ "$rc" = 0 ] || { cat "$WS/o2.err"; fail "expected exit 0, got $rc"; }
lines="$(wc -l < "$WS/o2" | tr -d ' ')"
[ "$lines" = 1 ] || { cat "$WS/o2"; fail "expected exactly 1 MSG line, got $lines"; }
grep -qx "MSG p1 - hello there" "$WS/o2" || { cat "$WS/o2"; fail "MSG line malformed"; }
grep -q "pbot" "$WS/o2" && fail "bot post should be filtered out"
[ "$(cat "$WM_FILE")" = 5000 ] || fail "watermark should advance to 5000, got $(cat "$WM_FILE")"
grep -qx "p1" "$MOCK_REACT_LOG" || fail "post p1 was not 👀-reacted"
echo "  OK (one MSG, wm=5000, reacted p1)"

# === 3. Two queued posts both print, chronological; watermark → newest; newline collapses ===
echo "### 3: two queued posts print in order, threaded root_id shown, newlines collapse ###"
printf '1000' > "$WM_FILE"
cat > "$WS/posts3.json" <<'JSON'
{"posts":{
  "p2":{"id":"p2","create_at":6000,"user_id":"human456","root_id":"rootX","message":"second\nline"},
  "p1":{"id":"p1","create_at":5000,"user_id":"human456","root_id":"","message":"first msg"}
}}
JSON
export MOCK_POSTS_FILE="$WS/posts3.json"
export MOCK_REACT_LOG="$WS/react3.log"; : > "$MOCK_REACT_LOG"
rc=0; run_inbox 5 "$WS/o3" || rc=$?
[ "$rc" = 0 ] || { cat "$WS/o3.err"; fail "expected exit 0, got $rc"; }
[ "$(sed -n 1p "$WS/o3")" = "MSG p1 - first msg" ]  || { cat "$WS/o3"; fail "line 1 wrong"; }
[ "$(sed -n 2p "$WS/o3")" = "MSG p2 rootX second line" ] || { cat "$WS/o3"; fail "line 2 wrong (threaded / newline-collapse)"; }
[ "$(cat "$WM_FILE")" = 6000 ] || fail "watermark should advance to newest (6000), got $(cat "$WM_FILE")"
grep -qx "p1" "$MOCK_REACT_LOG" && grep -qx "p2" "$MOCK_REACT_LOG" || fail "both posts should be 👀-reacted"
echo "  OK (two MSG lines, threaded root shown, wm=6000)"

# === 4. Nothing new (all posts at/below the watermark) → exit 3, no output ===================
echo "### 4: nothing newer than watermark → exit 3 ###"
printf '9000' > "$WM_FILE"                        # watermark ahead of every canned post
export MOCK_POSTS_FILE="$WS/posts3.json"
rc=0; run_inbox 1 "$WS/o4" || rc=$?
[ "$rc" = 3 ] || fail "expected exit 3, got $rc"
[ -s "$WS/o4" ] && fail "no MSG expected when nothing is new"
[ "$(cat "$WM_FILE")" = 9000 ] || fail "watermark must not move when nothing new"
echo "  OK (exit 3, watermark unchanged)"

echo
echo "ALL WAIT-REPLY INBOX TESTS PASSED"
