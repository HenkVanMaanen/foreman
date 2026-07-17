#!/usr/bin/env bash
# review-loop — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# After foreman produces a code change, run the review→fix→re-review cycle automatically until the
# code comes back clean — so quality is enforced without a human babysitting. This is the mechanism
# behind the worker "definition of done": a worker does NOT mark itself done until review-loop
# reports CLEAN (or surfaces a security issue / non-convergence for a human).
#
# Three phases run IN ORDER on the git repo at DIR:
#   1. code-review loop  — up to --max-rounds of `/code-review <effort> --fix`, committing each
#                          round's auto-fixes, until a round applies NO changes (CLEAN) or the cap.
#   2. simplify loop     — same structure with `/simplify` (quality-only, no bug-hunting).
#   3. security-review   — conditional (see --security). Reviews the diff vs --base for vulns.
#                          Findings are SURFACED for a human, never auto-applied.
#
# Convergence per round is detected structurally: we digest the working tree before and after the
# review invocation; identical digest ⇒ the round applied nothing ⇒ that phase converged. Each
# round that DID apply changes is committed so the change is both captured and detectable, and so
# the next round reviews on top of a clean tree.
#
# Loop-safety is mandatory and structural: a hard per-phase round cap (never infinite) and a
# measurable-progress requirement (a round with no changes ends the phase). On already-clean code
# the loops do 0 productive rounds and exit 0 fast (idempotent).
#
# Usage:
#   review-loop [--dir DIR] [--base REF] [--max-rounds N]
#               [--security auto|on|off] [--effort low|medium|high|max]
#   review-loop --stop-hook [ ...same opts... ]   # loop-safe Claude Code Stop-hook entrypoint
#   review-loop --help
#
# Defaults: DIR=cwd, max-rounds=3, security=auto, effort=high,
#           base=merge-base of HEAD with origin/main (falls back to HEAD if unavailable).
#
# --security:
#   on   — always run the security-review phase.
#   off  — never run it.
#   auto — run it only if the changed-file PATHS (diff vs --base, plus uncommitted) match a
#          sensitivity heuristic: auth login oidc token secret password credential crypto session
#          sql query handler route exec deserialize input parse. (Paths, not content — so a script
#          that merely mentions these words does not self-trigger.)
#
# Exit codes / final line:
#   0  CLEAN     — every phase converged and no security escalation.
#   3  NOT-CLEAN — a phase hit the round cap with findings still applying, a review invocation
#                  failed, and/or the security review needs a human (ESCALATE). WHY is printed.
#   2  ERROR     — usage / precondition (bad flag, DIR not a git repo, `claude` not found).
#
# In --stop-hook mode the process still runs the loop once (guarded by a marker file so a
# re-firing Stop hook cannot recurse), but ALWAYS exits 0 so the session is allowed to end; the
# real status is printed. See the companion doc review-loop-hook.md for the settings.json snippet.
#
# Robustness: a non-zero `claude -p` exit or empty output is treated as a soft error that ends the
# current phase with a clear message (it never hangs or crashes the loop). Security findings are
# never auto-applied.
set -euo pipefail

# --- defaults ---------------------------------------------------------------------------------
dir="$PWD"
base=""
max_rounds=3
security="auto"
effort="high"
stop_hook=0

prog="review-loop"

usage() {
  # Print the usage block (the header comment's Usage section, condensed).
  cat <<'EOF'
review-loop — run code-review + simplify (+ conditional security-review) to convergence.

Usage:
  review-loop [--dir DIR] [--base REF] [--max-rounds N]
              [--security auto|on|off] [--effort low|medium|high|max]
  review-loop --stop-hook [ ...same opts... ]
  review-loop --help

Defaults: DIR=cwd, max-rounds=3, security=auto, effort=high,
          base=merge-base of HEAD with origin/main.

Exit: 0 CLEAN | 3 NOT-CLEAN (cap hit / review failed / security ESCALATE) | 2 usage/error.
EOF
}

die_usage() { echo "$prog: $1" >&2; echo >&2; usage >&2; exit 2; }

# --- arg parsing ------------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)        dir="${2:?--dir needs DIR}"; shift 2;;
    --base)       base="${2:?--base needs REF}"; shift 2;;
    --max-rounds) max_rounds="${2:?--max-rounds needs N}"; shift 2;;
    --security)   security="${2:?--security needs auto|on|off}"; shift 2;;
    --effort)     effort="${2:?--effort needs a level}"; shift 2;;
    --stop-hook)  stop_hook=1; shift;;
    -h|--help)    usage; exit 0;;
    *)            die_usage "unknown arg '$1'";;
  esac
done

# --- validation -------------------------------------------------------------------------------
case "$security" in auto|on|off) ;; *) die_usage "--security must be auto|on|off (got '$security')";; esac
case "$effort" in low|medium|high|max) ;; *) die_usage "--effort must be low|medium|high|max (got '$effort')";; esac
[[ "$max_rounds" =~ ^[0-9]+$ ]] || die_usage "--max-rounds must be a non-negative integer (got '$max_rounds')"
[ "$max_rounds" -ge 1 ] || die_usage "--max-rounds must be >= 1"

command -v git >/dev/null 2>&1 || die_usage "git not found on PATH"
command -v claude >/dev/null 2>&1 || die_usage "claude not found on PATH"

[ -d "$dir" ] || die_usage "DIR '$dir' does not exist"
dir="$(cd "$dir" && pwd)"
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || die_usage "DIR '$dir' is not a git repository"

# base = merge-base with origin/main, else origin/HEAD, else HEAD (⇒ empty diff, security auto=off).
if [ -z "$base" ]; then
  base="$(git -C "$dir" merge-base HEAD origin/main 2>/dev/null \
        || git -C "$dir" merge-base HEAD origin/HEAD 2>/dev/null \
        || git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$base" ] || die_usage "could not resolve a base ref (pass --base REF)"

# --- stop-hook guard (loop-safety for the Stop-hook entrypoint) -------------------------------
# A Claude Code Stop hook re-fires every time the session would end, so a hook that does work and
# lets the session continue can recurse. Guard with a marker file: run the loop at most once per
# marker lifetime. The marker lives in the runtime state dir (gitignored) and should be cleared at
# session start (documented in review-loop-hook.md). We ALSO honor `stop_hook_active` from the
# hook's stdin JSON when present, as a second belt.
state_dir="${FOREMAN_STATE_DIR:-$dir/state}"
marker="$state_dir/.review-loop-ran"
if [ "$stop_hook" -eq 1 ]; then
  hook_stdin=""
  if [ ! -t 0 ]; then hook_stdin="$(cat 2>/dev/null || true)"; fi
  if printf '%s' "$hook_stdin" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    echo "$prog: stop_hook_active=true — already in a stop cycle, skipping to avoid recursion"
    exit 0
  fi
  if [ -f "$marker" ]; then
    echo "$prog: marker $marker present — already ran this session cycle, skipping"
    exit 0
  fi
  mkdir -p "$state_dir" 2>/dev/null || true
  : > "$marker" 2>/dev/null || true
fi

# --- helpers ----------------------------------------------------------------------------------
_hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

# Digest of the FULL working-tree state (tracked modifications + staged + untracked content).
# `add -A -N` marks untracked files intent-to-add so their content shows in `diff HEAD`; this is a
# benign index side-effect (we commit with `add -A` anyway when a round applies changes).
_tree_digest() {
  git -C "$dir" add -A -N >/dev/null 2>&1 || true
  git -C "$dir" diff HEAD 2>/dev/null | _hash | awk '{print $1}'
}

# Run a slash command headless in DIR, streaming its output indented. Returns claude's exit code
# (not sed's). Never aborts the caller — the caller captures the code with `|| rc=$?`.
run_claude() {
  local slash="$1"
  ( cd "$dir" && claude -p --dangerously-skip-permissions "$slash" ) 2>&1 | sed 's/^/    | /'
  return "${PIPESTATUS[0]}"
}

# --- fix-phase runner (code-review, simplify) -------------------------------------------------
# Sets globals: PHASE_STATUS (CLEAN|NOT-CONVERGED|ERROR), PHASE_ROUNDS, PHASE_CHANGED (0|1).
run_fix_phase() {
  local label="$1" slash="$2" commit_prefix="$3"
  PHASE_STATUS="CLEAN"; PHASE_ROUNDS=0; PHASE_CHANGED=0
  local round before after rc
  for ((round = 1; round <= max_rounds; round++)); do
    PHASE_ROUNDS="$round"
    before="$(_tree_digest)"
    echo ">>> $label: round $round/$max_rounds — claude -p \"$slash\""
    rc=0
    run_claude "$slash" || rc=$?
    after="$(_tree_digest)"

    if [ "$before" = "$after" ]; then
      # No measurable progress this round.
      if [ "$rc" -ne 0 ]; then
        echo "    $label: round $round exited $rc with no changes — ending phase (soft error)"
        PHASE_STATUS="ERROR"
      else
        echo "    $label: round $round applied no changes — converged CLEAN"
        PHASE_STATUS="CLEAN"
      fi
      return 0
    fi

    # Changes applied — capture them so they persist and the next round sees a clean tree.
    PHASE_CHANGED=1
    git -C "$dir" add -A >/dev/null 2>&1 || true
    if git -C "$dir" commit -q -m "$commit_prefix round $round" >/dev/null 2>&1; then
      echo "    $label: round $round applied changes — committed"
    else
      echo "    $label: round $round applied changes — (nothing to commit / commit skipped)"
    fi
    [ "$rc" -eq 0 ] || echo "    $label: (note: claude exited $rc but applied changes; continuing)"

    if [ "$round" -eq "$max_rounds" ]; then
      echo "    $label: still applying changes at round cap ($max_rounds) — NOT CONVERGED"
      PHASE_STATUS="NOT-CONVERGED"
    fi
  done
  return 0
}

# --- security phase ---------------------------------------------------------------------------
# Sensitivity heuristic over changed PATHS (not content). Word list from the brief.
SEC_RE='auth|login|oidc|token|secret|password|credential|crypto|session|sql|query|handler|route|exec|deserialize|input|parse'

# Sets globals: SEC_STATUS (SKIPPED|CLEAN|ESCALATE|ERROR), SEC_REASON.
run_security_phase() {
  SEC_STATUS="SKIPPED"; SEC_REASON=""
  local do_sec=0
  case "$security" in
    on)  do_sec=1; SEC_REASON="--security on";;
    off) do_sec=0; SEC_REASON="--security off";;
    auto)
      local changed
      # committed changes vs base + any uncommitted paths
      changed="$( { git -C "$dir" diff --name-only "$base" HEAD 2>/dev/null || true; \
                    git -C "$dir" status --porcelain 2>/dev/null | awk '{print $NF}'; } | sort -u )"
      if [ -n "$changed" ] && printf '%s\n' "$changed" | grep -iEq "$SEC_RE"; then
        do_sec=1; SEC_REASON="auto: sensitive path(s) in diff"
      else
        do_sec=0; SEC_REASON="auto: no sensitive paths in diff"
      fi
      ;;
  esac

  echo ">>> security-review: $SEC_REASON"
  if [ "$do_sec" -eq 0 ]; then
    SEC_STATUS="SKIPPED"
    return 0
  fi

  local out rc=0
  out="$( cd "$dir" && claude -p --dangerously-skip-permissions "/security-review" 2>&1 )" || rc=$?
  printf '%s\n' "$out" | sed 's/^/    | /'

  if [ "$rc" -ne 0 ]; then
    echo "    security-review: claude exited $rc — treating as ESCALATE (human review needed)"
    SEC_STATUS="ERROR"; SEC_REASON="security-review invocation failed (exit $rc)"
    return 0
  fi

  # Heuristic: findings are never auto-applied, so decide CLEAN vs ESCALATE from the output. A
  # clear "no issues" style verdict ⇒ CLEAN; anything else ⇒ ESCALATE for a human. This is
  # deliberately conservative (unknown ⇒ escalate). Adjust the regex if the skill's phrasing drifts.
  if printf '%s\n' "$out" \
       | grep -iEq 'no (security )?(issues|vulnerabilit|concerns|findings|problems)|nothing to (report|flag)|looks (good|clean)|0 (findings|issues|vulnerabilit)|no vulnerabilit'; then
    echo "    security-review: no findings reported — CLEAN"
    SEC_STATUS="CLEAN"
  else
    echo "    security-review: findings present or verdict unclear — ESCALATE (do NOT auto-fix; human needed)"
    SEC_STATUS="ESCALATE"; SEC_REASON="security-review surfaced findings (human review required)"
  fi
  return 0
}

# --- drive the three phases -------------------------------------------------------------------
echo "== $prog =="
echo "dir=$dir  base=$(git -C "$dir" rev-parse --short "$base" 2>/dev/null || echo "$base")  max-rounds=$max_rounds  effort=$effort  security=$security"
echo

run_fix_phase "code-review" "/code-review $effort --fix" "chore(review): code-review auto-fixes"
CR_STATUS="$PHASE_STATUS"; CR_ROUNDS="$PHASE_ROUNDS"; CR_CHANGED="$PHASE_CHANGED"
echo

run_fix_phase "simplify" "/simplify" "chore(review): simplify"
SI_STATUS="$PHASE_STATUS"; SI_ROUNDS="$PHASE_ROUNDS"; SI_CHANGED="$PHASE_CHANGED"
echo

run_security_phase
echo

# --- summary + verdict ------------------------------------------------------------------------
yn() { [ "$1" -eq 1 ] && echo yes || echo no; }
echo "== summary =="
printf '  code-review : rounds=%s changed=%s status=%s\n' "$CR_ROUNDS" "$(yn "$CR_CHANGED")" "$CR_STATUS"
printf '  simplify    : rounds=%s changed=%s status=%s\n' "$SI_ROUNDS" "$(yn "$SI_CHANGED")" "$SI_STATUS"
printf '  security    : status=%s (%s)\n' "$SEC_STATUS" "$SEC_REASON"

why=""
overall="CLEAN"
for s in "$CR_STATUS" "$SI_STATUS"; do
  case "$s" in
    CLEAN) ;;
    NOT-CONVERGED) overall="NOT-CLEAN"; why="${why:+$why; }phase hit round cap";;
    ERROR)         overall="NOT-CLEAN"; why="${why:+$why; }a review invocation failed";;
  esac
done
case "$SEC_STATUS" in
  ESCALATE) overall="NOT-CLEAN"; why="${why:+$why; }security review needs a human";;
  ERROR)    overall="NOT-CLEAN"; why="${why:+$why; }security review invocation failed";;
esac

echo
if [ "$overall" = "CLEAN" ]; then
  echo "review-loop: CLEAN — all phases converged, no security escalation."
  final_rc=0
else
  echo "review-loop: NOT-CLEAN — human needed. WHY: $why"
  final_rc=3
fi

# In stop-hook mode always exit 0 so the Stop hook lets the session end (loop-safety); the real
# status was printed above and any fixes were committed.
if [ "$stop_hook" -eq 1 ]; then
  [ "$final_rc" -eq 0 ] || echo "review-loop: (stop-hook mode — exiting 0 to avoid Stop recursion; status above is authoritative)"
  exit 0
fi
exit "$final_rc"
