#!/usr/bin/env bash
# worker-list — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Render a one-line-per-worker table of every worker ever launched via `spawn-worker`, read from the
# append-only registry `$STATE/workers.jsonl` (where $STATE is ${FOREMAN_STATE_DIR:-state}). For each
# distinct worker name it shows the recorded pid, start time, live state (RUNNING until the wrapper
# touches `<name>.done`, else the recorded exit code), and the `status` field from
# `<name>.result.json` when the worker (or the spawn-worker fallback) has written one.
#
# The registry has TWO line kinds per worker: a launch line `{name,pid,log,brief,started_at}` and an
# exit line `{name,ended_at,exit}`. This tool merges them by name. jq is used when present; a
# grep/sed fallback keeps it working without jq.
#
# Usage: worker-list           # no args
set -euo pipefail

state="${FOREMAN_STATE_DIR:-state}"
registry="$state/workers.jsonl"

if [ ! -f "$registry" ]; then
  echo "worker-list: no registry at $registry (no workers spawned yet)"
  exit 0
fi

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1

# Distinct worker names, in first-seen order preserved by awk (sort would lose launch order).
if [ "$have_jq" -eq 1 ]; then
  names="$(jq -r '.name // empty' "$registry" 2>/dev/null | awk '!seen[$0]++')"
else
  names="$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' "$registry" 2>/dev/null \
           | sed -E 's/.*"([^"]*)"$/\1/' | awk '!seen[$0]++')"
fi

# Pull the LAST value of a JSON field from the registry lines belonging to one worker. jq path selects
# by exact name; the fallback greps the lines carrying `"name":"<name>"` (closing quote = exact match)
# then sed-extracts the field (handles both "key":"str" and "key":num).
field_for() { # $1=name  $2=field
  if [ "$have_jq" -eq 1 ]; then
    jq -r --arg n "$1" --arg f "$2" 'select(.name==$n) | .[$f] // empty' "$registry" 2>/dev/null | tail -n1
  else
    grep -F "\"name\":\"$1\"" "$registry" 2>/dev/null \
      | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"?([^\",}]*)\"?.*/\1/p" | tail -n1
  fi
}

result_status() { # $1=name
  local rf="$state/$1.result.json"
  [ -f "$rf" ] || { printf '%s' "-"; return; }
  local s=""
  if [ "$have_jq" -eq 1 ]; then
    s="$(jq -r '.status // empty' "$rf" 2>/dev/null || true)"
  else
    s="$(sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"?([^",}]*)"?.*/\1/p' "$rf" | head -n1)"
  fi
  [ -n "$s" ] && printf '%s' "$s" || printf '%s' "?"
}

printf '%-20s %-8s %-20s %-12s %s\n' "NAME" "PID" "STARTED" "STATE" "STATUS"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  pid="$(field_for "$name" pid)";        [ -n "$pid" ] || pid="?"
  started="$(field_for "$name" started_at)"; [ -n "$started" ] || started="?"
  if [ -e "$state/$name.done" ]; then
    exitc="$(field_for "$name" exit)"
    if [ -n "$exitc" ]; then st="exit $exitc"; else st="done"; fi
  else
    st="RUNNING"
  fi
  printf '%-20s %-8s %-20s %-12s %s\n' "$name" "$pid" "$started" "$st" "$(result_status "$name")"
done <<EOF
$names
EOF
