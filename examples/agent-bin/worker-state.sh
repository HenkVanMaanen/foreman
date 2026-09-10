#!/usr/bin/env bash
# Read-only worker lifecycle primitives, shared by the CLI helpers and supervisor wake check.
# No process arguments/environments are read and no signals are sent.

worker_identity() {
  local pid="$1" stat rest proc_state start boot
  if [ -r "/proc/$pid/stat" ]; then
    stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
    rest="${stat##*) }"
    # Linux stat fields 3 (state) and 22 (start ticks); comm may itself contain spaces/parentheses.
    set -- $rest
    case "${1:-}" in Z|X|'') return 1;; esac
    boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || return 2
    printf 'linux:%s:%s' "$boot" "${20}"
  else
    stat="$(ps -p "$pid" -o stat= -o lstart= 2>/dev/null)" || return 1
    read -r proc_state start <<< "$stat"
    case "$proc_state" in Z*|X*|'') return 1;; esac
    printf 'ps:%s' "$start"
  fi
}

worker_field() { # state name field — last non-null registry value, tolerant of torn lines
  local state="$1" name="$2" field="$3"
  [ -f "$state/workers.jsonl" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -Rr --arg n "$name" --arg f "$field" \
      'fromjson? | select(.name==$n) | .[$f] // empty' "$state/workers.jsonl" | tail -n1
  else
    sed -nE "/\"name\"[[:space:]]*:[[:space:]]*\"$name\"/s/.*\"$field\"[[:space:]]*:[[:space:]]*\"?([^\",}]*).*/\1/p" \
      "$state/workers.jsonl" | tail -n1
  fi
}

worker_lost_state() {
  local state="$1" name="$2" child identity actual processes pgid proc_state
  if [ -f "$state/$name.child" ]; then
    read -r child identity < "$state/$name.child" || true
    if ! [[ "${child:-}" =~ ^[1-9][0-9]*$ ]] || [ -z "${identity:-}" ] || [ "$identity" = unknown ]; then
      echo UNKNOWN; return
    fi
    if actual="$(worker_identity "$child")"; then
      if [ "$actual" = "$identity" ]; then echo ORPHANED; return; fi
    elif [ "$?" -eq 2 ]; then echo UNKNOWN; return
    fi
    # Job control makes the engine PID its process group ID; descendants can outlive it.
    processes="$(ps -eo pgid=,stat= 2>/dev/null)" || { echo UNKNOWN; return; }
    while read -r pgid proc_state; do
      if [ "$pgid" = "$child" ]; then
        case "$proc_state" in
          Z*|X*) ;; # Zombies cannot do work or hold capacity.
          *) echo ORPHANED; return;;
        esac
      fi
    done <<< "$processes"
  fi
  echo LOST
}

worker_slot_active() {
  local state="$1" name="$2" status
  status="$(worker_state "$state" "$name")"
  case "$status" in
    DONE) return 1;;
    LOST)
      # Without a child observation, a wrapper may have died between fork and recording $!.
      # Reserve the slot conservatively; --force remains the explicit override.
      [ ! -s "$state/$name.child" ]; return;;
    *) return 0;;
  esac
}

worker_state() { # state name -> DONE | RUNNING | STARTING | LOST | ORPHANED | UNKNOWN
  local state="$1" name="$2" pid identity actual requested now
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || { echo UNKNOWN; return; }
  if [ -e "$state/$name.done" ]; then echo DONE; return; fi
  if [ -f "$state/$name.launch" ]; then
    read -r requested pid identity < "$state/$name.launch" || true
    if [ "${pid:-}" = pending ]; then
      now="$(date +%s)"
      if [[ "$requested" =~ ^[0-9]+$ ]] && ((now >= requested && now - requested < 10)); then
        echo STARTING
      else
        echo UNKNOWN
      fi
      return
    fi
  else
    pid="$(worker_field "$state" "$name" pid)"
    identity=""
  fi
  if ! [[ "${pid:-}" =~ ^[1-9][0-9]*$ ]]; then echo UNKNOWN; return; fi
  if actual="$(worker_identity "$pid")"; then :
  elif [ "$?" -eq 2 ]; then echo UNKNOWN; return
  else worker_lost_state "$state" "$name"; return
  fi
  # A legacy bare PID may have been reused. Keep its capacity reserved, but don't assert RUNNING.
  if [ -z "${identity:-}" ]; then echo UNKNOWN
  elif [ "$actual" = "$identity" ]; then echo RUNNING
  else worker_lost_state "$state" "$name"
  fi
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  set -euo pipefail
  worker_state "${1:?state directory required}" "${2:?worker name required}"
fi
