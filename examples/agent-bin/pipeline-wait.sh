#!/usr/bin/env bash
# pipeline-wait — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# BLOCK until a GitLab CI pipeline reaches a terminal state, instead of printing "waiting…" and
# exiting mid-CI (which forces the orchestrator to re-verify later). Because this is one
# long-running command, waiting costs ~no context — same trick as wait-reply.
#
# Polls `glab api projects/<pid>/pipelines/<id>` every ~15s, printing a compact status line only
# when the status CHANGES. On a terminal state it prints the final status and the non-success
# BLOCKING jobs (allow_failure=false), then exits:
#   success                                   → 0
#   failed / canceled / skipped / manual      → 1
#   timeout before any terminal state         → 3
#
# Usage: pipeline-wait <project_id> <pipeline_id> [--timeout SECONDS]   # default 1800s
#
# Requires glab (authenticated) and jq.
set -euo pipefail

pid="${1:?usage: pipeline-wait <project_id> <pipeline_id> [--timeout SECONDS]}"
plid="${2:?usage: pipeline-wait <project_id> <pipeline_id> [--timeout SECONDS]}"
shift 2

timeout=1800
while [ "$#" -gt 0 ]; do
  case "$1" in
    --timeout) timeout="${2:?--timeout needs SECONDS}"; shift 2;;
    *) echo "pipeline-wait: unknown arg '$1'" >&2; exit 2;;
  esac
done

# Numeric guard: the ids are interpolated into the glab api path, so reject anything non-numeric
# to block path escapes / injection. The timeout is likewise validated before arithmetic.
for v in "$pid" "$plid" "$timeout"; do
  if ! [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "pipeline-wait: '$v' is not a non-negative integer" >&2; exit 2
  fi
done

command -v glab >/dev/null 2>&1 || { echo "pipeline-wait: glab not found on PATH" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "pipeline-wait: jq not found on PATH" >&2; exit 2; }

deadline=$(( $(date +%s) + timeout ))
last=""

while true; do
  # Best-effort fetch: a transient glab/API hiccup should retry on the next tick, not abort under
  # set -e. An empty/garbage body yields an empty status → treated as non-terminal, so we re-poll.
  resp="$(glab api "projects/$pid/pipelines/$plid" 2>/dev/null || true)"
  status="$(printf '%s' "$resp" | jq -r '.status // empty' 2>/dev/null || true)"

  if [ -n "$status" ] && [ "$status" != "$last" ]; then
    printf 'pipeline %s: %s\n' "$plid" "$status"
    last="$status"
  fi

  case "$status" in
    success|failed|canceled|skipped|manual)
      # Terminal. Surface the blocking (allow_failure=false) jobs that did not succeed so the
      # caller sees WHY without a second round-trip.
      jobs="$(glab api "projects/$pid/pipelines/$plid/jobs" 2>/dev/null || true)"
      blocking="$(printf '%s' "$jobs" | jq -r '
        .[]? | select(.allow_failure == false) | select(.status != "success")
        | "  - " + (.name // "?") + " (" + (.status // "?") + ")"' 2>/dev/null || true)"
      if [ "$status" = "success" ]; then
        echo "pipeline $plid: SUCCESS"
        exit 0
      fi
      echo "pipeline $plid: $status (non-success)"
      if [ -n "$blocking" ]; then
        echo "blocking jobs that did not succeed:"
        printf '%s\n' "$blocking"
      fi
      exit 1
      ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "pipeline-wait: timed out after ${timeout}s (last status: ${status:-unknown})" >&2
    exit 3
  fi
  sleep 15
done
