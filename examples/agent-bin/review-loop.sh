#!/usr/bin/env bash
# review-loop — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# After foreman produces a code change, run the review→fix→re-review cycle automatically until the
# code comes back clean — so quality is enforced without a human babysitting. This is the mechanism
# behind the worker "definition of done": a worker does NOT mark itself done until review-loop
# reports CLEAN (or surfaces a security issue / non-convergence for a human).
#
# Phases run IN ORDER on the git repo at DIR. The order is deliberate and confirmed optimal: fix
# correctness first, shrink the surface second, and let security have the final word over the exact
# code that ships.
#   1. code-review loop  — up to --max-rounds of `/code-review <effort> --fix`, committing each
#                          round's auto-fixes, until a round applies NO changes (CLEAN) or the cap.
#   2. simplify loop     — same structure with `/simplify` (quality-only, no bug-hunting).
#   2.5 codex review loop — conditional (see --codex, DEFAULT ON). An INDEPENDENT second model
#                          (OpenAI Codex, default gpt-5.6-sol) reviews the diff vs --base for
#                          correctness bugs + clear simplifications and AUTO-FIXES the ones it is
#                          confident about, driven through the SAME digest/run_fix_phase machinery
#                          and the SAME round cap as the Claude phases. Findings it judges risky /
#                          uncertain are left UNAPPLIED and escalated (same channel as security).
#                          If codex is not installed or not logged in, the phase WARNs and SKIPs —
#                          the loop degrades gracefully to Claude-only, never hard-failing.
#   3. security fix loop — conditional (see --security), and it AUTO-FIXES. Each round runs a
#                          security review of the diff vs --base and APPLIES the fixes it is
#                          confident about (auth / input-validation / secrets / network scope),
#                          committing them, looping fix→recheck until a round applies no changes
#                          (CLEAN) or the cap — the SAME before/after digest + run_fix_phase
#                          machinery the other phases use. `/security-review` itself only REPORTS
#                          (it has no --fix flag), so we drive review-and-apply in one headless
#                          prompt. Findings judged too risky / uncertain to auto-fix are left
#                          UNAPPLIED and flagged (→ human escalation). EVERY finding — auto-fixed or
#                          not — is surfaced in the summary; they are not hidden just because a fix
#                          was applied.
#   4. final convergence — GATED: runs ONLY if the simplify, codex, or security phase applied changes
#                          (there is code that a later reviewer has not re-blessed). When Codex is active it
#                          is a bounded Claude<->Codex RECONCILIATION loop: it alternates a Claude
#                          `/code-review --fix` pass and a Codex recheck and stops only when a full
#                          alternation applies nothing on BOTH — so a Codex fix Claude would flag,
#                          and a Claude fix Codex would flag, are both caught. The alternation is
#                          capped at --max-rounds cycles and each pass is itself round-capped. When
#                          Codex is inactive it degrades to the original single gated `/code-review`
#                          pass (catch a bug a security fix introduced). Skipped when nothing changed
#                          after the codex phase.
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
#   review-loop [--dir DIR] [--base REF] [--target REF|auto|none] [--max-rounds N]
#               [--security auto|on|off] [--effort low|medium|high|max]
#               [--codex|--no-codex] [--codex-model MODEL]
#   review-loop --stop-hook [ ...same opts... ]   # loop-safe Claude Code Stop-hook entrypoint
#   review-loop --help
#
# Defaults: DIR=cwd, target=auto, max-rounds=6, security=on, effort=high, codex=on,
#           codex-model=gpt-5.6-sol, base=merge-base of HEAD with the MR/PR target branch when one
#           can be derived, else with origin/main (falls back to HEAD if unavailable).
#
# SCOPE (--base / --target): a review should cover exactly what the MR/PR changes — no more. The
# diff base therefore has to be the merge-base with the branch this work MERGES INTO, not with
# origin/main: for a branch STACKED on another not-yet-merged branch, the merge-base with
# origin/main sits BELOW the parent branch, so the parent's commits leak into the review scope.
#   --base REF   — use REF verbatim as the diff base. Wins over --target; no merge-base is computed.
#   --target REF — the branch this work merges INTO; base = merge-base of HEAD with it (origin/REF
#                  is preferred over a local REF). Errors if REF does not resolve.
#   --target auto— (default) best-effort: ask glab/gh for the OPEN MR/PR of the current branch and
#                  use its target branch. Any failure (no CLI, no MR, detached HEAD, network/auth
#                  error, unresolvable branch) falls back SILENTLY to the historical default below,
#                  so behaviour without MR context is unchanged.
#   --target none— skip derivation entirely; use the historical default.
# Historical default (the fallback): merge-base of HEAD with origin/main, else origin/HEAD, else HEAD.
#
# --codex / --no-codex:
#   on   — (default) run the Codex independent-reviewer phase and the joint reconciliation. If the
#          codex CLI is missing or not logged in, the phase WARNs and SKIPs (Claude-only fallback).
#   off  — never run Codex; behaves exactly like the pre-Codex review-loop.
# --codex-model MODEL: the Codex model to use (default gpt-5.6-sol).
#
# --security:
#   on   — (default) always run the security fix loop. It reviews the actual diff and only acts on
#          real findings, so it scopes itself — no need to pre-gate. Confident in-scope fixes are
#          auto-applied and committed; risky/uncertain findings are left unapplied and surfaced.
#   off  — never run it (escape hatch for e.g. a huge mechanical sweep).
#   auto — run it only if the changed-file PATHS (diff vs --base, plus uncommitted) match a
#          sensitivity heuristic: auth login oidc token secret password credential crypto session
#          sql query handler route exec deserialize input parse. (Paths, not content — so a script
#          that merely mentions these words does not self-trigger.)
#
# Exit codes / final line:
#   0  CLEAN     — every phase (including Codex, if active) converged and neither the security nor
#                  the Codex phase escalated a risky finding.
#   3  NOT-CLEAN — a phase hit the round cap with changes still applying, a review invocation failed,
#                  and/or the security OR codex phase needs a human (ESCALATE): it could not converge
#                  within the cap OR it found a finding it judged too risky to auto-fix (flagged with
#                  WHY). WHY is printed.
#   2  ERROR     — usage / precondition (bad flag, DIR not a git repo, `claude` not found).
#
# In --stop-hook mode the process still runs the loop once (guarded by a marker file so a
# re-firing Stop hook cannot recurse), but ALWAYS exits 0 so the session is allowed to end; the
# real status is printed. See the companion doc review-loop-hook.md for the settings.json snippet.
#
# Robustness: a non-zero `claude -p` (or `codex exec`) exit or empty output is treated as a soft
# error that ends the current phase with a clear message (it never hangs or crashes the loop). The
# security AND codex phases auto-apply only the fixes they are confident about; anything
# risky/uncertain is left unapplied and escalated rather than silently changed. The Codex phase is a
# best-effort add-on: if codex is unavailable it is skipped with a warning, never failing the loop.
set -euo pipefail

# --- defaults ---------------------------------------------------------------------------------
dir="$PWD"
base=""
target="auto"     # default: best-effort derive the MR/PR target branch, else the historical base
max_rounds=6
security="on"     # default: always run security-review; the command scopes itself to real findings
effort="high"
codex="on"        # default: run the Codex independent-reviewer phase (skips gracefully if unavailable)
codex_model="gpt-5.6-sol"
stop_hook=0

prog="review-loop"

# The one charset a branch NAME may use anywhere in this script: --target's value, a name derived
# from the forge CLI, and the branch we hand to that CLI. The first character excludes '-' so the
# name can never be read as an option by git/gh/glab (a trailing/interior '-' is fine), and the whole
# charset is URL-query-safe so it can go into a `glab api` query verbatim.
branch_re='^[A-Za-z0-9._][A-Za-z0-9._/-]*$'

usage() {
  # Print the usage block (the header comment's Usage section, condensed).
  cat <<'EOF'
review-loop — run code-review + simplify + security (all auto-fixing) to convergence.

Usage:
  review-loop [--dir DIR] [--base REF] [--target REF|auto|none] [--max-rounds N]
              [--security auto|on|off] [--effort low|medium|high|max]
              [--codex|--no-codex] [--codex-model MODEL]
  review-loop --stop-hook [ ...same opts... ]
  review-loop --help

Scope: --base REF uses REF verbatim as the diff base (wins over --target). --target REF diffs from
the merge-base with the branch this work merges INTO, so the review scope equals the MR/PR even for
a branch stacked on another unmerged branch. --target auto (default) derives that branch from the
open MR/PR via glab/gh, falling back silently to the merge-base with origin/main. --target none
skips derivation.

Phases run in order, each capped at --max-rounds and committing per round:
  1. /code-review <effort> --fix loop   (fix correctness)
  2. /simplify loop                     (shrink surface)
  3. codex review loop                  (independent 2nd model; auto-applies confident fixes,
                                         escalates risky ones; skipped if codex unavailable)
  4. security fix loop                  (auto-applies confident in-scope fixes; risky ones surfaced)
  5. final convergence                  (ONLY if simplify/codex/security changed code — bounded Claude<->Codex
                                         reconciliation, or a single /code-review pass if codex off)

Defaults: DIR=cwd, target=auto, max-rounds=6, security=on, effort=high, codex=on,
          codex-model=gpt-5.6-sol, base=merge-base of HEAD with the MR/PR target branch if derivable,
          else with origin/main.

Exit: 0 CLEAN | 3 NOT-CLEAN (cap hit / review failed / security or codex can't converge or risky fix) | 2 usage/error.
EOF
}

die_usage() { echo "$prog: $1" >&2; echo >&2; usage >&2; exit 2; }

# --- arg parsing ------------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)        [ "$#" -ge 2 ] || die_usage "--dir needs DIR"; dir="$2"; shift 2;;
    --base)       [ "$#" -ge 2 ] || die_usage "--base needs REF"; base="$2"; shift 2;;
    --target)     [ "$#" -ge 2 ] || die_usage "--target needs REF|auto|none"; target="$2"; shift 2;;
    --max-rounds) [ "$#" -ge 2 ] || die_usage "--max-rounds needs N"; max_rounds="$2"; shift 2;;
    --security)   [ "$#" -ge 2 ] || die_usage "--security needs auto|on|off"; security="$2"; shift 2;;
    --effort)     [ "$#" -ge 2 ] || die_usage "--effort needs a level"; effort="$2"; shift 2;;
    --codex)      codex="on"; shift;;
    --no-codex)   codex="off"; shift;;
    --codex-model) [ "$#" -ge 2 ] || die_usage "--codex-model needs MODEL"; codex_model="$2"; shift 2;;
    --stop-hook)  stop_hook=1; shift;;
    -h|--help)    usage; exit 0;;
    *)            die_usage "unknown arg '$1'";;
  esac
done

# --- validation -------------------------------------------------------------------------------
case "$security" in auto|on|off) ;; *) die_usage "--security must be auto|on|off (got '$security')";; esac
case "$effort" in low|medium|high|max) ;; *) die_usage "--effort must be low|medium|high|max (got '$effort')";; esac
case "$codex" in on|off) ;; *) die_usage "--codex/--no-codex only (got codex='$codex')";; esac
# --target is either a mode word or a branch name we hand to git ($branch_re keeps it a
# leading-dash-free ref token that git can never read as an option).
case "$target" in
  auto|none) ;;
  -*) die_usage "--target REF must not start with '-' (got '$target')";;
  *) [[ "$target" =~ $branch_re ]] || die_usage "--target must be auto|none or a branch name matching $branch_re (got '$target')";;
esac
# --codex-model is interpolated into the `codex -m` command; restrict its charset (mirrors the
# <name>/<id> posture in spawn-worker.sh / wait-reply.sh) to keep it a single safe token.
[[ "$codex_model" =~ ^[A-Za-z0-9._-]+$ ]] || die_usage "--codex-model must match ^[A-Za-z0-9._-]+$ (got '$codex_model')"
[[ "$max_rounds" =~ ^[0-9]+$ ]] || die_usage "--max-rounds must be a non-negative integer (got '$max_rounds')"
max_rounds="$((10#$max_rounds))"  # normalize: strip leading zeros so 08/09 aren't parsed as octal by later arithmetic
[ "$max_rounds" -ge 1 ] || die_usage "--max-rounds must be >= 1"

command -v git >/dev/null 2>&1 || die_usage "git not found on PATH"
command -v claude >/dev/null 2>&1 || die_usage "claude not found on PATH"

[ -d "$dir" ] || die_usage "DIR '$dir' does not exist"
dir="$(cd "$dir" && pwd)"
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || die_usage "DIR '$dir' is not a git repository"

# --- stop-hook guard (loop-safety for the Stop-hook entrypoint) -------------------------------
# A Claude Code Stop hook re-fires every time the session would end, so a hook that does work and
# lets the session continue can recurse. Guard with a marker file: run the loop at most once per
# marker lifetime. The marker lives in the runtime state dir (gitignored) and should be cleared at
# session start (documented in review-loop-hook.md). We ALSO honor `stop_hook_active` from the
# hook's stdin JSON when present, as a second belt.
#
# This runs BEFORE base/target resolution on purpose: --target auto shells out to gh/glab, which is
# a network round-trip (up to the 25s timeout, twice) — paying that on every Stop fire just to hit
# the marker and exit would stall the end of every single session.
state_dir="${FOREMAN_STATE_DIR:-$dir/state}"
marker="$state_dir/.review-loop-ran"
if [ "$stop_hook" -eq 1 ]; then
  hook_stdin=""
  if [ ! -t 0 ]; then hook_stdin="$(cat 2>/dev/null || true)"; fi
  # here-string, not `printf … | grep`: under `set -o pipefail` an early-matching `grep -q` closes
  # the pipe and the still-writing producer takes SIGPIPE (141), which pipefail would surface as a
  # non-zero pipeline — flipping this guard to the wrong branch. A here-string has no producer pipe.
  if grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<<"$hook_stdin"; then
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

# --- base / target resolution -----------------------------------------------------------------
# The review scope must equal the MR/PR: diff from the merge-base with the branch this work merges
# INTO. Diffing from the merge-base with origin/main over-scopes a branch STACKED on another
# unmerged branch — the parent's commits are below that merge-base and leak into every phase's diff.
# Resolution order: --base (verbatim) > --target REF > --target auto (derived) > historical default.

# Resolve a branch NAME to a ref we can merge-base against, preferring the remote-tracking copy
# (origin/NAME is what the MR actually targets; a stale local NAME may sit far behind). Echoes the
# ref; returns 1 if no form exists.
# `remotes/$b` is tried LAST so an already-remote-qualified name (`--target origin/main`, which the
# docs' own wording invites, or `--target upstream/main`) resolves instead of failing outright.
# Matched against the full refs/remotes|refs/heads paths, NOT a bare `NAME^{commit}`: the bare form
# also resolves TAGS, so a tag named like the target branch could win over the branch itself.
resolve_branch_ref() {
  local b="$1" cand r
  # HEAD is not a branch, and the refs/ prefixing alone does NOT reject it: `git clone` creates
  # refs/remotes/origin/HEAD, so `--target HEAD` would quietly resolve to origin's default branch
  # instead of erroring — and any candidate ending in /HEAD is that same pseudo-ref. Reject up front.
  case "$b" in HEAD|*/HEAD) return 1;; esac
  local cands=("remotes/origin/$b" "heads/$b")
  # Then EVERY other configured remote: a fork checkout whose remote is named `upstream` (or a repo
  # with no `origin` at all) would otherwise resolve nothing for a derived name like "main" that has
  # no local branch, silently dropping the scope fix on exactly the layout that needs it most.
  while IFS= read -r r; do
    if [ -n "$r" ] && [ "$r" != "origin" ]; then cands+=("remotes/$r/$b"); fi
  done < <(git -C "$dir" remote 2>/dev/null || true)
  cands+=("remotes/$b")
  for cand in "${cands[@]}"; do
    if git -C "$dir" rev-parse --verify --quiet "refs/$cand^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "refs/$cand"; return 0
    fi
  done
  return 1
}

# Extract the first "key": "value" string field from JSON on stdin. Enough for the single flat field
# we need, and avoids requiring jq (which glab/gh users do not necessarily have).
_json_str_field() {
  grep -aoE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]*)"[[:space:]]*$/\1/'
}

# Best-effort: the target branch of the OPEN MR/PR for the checked-out branch, via glab or gh.
# Echoes the branch NAME; returns 1 when there is no MR context (detached HEAD, no CLI, no open
# MR/PR, auth/network failure, junk output) so the caller can fall back cleanly. Every invocation is
# stdin-closed and `timeout`-wrapped where available, so it can never hang the loop.
detect_target_branch() {
  local branch remote_url host out="" run=()
  branch="$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || return 1                      # detached HEAD ⇒ no MR to look up
  # The branch goes into a CLI argument and (for glab) a URL query, so hold it to the same charset
  # we accept back. An exotic branch name just means "no MR context" — fall back, don't improvise.
  [[ "$branch" =~ $branch_re ]] || return 1
  remote_url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"

  # Try the forge that matches origin first, then the other — a repo can have both CLIs installed.
  # Match on the HOST only: a substring test over the whole URL misroutes a GitHub repo that merely
  # has "gitlab" in its path (github.com/acme/gitlab-migration).
  host="${remote_url#*://}"; host="${host#*@}"; host="${host%%[:/]*}"
  local order=(gh glab) tool
  case "$host" in *gitlab*) order=(glab gh);; esac

  # Probe wrapper (hoisted: the timeout lookup does not vary per tool).
  local wrap=()
  if command -v timeout >/dev/null 2>&1; then wrap=(timeout 25); fi

  for tool in "${order[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || continue
    # ${wrap[@]+"${wrap[@]}"}, not a bare "${wrap[@]}": on bash < 4.4 (stock macOS bash 3.2)
    # expanding an EMPTY array under `set -u` is an "unbound variable" fatal. That is exactly the
    # box where `timeout` is missing (so wrap IS empty), which would kill this subshell and silently
    # disable --target auto on every macOS run.
    run=(${wrap[@]+"${wrap[@]}"} "$tool")
    case "$tool" in
      # `pr list --state open`, not `pr view <branch>`: pr view also resolves a CLOSED or MERGED PR
      # for the branch, whose base could be a long-dead release branch — a wrong, over-narrow scope
      # is worse than falling back. --limit 1 keeps the response to the one MR/PR we act on.
      gh)   out="$( (cd "$dir" && "${run[@]}" pr list --head "$branch" --state open --limit 1 \
                       --json baseRefName </dev/null 2>/dev/null) \
                    | _json_str_field baseRefName || true )";;
      # `glab api`, not `glab mr view -F json`: `-F json` only exists on recent glab (on 1.36 it is
      # "unknown shorthand flag: 'F'"), so the mr-view form fails closed on every older install and
      # the GitLab path never derives anything. The REST endpoint is stable across versions and
      # filters to opened MRs the same way the gh call does.
      glab) out="$( (cd "$dir" && "${run[@]}" api \
                       "projects/:fullpath/merge_requests?source_branch=$branch&state=opened&per_page=1" \
                       </dev/null 2>/dev/null) \
                    | _json_str_field target_branch || true )";;
    esac
    out="${out//[$'\r\n\t ']/}"
    # Only accept a plausible branch name — never feed CLI error prose or an option-looking string
    # into git. An unusable answer means "no MR context", i.e. fall back.
    [[ "$out" =~ $branch_re ]] || { out=""; continue; }
    printf '%s\n' "$out"; return 0
  done
  return 1
}

if [ -z "$base" ]; then
  target_branch=""
  case "$target" in
    none) ;;
    auto) target_branch="$(detect_target_branch || true)";;
    *)    target_branch="$target";;
  esac
  if [ -n "$target_branch" ]; then
    if target_ref="$(resolve_branch_ref "$target_branch")"; then
      # Display the short form (origin/main, main) — the full refs/ path is only there to keep
      # resolution unambiguous, and reads as noise in a log line.
      target_disp="${target_ref#refs/remotes/}"; target_disp="${target_disp#refs/heads/}"
      base="$(git -C "$dir" merge-base HEAD "$target_ref" 2>/dev/null || true)"
      if [ -n "$base" ]; then
        echo "$prog: scoping the review to the MR/PR target branch $target_disp"
      else
        # Unrelated histories: no shared commit to diff from. Only reachable for an explicit
        # --target (auto only yields a branch the forge says we merge into), so tell the user.
        echo "$prog: no merge-base between HEAD and $target_disp — falling back to the default base" >&2
      fi
    elif [ "$target" = "auto" ]; then
      # Derived a name but have no local copy of it (unfetched target branch) — stay silent-ish and
      # fall back rather than failing a run that would otherwise work.
      echo "$prog: MR/PR target branch '$target_branch' not found locally (try 'git fetch') — falling back to the default base" >&2
    else
      die_usage "--target '$target' does not resolve to a branch (tried <remote>/$target for every remote, local $target, and $target as a remote-qualified ref)"
    fi
  fi
fi

# Historical default: merge-base with origin/main, else origin/HEAD, else HEAD (⇒ empty diff,
# security auto=off). Reached whenever no target was given/derived/usable, so behaviour without MR
# context is exactly what it was before --target existed.
if [ -z "$base" ]; then
  base="$(git -C "$dir" merge-base HEAD origin/main 2>/dev/null \
        || git -C "$dir" merge-base HEAD origin/HEAD 2>/dev/null \
        || git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$base" ] || die_usage "could not resolve a base ref (pass --base REF)"
# $base is immutable from here on, so resolve its short form ONCE and reuse it (the header + both
# prompt builders would otherwise fork `git rev-parse --short` on every call / every reconcile cycle).
base_short="$(git -C "$dir" rev-parse --short "$base" 2>/dev/null || echo "$base")"

# Scope suffix for the CLAUDE phases. /code-review and /simplify derive the diff range THEMSELVES
# (`git diff @{upstream}...HEAD`, else `main...HEAD`) — which is exactly the over-scoping the
# --base/--target resolution above exists to fix, so without handing them the resolved base the fix
# would only reach the codex/security prompts and the `--security auto` heuristic. Appended to the
# slash command; run_fix_phase's $display keeps the per-round header short.
claude_scope=" — SCOPE: the diff base for this review is $base_short. Review ONLY \`git diff $base_short...HEAD\` plus any uncommitted changes; do NOT derive the range yourself and do NOT review commits below that base."

# --- helpers ----------------------------------------------------------------------------------
_hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

# Digest of the FULL working-tree state (tracked modifications + staged + untracked content).
# We hash the tracked diff plus the name+content of every untracked (non-ignored) file WITHOUT
# touching the index — an earlier version used `git add -A -N` to make untracked content show in
# `diff HEAD`, but on the clean-converge path (a phase that ends without committing) that left the
# intent-to-add entries staged, dirtying the worker's index for files it never touched.
_tree_digest() {
  {
    # Include HEAD: a reviewer that ignores the "do not commit" instruction and commits its OWN fix
    # leaves the working tree matching HEAD again, so `diff HEAD` would be byte-identical before/after
    # and the round would false-converge CLEAN with the fix silently un-re-reviewed. Folding the HEAD
    # sha in makes such a self-commit register as a change (before recomputes each round, so our own
    # per-round commit is a fresh baseline, not spurious churn).
    git -C "$dir" rev-parse HEAD 2>/dev/null || true
    git -C "$dir" diff HEAD 2>/dev/null || true
    # -z: NUL-delimited AND UN-quoted paths. Without it git C-quotes names with non-ASCII/control
    # bytes (core.quotePath), so `cat -- "$dir/$f"` would seek the literal quoted string, miss the
    # real file, and drop its content from the digest — hiding a fix applied to such an untracked file
    # (before==after ⇒ false CLEAN, edit left uncommitted).
    { git -C "$dir" ls-files --others --exclude-standard -z 2>/dev/null || true; } \
      | while IFS= read -r -d '' f; do
          printf '=== %s ===\n' "$f"
          cat -- "$dir/$f" 2>/dev/null || true
        done
  } | _hash | awk '{print $1}'
}

# Shared output tail for the reviewer runners: indent a runner's combined stdout/stderr for the
# transcript, and — when RUN_CLAUDE_CAPTURE is set to a file path — also append the RAW (pre-indent)
# output there so a caller can post-parse it (the security/codex phases use this to surface findings).
_indent_tee() {
  if [ -n "${RUN_CLAUDE_CAPTURE:-}" ]; then
    tee -a "$RUN_CLAUDE_CAPTURE" | sed 's/^/    | /'
  else
    sed 's/^/    | /'
  fi
}

# Run a slash command (or a full headless prompt) in DIR, streaming its output indented. Returns
# claude's exit code (not sed's/tee's). Never aborts the caller — the caller captures the code with
# `|| rc=$?`. `</dev/null` mirrors run_codex: the prompt is passed as an argv arg, so claude needs no
# stdin, and closing it stops a piped invocation (e.g. `data | review-loop`) from feeding leftover
# stdin into the first review round as extra prompt input.
# shellcheck disable=SC2329  # invoked indirectly via run_fix_phase's $runner (default run_claude)
run_claude() {
  local slash="$1"
  ( cd "$dir" && claude -p --dangerously-skip-permissions "$slash" </dev/null ) 2>&1 | _indent_tee
  return "${PIPESTATUS[0]}"
}

# Codex counterpart of run_claude: run one `codex exec` review-and-fix pass in DIR with the given
# full prompt, streaming its output indented and returning codex's exit code. Same RUN_CLAUDE_CAPTURE
# contract so run_fix_phase's caller can post-parse the findings. `</dev/null` is MANDATORY — without
# it codex blocks forever on "Reading additional input from stdin...". The workspace-write sandbox
# lets it edit files non-interactively; -m pins the model. run_fix_phase
# (not codex) does the git commit, so the prompt tells codex not to.
# shellcheck disable=SC2329  # invoked indirectly via run_fix_phase's $runner ("run_codex")
run_codex() {
  local prompt="$1"
  ( cd "$dir" && codex exec --skip-git-repo-check -s workspace-write -m "$codex_model" "$prompt" </dev/null ) 2>&1 \
    | _indent_tee
  return "${PIPESTATUS[0]}"
}

# --- fix-phase runner (code-review, simplify, security) ---------------------------------------
# Runs a review→apply→recheck loop to convergence: each round invokes $slash (a slash command or a
# full prompt) via $runner, digests the working tree before/after, commits any changes, and stops
# when a round applies nothing (CLEAN) or the round cap is hit (NOT-CONVERGED). The security and codex
# phases reuse this unchanged, passing their review-and-fix driver prompt (and, for codex, the
# run_codex runner). $display overrides the (possibly long) prompt shown in the per-round header.
# $runner is the reviewer function to call (default run_claude; run_codex for the Codex phase) — it
# is passed EXPLICITLY rather than via a mutable global so a phase can never leak its runner into the
# next. Sets globals: PHASE_STATUS (CLEAN|NOT-CONVERGED|ERROR), PHASE_ROUNDS, PHASE_CHANGED (0|1).
run_fix_phase() {
  local label="$1" slash="$2" commit_prefix="$3" display="${4:-$2}" runner="${5:-run_claude}"
  PHASE_STATUS="CLEAN"; PHASE_ROUNDS=0; PHASE_CHANGED=0
  local round before after rc
  for ((round = 1; round <= max_rounds; round++)); do
    PHASE_ROUNDS="$round"
    before="$(_tree_digest)"
    echo ">>> $label: round $round/$max_rounds — $runner \"$display\""
    rc=0
    "$runner" "$slash" || rc=$?
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
    if git -C "$dir" diff --cached --quiet 2>/dev/null; then
      # The digest changed but nothing landed in the index (e.g. the edits were only to
      # gitignored paths) — not an error, but there is nothing to commit this round.
      echo "    $label: round $round applied changes — (nothing staged to commit)"
    elif git -C "$dir" commit -q -m "$commit_prefix round $round" >/dev/null 2>&1; then
      echo "    $label: round $round applied changes — committed"
    else
      # Something IS staged but the commit was rejected (pre-commit hook failed, no git identity,
      # gpg signing failed, …). Don't swallow it as "nothing to commit": the fixes are left
      # uncommitted, so the clean-tree-per-round invariant is broken and the next round would
      # re-review the same dirty tree. Surface it as a soft error so the run reports NOT-CLEAN.
      echo "    $label: round $round applied changes but the commit was REJECTED — tree left dirty (soft error)"
      PHASE_STATUS="ERROR"
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      echo "    $label: reviewer exited $rc after applying changes — ending phase (soft error)"
      PHASE_STATUS="ERROR"
      return 0
    fi

    if [ "$round" -eq "$max_rounds" ]; then
      echo "    $label: still applying changes at round cap ($max_rounds) — NOT CONVERGED"
      PHASE_STATUS="NOT-CONVERGED"
    fi
  done
  return 0
}

# Parse a captured review phase's output for its FINDING lines. Echoes the surfaced findings (every
# APPLIED/RISKY line, deduped across rounds, with the NONE sentinel dropped) to stdout, and RETURNS 0
# iff at least one RISKY (deliberately-unapplied) finding is present so the caller can escalate.
# Shared verbatim by the security and codex phases — only the token (SECFINDING|CODEXFINDING) differs.
# Call it in a conditional so its risky-return status is consumed rather than tripping `set -e`:
#   if FINDINGS="$(parse_findings SECFINDING "$cap")"; then RISKY=1; fi
parse_findings() {  # $1=token  $2=capture-file
  local token="$1" cap="$2"
  # We extract from the token onward so leading markdown/indent doesn't matter.
  grep -aoiE "$token:.*" "$cap" 2>/dev/null \
    | grep -viE "^$token:[[:space:]]*NONE[[:space:]]*$" | sort -u || true
  # Last command → the function's return status: 0 if a RISKY finding exists, 1 otherwise.
  grep -aiqE "$token:[[:space:]]*RISKY([[:space:]]|\|)" "$cap" 2>/dev/null
}

# --- security phase (auto-fixing) -------------------------------------------------------------
# Sensitivity heuristic over changed PATHS (not content). Word list from the brief.
SEC_RE='auth|login|oidc|token|secret|password|credential|crypto|session|sql|query|handler|route|exec|deserialize|input|parse'

# Build the driver prompt for ONE security review→fix round. `/security-review` is report-only (it
# has no --fix flag — its own prompt says the final reply must be the markdown report and nothing
# else), so we ask the model to perform that same review AND apply the fixes it is confident about,
# leaving anything risky UNAPPLIED. The working-tree digest (not the model's prose) is what
# run_fix_phase uses to detect whether a round changed anything, so convergence is robust even if the
# free-text output varies. The SECFINDING: lines are parsed only to SURFACE findings and to detect a
# RISKY (deliberately-unapplied) finding for escalation.
build_security_prompt() {
  cat <<EOF
You are running an automated SECURITY FIX pass over the pending changes on this git branch.

SCOPE: review ONLY the code this branch changed — the diff \`git diff $base_short...HEAD\` plus any
uncommitted changes (base $base_short). Do the same analysis Claude Code's /security-review does:
find REAL, exploitable security vulnerabilities that these changes introduce. Do not audit or
"improve" pre-existing code you did not touch. Concentrate on:
  - authentication / authorization
  - input validation & injection (SQL, command, path traversal, XSS, SSRF, deserialization)
  - secrets / credential handling (leaks, weak storage, logging of secrets)
  - network / transport security (TLS, unsafe requests)

THEN ACT on what you find:
  - For each finding you are CONFIDENT about, whose fix is clearly in the scope above AND low-risk
    (a localized change that does not alter intended behavior), APPLY the minimal fix by editing the
    file(s) directly. Touch only what the finding requires. Do not add dependencies, do not refactor
    broadly, do not reformat unrelated code.
  - For any finding that is uncertain, architectural, high-blast-radius, or whose fix could change
    behavior / break functionality, DO NOT edit code — leave it UNAPPLIED and flag it as RISKY.

Do NOT run git commit or git add — the caller commits. Do not create new files unless a fix strictly
requires one.

OUTPUT — emit these machine-readable lines LAST, one per finding, each on its own line:
  SECFINDING: APPLIED | <severity> | <file:line-or-area> | <one line: the issue and the fix applied>
  SECFINDING: RISKY | <severity> | <file:line-or-area> | <one line: the issue> -- NOT APPLIED: <why>
If you found NO security issues in the changed code, emit exactly this single line instead:
  SECFINDING: NONE
EOF
}

# Map a fix-phase convergence status onto a review phase's BASE verdict + reason. $1 is the phase word
# spliced into the reason text (e.g. "security", "codex"); $2 is PHASE_STATUS; $3 is that phase's
# CHANGED flag. Sets MV_STATUS / MV_REASON. Shared by the security and codex phases (the only spot
# their verdict mapping was identical). The RISKY overlay is deliberately NOT applied here — each
# phase layers it on where its risky flag becomes known (security inline; codex in
# finalize_codex_findings, so a reconcile-round RISKY is included too).
map_review_verdict() {
  case "$2" in
    ERROR)         MV_STATUS="ERROR"; MV_REASON="$1 review invocation failed";;
    NOT-CONVERGED) MV_STATUS="NOT-CONVERGED"; MV_REASON="$1 fixes still applying at round cap ($max_rounds)";;
    CLEAN)         MV_STATUS="CLEAN"; MV_REASON="$([ "$3" -eq 1 ] && echo "auto-fixed and converged" || echo "no findings")";;
  esac
}

# Sets globals: SEC_STATUS (SKIPPED|CLEAN|RISKY|NOT-CONVERGED|ERROR), SEC_REASON, SEC_ROUNDS,
# SEC_CHANGED (0|1), SEC_FINDINGS (surfaced finding lines, one per line).
run_security_phase() {
  SEC_STATUS="SKIPPED"; SEC_REASON=""; SEC_ROUNDS=0; SEC_CHANGED=0; SEC_FINDINGS=""
  local do_sec=0 SEC_RISKY=0
  case "$security" in
    on)  do_sec=1; SEC_REASON="--security on";;
    off) do_sec=0; SEC_REASON="--security off";;
    auto)
      local changed
      # Committed changes vs base + uncommitted (tracked) + untracked, one whole path per line.
      # `git diff --name-only` / `ls-files` keep full paths intact — the old
      # `status --porcelain | awk '{print $NF}'` truncated any path containing a space (e.g.
      # "src/session store.js" -> "store.js"), dropping the sensitive token so auto-mode wrongly
      # skipped the security review for exactly the files it exists to catch.
      changed="$( { git -C "$dir" diff --name-only "$base" HEAD 2>/dev/null || true; \
                    git -C "$dir" diff --name-only HEAD 2>/dev/null || true; \
                    git -C "$dir" ls-files --others --exclude-standard 2>/dev/null || true; } | sort -u )"
      # here-string, not `printf … | grep`: under `set -o pipefail`, when the path list exceeds the
      # pipe buffer and an early-matching `grep -iEq` exits first, the still-writing `printf` takes
      # SIGPIPE (141) and pipefail surfaces the pipeline as non-zero — sending us to the else branch
      # and SKIPPING the security review on exactly the large, sensitive diff auto-mode exists for.
      if grep -iEq "$SEC_RE" <<<"$changed"; then
        do_sec=1; SEC_REASON="auto: sensitive path(s) in diff"
      else
        do_sec=0; SEC_REASON="auto: no sensitive paths in diff"
      fi
      ;;
  esac

  echo ">>> security fix loop: $SEC_REASON"
  if [ "$do_sec" -eq 0 ]; then
    SEC_STATUS="SKIPPED"
    return 0
  fi

  # Drive the auto-fixing loop through the SAME run_fix_phase machinery as code-review/simplify:
  # apply confident fixes, digest before/after, commit + recheck until a round changes nothing
  # (CLEAN) or the cap is hit (NOT-CONVERGED). Capture each round's raw output so we can (a) surface
  # every finding and (b) detect a RISKY finding the model deliberately left unapplied.
  SEC_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-sec.XXXXXX" 2>/dev/null)" \
    || { SEC_STATUS="ERROR"; SEC_REASON="could not create temp capture file"; return 0; }
  : > "$SEC_CAP"
  RUN_CLAUDE_CAPTURE="$SEC_CAP"
  run_fix_phase "security-review" "$(build_security_prompt)" "chore(security): auto-fix" \
                "/security-review + apply confident in-scope fixes"
  RUN_CLAUDE_CAPTURE=""
  SEC_ROUNDS="$PHASE_ROUNDS"; SEC_CHANGED="$PHASE_CHANGED"

  # Surface EVERY finding (applied or not), deduped across rounds, and flag a RISKY one for escalation.
  # A finding the model judged too risky to auto-fix forces escalation regardless of convergence.
  # (A risk it re-flags every round is never fixed, so it persists into the final converged round; a
  # stale RISKY from a round that later got fixed only over-escalates — the safe direction.)
  if SEC_FINDINGS="$(parse_findings SECFINDING "$SEC_CAP")"; then SEC_RISKY=1; fi
  rm -f "$SEC_CAP" 2>/dev/null || true; SEC_CAP=""

  # Map the fix-phase convergence onto a security verdict, then overlay RISKY if the model left a
  # finding deliberately unapplied (forces escalation regardless of convergence).
  map_review_verdict "security" "$PHASE_STATUS" "$SEC_CHANGED"
  SEC_STATUS="$MV_STATUS"; SEC_REASON="$MV_REASON"
  if [ "$SEC_STATUS" = "CLEAN" ] && [ "$SEC_RISKY" -eq 1 ]; then
    SEC_STATUS="RISKY"; SEC_REASON="finding(s) too risky to auto-fix — human review required"
  fi
  return 0
}

# --- codex phase (independent second reviewer, auto-fixing) -----------------------------------
# Build the driver prompt for ONE codex review→fix round. Codex reviews the branch diff for
# correctness bugs + clear simplifications and APPLIES the fixes it is confident about, leaving
# risky/uncertain ones UNAPPLIED — exactly mirroring the security phase's "act on the confident,
# escalate the risky" posture, but for general correctness rather than security. The working-tree
# digest (not this prose) drives convergence, so it is robust even though codex's free-text format
# differs from Claude's. The CODEXFINDING: lines are parsed only to SURFACE findings and to detect a
# RISKY (deliberately-unapplied) finding for escalation.
build_codex_prompt() {
  cat <<EOF
You are OpenAI Codex acting as an INDEPENDENT second code reviewer on this git branch, working
ALONGSIDE Claude (which reviews the same diff). Your value is catching what the other model missed.
Review the code THIS branch changed for correctness BUGS and clear, low-risk SIMPLIFICATIONS, and
APPLY the fixes you are confident about (you can edit files directly).

SCOPE: review ONLY the changes on this branch — the diff \`git diff $base_short...HEAD\` plus any
uncommitted changes (base $base_short). Do NOT review or "improve" pre-existing code you did not
touch. Do NOT modify files outside this diff, and never touch logs, state/, notes/, generated
artifacts, or anything under a gitignored path. Do NOT add dependencies, do NOT reformat or refactor
unrelated code.

Look for:
  - correctness bugs: logic errors, wrong conditionals, off-by-one, unhandled error/edge cases,
    resource leaks, incorrect data handling, races, broken control flow, quoting/escaping bugs.
  - clear simplifications: dead code, obvious duplication, needlessly complex constructs — ONLY when
    the simpler form is unambiguously behavior-equivalent.

THEN ACT on what you find:
  - For each finding you are CONFIDENT about, whose fix is minimal, localized, and does NOT change
    intended behavior, APPLY the fix by editing the file(s) directly. Touch only what the finding
    requires.
  - For any finding that is uncertain, ambiguous, high-blast-radius, a matter of taste, or whose fix
    could change behavior / break functionality, DO NOT edit code — leave it UNAPPLIED and flag it
    as RISKY so a human decides. When in doubt, do NOT apply.

Do NOT run \`git commit\` or \`git add\` — the caller commits. Do not create new files unless a fix
strictly requires one.

OUTPUT — emit these machine-readable lines LAST, one per finding, each on its own line:
  CODEXFINDING: <APPLIED|RISKY> | <bug|simplify> | <file:line-or-area> | <one-line issue and action>
For RISKY findings, end the final field with: -- NOT APPLIED: <why>
If you found NOTHING worth changing in the changed code, emit exactly this single line instead:
  CODEXFINDING: NONE
EOF
}

# Preflight: is Codex usable here? Sets CODEX_REASON. Returns 0 if usable, 1 if it should be skipped
# (with CODEX_REASON explaining why — distinguishing DISABLED from the two UNAVAILABLE cases so the
# summary is honest about which happened). The `codex login status` probe makes no model call, and is
# timed + stdin-closed so it can never hang or bill.
codex_usable() {
  if [ "$codex" != "on" ]; then CODEX_REASON="--no-codex (disabled)"; return 1; fi
  if ! command -v codex >/dev/null 2>&1; then
    CODEX_REASON="codex not found on PATH — degrading to Claude-only"; return 1
  fi
  # `codex login status` is a fast LOCAL check (no model call). Wrap it in `timeout` when that binary
  # is available so a wedged probe can't hang, but fall back to a bare call when `timeout` is absent
  # (e.g. stock macOS) — otherwise `timeout`'s 127 "command not found" would be misread as "not logged
  # in" and a fully-configured Codex would be silently skipped.
  local login_probe
  if command -v timeout >/dev/null 2>&1; then login_probe=(timeout 20 codex login status); else login_probe=(codex login status); fi
  if ! "${login_probe[@]}" </dev/null >/dev/null 2>&1; then
    CODEX_REASON="codex not logged in ('codex login status' failed) — degrading to Claude-only"; return 1
  fi
  CODEX_REASON="codex on (model $codex_model)"; return 0
}

# Sets globals: CODEX_STATUS (SKIPPED|CLEAN|RISKY|NOT-CONVERGED|ERROR), CODEX_REASON, CODEX_ROUNDS,
# CODEX_CHANGED (0|1), CODEX_FINDINGS (surfaced lines), CODEX_ACTIVE (0|1 — did the phase actually
# run, i.e. codex was usable). CODEX_CAP is a capture file kept alive across this phase AND the later
# reconciliation (so a RISKY surfaced by a reconcile recheck also escalates); it is parsed + removed
# by finalize_codex_findings after reconciliation.
run_codex_phase() {
  CODEX_STATUS="SKIPPED"; CODEX_REASON=""; CODEX_ROUNDS=0; CODEX_CHANGED=0
  CODEX_FINDINGS=""; CODEX_ACTIVE=0

  if ! codex_usable; then
    echo ">>> codex review phase: SKIPPED — $CODEX_REASON" >&2
    return 0
  fi
  CODEX_ACTIVE=1
  echo ">>> codex review-and-fix loop: $CODEX_REASON"

  # Build the (static, base_short-only) driver prompt ONCE here and reuse it for every codex round in
  # this phase AND every reconcile recheck, instead of re-forking the heredoc via $(...) each time.
  CODEX_PROMPT="$(build_codex_prompt)"
  CODEX_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-codex.XXXXXX" 2>/dev/null)" \
    || { CODEX_STATUS="ERROR"; CODEX_REASON="could not create temp capture file"; CODEX_ACTIVE=0; return 0; }
  : > "$CODEX_CAP"
  RUN_CLAUDE_CAPTURE="$CODEX_CAP"
  run_fix_phase "codex-review" "$CODEX_PROMPT" "chore(review): codex auto-fix" \
                "codex review + apply confident fixes" "run_codex"
  RUN_CLAUDE_CAPTURE=""
  CODEX_ROUNDS="$PHASE_ROUNDS"; CODEX_CHANGED="$PHASE_CHANGED"

  # Convergence verdict from this phase (the RISKY overlay is applied later, in
  # finalize_codex_findings, so a reconcile-round RISKY is included too).
  map_review_verdict "codex" "$PHASE_STATUS" "$CODEX_CHANGED"
  CODEX_STATUS="$MV_STATUS"; CODEX_REASON="$MV_REASON"
  return 0
}

# Parse the accumulated codex capture (main phase + any reconcile rechecks) into surfaced findings +
# the risky-escalation flag, overlay RISKY onto a CLEAN convergence verdict, then remove the capture.
# Safe to call when codex was inactive (CODEX_CAP empty) — it just no-ops.
finalize_codex_findings() {
  [ -n "${CODEX_CAP:-}" ] && [ -f "$CODEX_CAP" ] || return 0
  local CODEX_RISKY=0
  if CODEX_FINDINGS="$(parse_findings CODEXFINDING "$CODEX_CAP")"; then CODEX_RISKY=1; fi
  rm -f "$CODEX_CAP" 2>/dev/null || true
  CODEX_CAP=""
  # A finding codex judged too risky to auto-fix forces escalation regardless of convergence (same
  # rule as the security phase). Only overlay onto an otherwise-CLEAN verdict; a NOT-CONVERGED/ERROR
  # verdict already escalates.
  if [ "$CODEX_RISKY" -eq 1 ] && [ "$CODEX_STATUS" = "CLEAN" ]; then
    CODEX_STATUS="RISKY"; CODEX_REASON="finding(s) too risky/uncertain to auto-fix — human review required"
  fi
}

# --- drive the phases -------------------------------------------------------------------------
echo "== $prog =="
codex_disp="$codex"; [ "$codex" = "on" ] && codex_disp="on ($codex_model)"
echo "dir=$dir  base=$base_short  max-rounds=$max_rounds  effort=$effort  security=$security  codex=$codex_disp"
echo

# Init all codex/reconcile globals up front so `set -u` is happy on every path (e.g. codex disabled).
CODEX_CAP=""; CODEX_PROMPT=""   # CODEX_PROMPT: the codex driver prompt, built once (see run_codex_phase)
CODEX_STATUS="SKIPPED"; CODEX_REASON="--no-codex (disabled)"; CODEX_ROUNDS=0
CODEX_CHANGED=0; CODEX_FINDINGS=""; CODEX_ACTIVE=0

# Belt against a temp-file leak: the security/codex phases mktemp capture files that they rm on the
# normal path, but an unexpected error under `set -e` (or a Ctrl-C) between mktemp and that rm would
# otherwise strand them in TMPDIR. An EXIT trap removes both regardless of how we leave. Both vars are
# initialized above/below before any phase can create a file, so `set -u` is satisfied when it fires.
SEC_CAP=""
trap 'rm -f "$SEC_CAP" "$CODEX_CAP" 2>/dev/null || true' EXIT

run_fix_phase "code-review" "/code-review $effort --fix$claude_scope" "chore(review): code-review auto-fixes" \
              "/code-review $effort --fix"
CR_STATUS="$PHASE_STATUS"; CR_ROUNDS="$PHASE_ROUNDS"; CR_CHANGED="$PHASE_CHANGED"
echo

run_fix_phase "simplify" "/simplify$claude_scope" "chore(review): simplify" "/simplify"
SI_STATUS="$PHASE_STATUS"; SI_ROUNDS="$PHASE_ROUNDS"; SI_CHANGED="$PHASE_CHANGED"
echo

# Codex independent-reviewer phase (before security so security keeps the final word over the exact
# code that ships — including anything Codex changed). Skips gracefully if codex is unavailable.
run_codex_phase
echo

run_security_phase
echo

# --- gated final convergence ------------------------------------------------------------------
# Runs ONLY if a phase AFTER the initial /code-review applied changes — simplify, codex, or security
# — otherwise the tree is already blessed by a correctness pass and there is nothing to re-check.
# (simplify is included because it reworks code AFTER the code-review pass and only shrinks the
# surface; a correctness regression it introduces would otherwise ship un-reviewed whenever codex and
# security both change nothing, e.g. under --no-codex with a clean security run.)
#   * Codex active  → a bounded Claude<->Codex RECONCILIATION: alternate a Claude /code-review pass
#                     and a Codex recheck; the tree is clean only when a full alternation applies
#                     nothing on BOTH (so a Codex fix Claude would flag AND a Claude fix Codex would
#                     flag are caught). Capped at --max-rounds cycles; each pass is itself round-capped.
#   * Codex inactive→ the original single gated /code-review pass (catch a bug a security fix made).
# RECONCILE_STATUS is the umbrella convergence verdict for this phase (CLEAN|NOT-CONVERGED|ERROR).
FCR_RAN=0; FCR_CHANGED=0; FCR_ROUNDS=0     # Claude side of the final phase (for the summary)
FCC_RAN=0; FCC_CHANGED=0                    # Codex side of the reconciliation (for the summary)
RECON_CYCLES=0; RECONCILE_STATUS="CLEAN"
_recon_note() {  # fold a per-pass status into the umbrella verdict (ERROR dominates NOT-CONVERGED)
  case "$1" in
    ERROR)         RECONCILE_STATUS="ERROR";;
    NOT-CONVERGED) [ "$RECONCILE_STATUS" = "ERROR" ] || RECONCILE_STATUS="NOT-CONVERGED";;
  esac
  return 0   # never let this bookkeeping helper's exit status trip `set -e` at the call site
}

if [ "$SEC_CHANGED" -eq 1 ] || [ "$CODEX_CHANGED" -eq 1 ] || [ "$SI_CHANGED" -eq 1 ]; then
  if [ "$CODEX_ACTIVE" -eq 1 ]; then
    echo ">>> joint reconciliation — code changed after the codex phase; converging Claude+Codex"
    for ((cyc = 1; cyc <= max_rounds; cyc++)); do
      RECON_CYCLES="$cyc"
      echo ">>> reconcile cycle $cyc/$max_rounds"
      run_fix_phase "code-review (reconcile)" "/code-review $effort --fix$claude_scope" \
                    "chore(review): reconcile code-review" "/code-review $effort --fix"
      FCR_RAN=1; [ "$PHASE_CHANGED" -eq 1 ] && FCR_CHANGED=1
      c_changed="$PHASE_CHANGED"; _recon_note "$PHASE_STATUS"

      RUN_CLAUDE_CAPTURE="$CODEX_CAP"
      run_fix_phase "codex-review (reconcile)" "$CODEX_PROMPT" "chore(review): reconcile codex" \
                    "codex recheck" "run_codex"
      RUN_CLAUDE_CAPTURE=""
      FCC_RAN=1; [ "$PHASE_CHANGED" -eq 1 ] && FCC_CHANGED=1
      x_changed="$PHASE_CHANGED"; _recon_note "$PHASE_STATUS"
      # A codex reconcile pass that applies fixes means codex DID change code. Reflect that in the
      # phase globals so the summary is consistent: without this, a codex main phase that found
      # nothing (CLEAN / "no findings") but fixed something during reconciliation would print the
      # contradictory `codex: changed=yes status=CLEAN (no findings)`. Only refresh the reason on an
      # otherwise-CLEAN verdict; NOT-CONVERGED/ERROR carry their own (escalating) reason.
      if [ "$x_changed" -eq 1 ]; then
        CODEX_CHANGED=1
        [ "$CODEX_STATUS" = "CLEAN" ] && CODEX_REASON="auto-fixed and converged during reconciliation"
      fi

      if [ "$c_changed" -eq 0 ] && [ "$x_changed" -eq 0 ]; then
        echo "    reconcile: both Claude and Codex applied nothing — joint fixpoint reached"
        # A transient inner round-cap in an EARLIER cycle set RECONCILE_STATUS=NOT-CONVERGED (the
        # inner pass was still churning at its own cap, so the alternation kept going). Reaching a
        # genuine joint fixpoint supersedes that stale verdict — the spec is "CLEAN when a full
        # alternation applies nothing on BOTH", which just happened. A real ERROR is preserved (it
        # still needs a human); only the recoverable NOT-CONVERGED is cleared.
        [ "$RECONCILE_STATUS" = "NOT-CONVERGED" ] && RECONCILE_STATUS="CLEAN"
        if [ "$CODEX_STATUS" = "NOT-CONVERGED" ]; then
          CODEX_STATUS="CLEAN"
          CODEX_REASON="auto-fixed and converged during reconciliation"
        fi
        break
      fi
      if [ "$cyc" -eq "$max_rounds" ]; then
        echo "    reconcile: still changing at cycle cap ($max_rounds) — NOT CONVERGED"
        _recon_note "NOT-CONVERGED"   # fold via the shared helper (ERROR still dominates)
      fi
    done
  else
    echo ">>> final code-review pass — code changed after the initial review (simplify/security/codex); re-checking for regressions"
    run_fix_phase "code-review (post-security)" "/code-review $effort --fix$claude_scope" \
                  "chore(review): post-security code-review" "/code-review $effort --fix"
    FCR_RAN=1; FCR_ROUNDS="$PHASE_ROUNDS"; FCR_CHANGED="$PHASE_CHANGED"; RECONCILE_STATUS="$PHASE_STATUS"
  fi
else
  echo ">>> final convergence pass — skipped (nothing changed after the initial code-review)"
fi
# Parse codex findings from the whole run (main phase + reconcile rechecks) and overlay a RISKY
# escalation onto CODEX_STATUS if codex left anything unapplied.
finalize_codex_findings
echo

# --- summary + verdict ------------------------------------------------------------------------
yn() { [ "$1" -eq 1 ] && echo yes || echo no; }
echo "== summary =="
printf '  code-review : rounds=%s changed=%s status=%s\n' "$CR_ROUNDS" "$(yn "$CR_CHANGED")" "$CR_STATUS"
printf '  simplify    : rounds=%s changed=%s status=%s\n' "$SI_ROUNDS" "$(yn "$SI_CHANGED")" "$SI_STATUS"
printf '  codex       : rounds=%s changed=%s status=%s (%s)\n' "$CODEX_ROUNDS" "$(yn "$CODEX_CHANGED")" "$CODEX_STATUS" "$CODEX_REASON"
if [ -n "$CODEX_FINDINGS" ]; then
  echo "  codex findings (surfaced — auto-fixed ones included; RISKY ones need a human):"
  printf '%s\n' "$CODEX_FINDINGS" | sed 's/^/    - /'
fi
printf '  security    : rounds=%s changed=%s status=%s (%s)\n' "$SEC_ROUNDS" "$(yn "$SEC_CHANGED")" "$SEC_STATUS" "$SEC_REASON"
if [ -n "$SEC_FINDINGS" ]; then
  echo "  security findings (surfaced — auto-fixed ones included; RISKY ones need a human):"
  printf '%s\n' "$SEC_FINDINGS" | sed 's/^/    - /'
fi
if [ "$FCC_RAN" -eq 1 ]; then   # FCC_RAN=1 only on the reconcile path (implies FCR_RAN=1)
  printf '  final-recon : cycles=%s status=%s (claude changed=%s / codex changed=%s)\n' \
    "$RECON_CYCLES" "$RECONCILE_STATUS" "$(yn "$FCR_CHANGED")" "$(yn "$FCC_CHANGED")"
elif [ "$FCR_RAN" -eq 1 ]; then
  printf '  final-review: rounds=%s changed=%s status=%s (ran: code changed after review)\n' "$FCR_ROUNDS" "$(yn "$FCR_CHANGED")" "$RECONCILE_STATUS"
else
  printf '  final-recon : skipped (no code changed after the initial code-review)\n'
fi

why=""
overall="CLEAN"
# Fold one phase's status into the overall verdict + WHY. CLEAN/SKIPPED are fine; anything else means
# a human is needed. RISKY only arises from the codex/security phases; the arm is harmless for the
# others. (labelled per-phase so the WHY names which phase needs attention.)
note_overall() {  # $1=phase label  $2=phase status
  case "$2" in
    CLEAN|SKIPPED) ;;
    RISKY)         overall="NOT-CLEAN"; why="${why:+$why; }$1 finding too risky to auto-fix (see summary)";;
    NOT-CONVERGED) overall="NOT-CLEAN"; why="${why:+$why; }$1 phase hit round cap";;
    ERROR)         overall="NOT-CLEAN"; why="${why:+$why; }$1 review invocation failed";;
  esac
}
note_overall "code-review" "$CR_STATUS"
note_overall "simplify"    "$SI_STATUS"
note_overall "final"       "$RECONCILE_STATUS"
note_overall "codex"       "$CODEX_STATUS"
note_overall "security"    "$SEC_STATUS"

echo
if [ "$overall" = "CLEAN" ]; then
  if [ "$CODEX_ACTIVE" -eq 1 ]; then
    echo "review-loop: CLEAN — all phases converged (Claude+Codex), no security/codex escalation."
  else
    echo "review-loop: CLEAN — all active phases converged, no security escalation."
  fi
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
