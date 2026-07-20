#!/usr/bin/env bash
# second-opinion — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# Get an INDEPENDENT second model's critique of a plan / design before you commit to it. foreman's
# harness is Claude-driven; this pipes a plan through OpenAI Codex (a different model, different
# training) so a design gets a genuinely independent read — the risks, hidden assumptions, and
# simpler alternatives one model alone tends to miss. It is a thinking aid, not a gate: it only
# PRINTS a critique, it never edits files or touches git.
#
# Usage:
#   second-opinion [--model M] [--title T] <plan-file>
#   ... | second-opinion [--model M] [--title T]      # plan/design text on stdin
#   second-opinion --help
#
#   --model M   Codex model to use (default: codex's own configured default — gpt-5.6-sol).
#   --title T   Short label for the plan, echoed into the prompt for context.
#   <plan-file> path to the plan/design text; omit it to read the plan from stdin.
#
# It asks Codex for: key risks / failure modes, hidden assumptions, missing cases, simpler /
# alternative approaches, and a bottom-line "would I build this as-is?" verdict. Codex's response
# is printed to stdout under a clearly-framed header.
#
# NON-MUTATING by construction: Codex is invoked with `-s read-only` (read-only sandbox) so it
# physically cannot edit files or run git, and stdin is redirected from /dev/null so it can never
# hang "Reading additional input from stdin...". The whole call is wrapped in a timeout.
#
# Graceful failure (never hang, never silently produce nothing):
#   - codex not on PATH            → warning on stderr, exit 3.
#   - codex not logged in          → warning on stderr, exit 3.
#   - codex nonzero / timed out    → warning on stderr, exit 3.
# Exit 2 is reserved for usage errors.
set -euo pipefail

prog="second-opinion"

usage() {
  cat <<'EOF'
second-opinion — an independent second model's critique of a plan/design (read-only, non-mutating).

Usage:
  second-opinion [--model M] [--title T] <plan-file>
  ... | second-opinion [--model M] [--title T]     # plan on stdin
  second-opinion --help

  --model M   Codex model (default: codex's configured default, gpt-5.6-sol).
  --title T   short label for the plan, passed to Codex for context.

Prints Codex's critique to stdout. Exit: 0 ok | 3 codex missing/not-logged-in/failed | 2 usage.
EOF
}

die_usage() { echo "$prog: $1" >&2; echo >&2; usage >&2; exit 2; }

# --- arg parsing ------------------------------------------------------------------------------
model=""      # empty ⇒ let codex use its configured default
title=""
plan_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) [ "$#" -ge 2 ] || die_usage "--model needs M"; model="$2"; shift 2;;
    --title) [ "$#" -ge 2 ] || die_usage "--title needs T"; title="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    --)
      shift
      if [ "$#" -gt 0 ]; then
        [ -z "$plan_file" ] || die_usage "unexpected extra arg '$1'"
        plan_file="$1"
        shift
      fi
      [ "$#" -eq 0 ] || die_usage "unexpected extra arg '$1'"
      break
      ;;
    -*) die_usage "unknown arg '$1'";;
    *)  [ -z "$plan_file" ] || die_usage "unexpected extra arg '$1'"; plan_file="$1"; shift;;
  esac
done

# Validate --model charset: it is passed to `codex -m` (interpolated into the command), so restrict
# to a safe charset — mirrors the <name>/<id> posture in spawn-worker.sh / wait-reply.sh.
if [ -n "$model" ] && ! [[ "$model" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die_usage "invalid --model '$model' (allowed chars: A-Za-z0-9._-)"
fi

# --- read the plan (file arg or stdin) --------------------------------------------------------
plan=""
if [ -n "$plan_file" ]; then
  [ -f "$plan_file" ] || die_usage "plan file '$plan_file' not found"
  plan="$(cat -- "$plan_file")"
else
  if [ -t 0 ]; then die_usage "no <plan-file> and nothing on stdin"; fi
  plan="$(cat)"
fi
[ -n "${plan//[[:space:]]/}" ] || die_usage "the plan is empty"

# --- codex availability (cheap, no-token probes) ----------------------------------------------
if ! command -v codex >/dev/null 2>&1; then
  echo "$prog: codex not found on PATH — cannot get a second opinion. Install/log in to the Codex CLI." >&2
  exit 3
fi
# Detect `timeout` (coreutils) ONCE and reuse below. We wrap the codex probes in it so a wedged call
# can't hang, but must fall back to a bare call when it's absent (e.g. stock macOS) — otherwise
# `timeout`'s 127 "command not found" would be misread as "not logged in" / "codex exited 127".
have_timeout=0; command -v timeout >/dev/null 2>&1 && have_timeout=1
# `codex login status` is a fast local check (no model call). Nonzero ⇒ not logged in.
if [ "$have_timeout" -eq 1 ]; then login_probe=(timeout 20 codex login status); else login_probe=(codex login status); fi
if ! "${login_probe[@]}" </dev/null >/dev/null 2>&1; then
  echo "$prog: codex is installed but not logged in ('codex login status' failed) — cannot get a second opinion." >&2
  exit 3
fi

# --- build the critique prompt ----------------------------------------------------------------
label="${title:-the following plan/design}"
read -r -d '' prompt <<EOF || true
You are acting as an INDEPENDENT senior reviewer giving a second opinion on a plan/design BEFORE it
is built. You are a different model from the one that wrote it; your value is catching what the
author is likely to have missed. Be direct, specific, and concise — no flattery, no restating the
plan back. This is analysis only: do NOT write or edit any files, do NOT run commands.

Critique "${label}". Structure your answer with these headings:
  1. Key risks / failure modes — what is most likely to go wrong, and why.
  2. Hidden assumptions — things the plan takes for granted that may not hold.
  3. Missing cases — edge cases, error paths, or scenarios not addressed.
  4. Simpler / alternative approaches — if any part is over-built or there is a cleaner path, say so.
  5. Bottom line — a one-line verdict: would you build this as-is? (yes / yes-with-changes / no),
     followed by the single most important change to make first.

Here is the plan/design:
-----8<----- BEGIN PLAN -----8<-----
${plan}
-----8<----- END PLAN -----8<-----
EOF

# --- invoke codex (read-only, timed, stdin closed) --------------------------------------------
# -s read-only     : sandbox cannot edit files or touch git (non-mutating guarantee).
# --skip-git-repo-check : run regardless of whether cwd is a repo (a plan critique needs no repo).
# -o <file>        : write ONLY the model's final message there, so we print the clean critique and
#                    not codex's transcript preamble (workdir/model/tokens banner).
# </dev/null       : never block on "Reading additional input from stdin...".
# timeout          : never hang if the model call stalls.
last_msg="$(mktemp "${TMPDIR:-/tmp}/second-opinion.XXXXXX" 2>/dev/null)" \
  || { echo "$prog: could not create a temp file" >&2; exit 3; }
trap 'rm -f "$last_msg"' EXIT

codex_cmd=(codex exec --skip-git-repo-check -s read-only -o "$last_msg")
[ -n "$model" ] && codex_cmd+=(-m "$model")
codex_cmd+=("$prompt")

model_shown="${model:-gpt-5.6-sol (codex default)}"
timeout_secs="${SECOND_OPINION_TIMEOUT:-300}"

# Prefix with `timeout` only when present (detected once, above) so a stalled model call can't hang;
# on a box without it we fall back to a bare call. The array is always non-empty (codex_cmd is), so
# `"${run_cmd[@]}"` is safe under `set -u` even on bash 3.2.
if [ "$have_timeout" -eq 1 ]; then
  run_cmd=(timeout "$timeout_secs" "${codex_cmd[@]}")
else
  run_cmd=("${codex_cmd[@]}")
fi

log=""
rc=0
log="$("${run_cmd[@]}" </dev/null 2>&1)" || rc=$?
if [ "$rc" -eq 124 ]; then
  echo "$prog: codex timed out after ${timeout_secs}s — no second opinion produced." >&2
  exit 3
fi
if [ "$rc" -ne 0 ]; then
  echo "$prog: codex exited $rc — no second opinion produced. Output:" >&2
  printf '%s\n' "$log" >&2
  exit 3
fi

# Prefer the clean final-message file; fall back to the full transcript if -o produced nothing.
out="$(cat -- "$last_msg" 2>/dev/null || true)"
[ -n "${out//[[:space:]]/}" ] || out="$log"
if [ -z "${out//[[:space:]]/}" ]; then
  echo "$prog: codex returned empty output — no second opinion produced." >&2
  exit 3
fi

# --- print, clearly framed --------------------------------------------------------------------
printf '── Codex second opinion (%s) ──\n' "$model_shown"
[ -n "$title" ] && printf 'on: %s\n' "$title"
printf '\n%s\n' "$out"
