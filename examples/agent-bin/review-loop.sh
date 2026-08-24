#!/usr/bin/env bash
# review-loop — REFERENCE implementation for foreman to adopt into bin/ and refine.
#
# After foreman produces a code change, run the review→fix→re-review cycle automatically until the
# code comes back clean — so quality is enforced without a human babysitting. This is the mechanism
# behind the worker "definition of done": a worker does NOT mark itself done until review-loop
# reports CLEAN (or surfaces a security issue / non-convergence for a human).
#
# Phases run IN ORDER on the git repo at DIR. FOREMAN_REVIEW_ENGINE selects the phase engine
# (`claude` by default; `codex` is opt-in). The independent cross-check ALWAYS uses the opposite
# engine: Claude phases are checked by Codex, and Codex phases are checked by Claude. Keeping those
# roles opposite is deliberate — pointing both at the same engine destroys the second opinion this
# gate exists to provide. The order is deliberate and confirmed optimal: fix correctness first,
# shrink the surface second, and let security have the final word over the exact code that ships.
#   1. review            — TWO fixed passes, not a loop. Pass 1 REPORTS via the built-in `/review
#                          <PR>` (the open GitHub PR found via gh; a diff-scoped review prompt when
#                          there is none), pass 2 APPLIES the findings it is confident about and
#                          commits, flagging the rest RISKY. (The phase is called `review` because
#                          `/review` is literally what it runs. Its label used to be inherited from
#                          the `/code-review --fix` loop it replaced, which read as if that expensive
#                          command were still being invoked.) WHY it is bounded: `/review`
#                          does not fix, so "loop until a round applies nothing" has no fixpoint here
#                          — and the loop it replaces (six `/code-review high --fix` rounds, each a
#                          multi-agent review of the whole diff) is the cost this script was eating.
#                          Findings the apply pass will not touch are ESCALATED, not ground down.
#   2. simplify loop     — same structure with `/simplify` (quality-only, no bug-hunting), but on its
#                          OWN round cap (--simplify-rounds, default 2) rather than --max-rounds.
#                          WHY its own, lower cap: /simplify is a TASTE pass — it can essentially
#                          always find one more thing to tidy, so extra rounds buy churn, not
#                          quality. Six rounds of it is most of why a 20-line change took two hours.
#                          Round 1 does the substantive shrinking; round 2 cleans up after round 1.
#   2.5 cross-check loop  — conditional (see --codex, DEFAULT ON; the flag name is historical). An
#                          INDEPENDENT second model, always the OPPOSITE phase engine, reviews the
#                          diff vs --base for
#                          correctness bugs + clear simplifications and AUTO-FIXES the ones it is
#                          confident about, driven through the SAME digest/run_fix_phase machinery
#                          and the SAME round cap as the Claude phases. Findings it judges risky /
#                          uncertain are left UNAPPLIED and escalated (same channel as security).
#                          If the opposite CLI is unavailable, the phase WARNs and SKIPs — a missing
#                          cross-check is informational, never a finding about the code. If Codex is
#                          selected but its sandbox cannot start (see run_codex), the phase reports
#                          DID-NOT-RUN loudly and its output is discarded rather than parsed into
#                          findings: a missing second opinion is not a review result.
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
#   4. final convergence — GATED: runs ONLY if the simplify, cross-check, or security phase applied
#                          changes (there is code that a later reviewer has not re-blessed). With a
#                          cross-checker it is a bounded primary<->cross-check RECONCILIATION loop:
#                          alternate the phase engine's review pass (phase 1's report+apply pair)
#                          and the opposite engine's recheck, stopping only when a full alternation
#                          applies nothing on BOTH. The alternation is capped at --max-rounds cycles.
#                          Without a cross-checker it degrades to a single gated primary-engine
#                          review pass. Skipped when nothing changed after the cross-check phase.
#   5. escalation pass   — conditional (see --escalation-attempts, DEFAULT 2). Runs LAST, and ONLY
#                          when some phase left a finding UNAPPLIED as RISKY — running it last is
#                          what lets it see every RISKY finding the run produced, including ones the
#                          reconciliation raised. A RISKY finding used to simply END the run and hand
#                          the problem to a human; that is foreman giving up on work an AI can still
#                          do. Instead a FRESH agent gets the finding text, the reason the cheap apply
#                          pass declined it, and explicit permission to spend real effort (read the
#                          surrounding code, run the build/tests, make a larger but justified change)
#                          — and must either FIX it or say concretely why it cannot be fixed safely.
#                          Anything it changes is re-reviewed by the correctness phases (review,
#                          codex if active, security if it was in scope) before it can ship, so an
#                          escalation fix cannot itself ship unreviewed. Bounded at
#                          --escalation-attempts (default 2) attempts, and an attempt that changes
#                          nothing ends the phase — it can never loop.
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
#               [--simplify-rounds N] [--security auto|on|off] [--escalation-attempts N]
#               [--codex|--no-codex] [--codex-model MODEL]
#   review-loop --stop-hook [ ...same opts... ]   # loop-safe Claude Code Stop-hook entrypoint
#   review-loop --self-test-verdict               # exercise the verdict rule offline, then exit
#   review-loop --help
#
# Defaults and --base/--target semantics: `--help` (usage() below) is the only copy — this header
# carries WHY they exist, not what they do.
#
# WHY --base / --target exist: a review should cover exactly what the MR/PR changes — no more. The
# diff base therefore has to be the merge-base with the branch this work MERGES INTO, not with
# origin/main: for a branch STACKED on another not-yet-merged branch, the merge-base with
# origin/main sits BELOW the parent branch, so the parent's commits leak into the review scope.
#
# --codex / --no-codex: historical names for enabling/disabling the independent cross-check and
#   joint reconciliation (default on). The cross-checker is Codex for Claude phases and Claude for
#   Codex phases. A missing cross-checker warns and skips without changing the verdict.
# --codex-model MODEL: the Codex model to use wherever Codex is selected (default gpt-5.6-sol).
#
# FOREMAN_REVIEW_ENGINE (default claude): selects the engine for review, simplify, security and
# escalation. `codex` maps every phase to a scoped `codex exec` prompt; native `codex review` cannot
# take both `--base` and the custom prompt that preserves REVIEWFINDING markers (see the task notes).
# Every Codex call goes through run_codex so the danger-full-access and did-not-run safeguards have
# one implementation. Unknown values are rejected before repository work begins.
#
# --escalation-attempts N (default 2, 0 disables): how many times the escalation pass may be handed
#   a batch of RISKY findings. The bound is small ON PURPOSE. Each attempt is a full agent pass plus
#   a re-review of whatever it changed, so it is the most expensive thing in the run; and if two
#   well-resourced passes cannot fix a finding, a third is not what is missing — a human is. An
#   attempt that changes nothing also ends the phase immediately (a second identical pass over the
#   same findings would just repeat itself), so the real bound is "at most N, usually 1".
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
# Exit codes / final line (see the VERDICT MODEL section below for the full rule and WHY). THREE
# non-clean outcomes, and the difference between them is the whole point — each names a DIFFERENT
# owner of the next step:
#   0  CLEAN          — no unresolved RISKY finding, no security finding, no phase error.
#                       Informational notes (a taste phase stopping at its round cap, a missing Codex
#                       second opinion) may still be printed; they do NOT flip the verdict.
#   3  NEEDS-AI       — FOREMAN HAS MORE WORK TO DO. A RISKY finding survived: either the escalation
#                       pass could not fix it safely, or escalation was disabled/exhausted — or the
#                       security phase found something in the changed code. The next step is another
#                       AI pass (a worker, a targeted fix, a re-run), NOT a question to the human.
#                       (Exit 3 is deliberately the old NOT-CLEAN / NEEDS-HUMAN code, so any caller
#                       testing `rc -eq 3` keeps working.)
#   6  NEEDS-DECISION — A PERSON GENUINELY HAS TO CHOOSE. Reached ONLY when the escalation pass —
#                       which was told to fix the thing — reports back that the fix requires a
#                       PRODUCT decision, a STORED-DATA migration, or an OWNERSHIP/POLICY choice.
#                       Those are not coding problems and no amount of AI effort makes them one; e.g.
#                       "filing this reactie correctly means changing the stored annotation format
#                       for existing user data". Deliberately RARE: no phase can reach it directly,
#                       only an escalation pass that spent an attempt and justified landing here.
#   5  FAILED         — the GATE itself did not complete: a phase ERROR (a review invocation failed,
#                       a round's commit was rejected, the escalation pass itself failed). Its
#                       silence is not approval — re-run it.
#   2  ERROR          — usage / precondition (bad flag, DIR not a git repo, selected engine missing).
#                       Never in --stop-hook mode: a blocking code there would wedge the session.
#   4  BUDGET         — the shared-budget admission gate waited FOREMAN_REVIEW_LOOP_WAIT_TIMEOUT
#                       seconds for a slot (LOAD+2 <= FOREMAN_MAX_WORKERS) and never got one.
#                       `--force` skips it.
# Precedence when several apply: FAILED > NEEDS-AI > NEEDS-DECISION > CLEAN. NEEDS-AI outranks
# NEEDS-DECISION on purpose — while there is still AI work outstanding, foreman has not yet earned
# the right to interrupt a human; do that work, re-run, and the decision question is what is left.
#
# In --stop-hook mode the process still runs the loop once (guarded by a marker file so a
# re-firing Stop hook cannot recurse), but ALWAYS exits 0 so the session is allowed to end; the
# real status is printed. See the companion doc review-loop-hook.md for the settings.json snippet.
#
# Robustness: a non-zero `claude -p` (or `codex exec`) exit or empty output is treated as a soft
# error that ends the current phase with a clear message (it never hangs or crashes the loop). The
# security and independent cross-check phases auto-apply only the fixes they are confident about;
# anything risky/uncertain is left unapplied and escalated rather than silently changed. The
# selected primary engine is required. The opposite-engine cross-check is a best-effort add-on: if
# its CLI is unavailable it is skipped with a warning, never failing the loop.
set -euo pipefail

# Preserve the ORIGINAL argv before the parse loop consumes it, so the edit-while-running snapshot
# (see below) can re-exec itself with exactly the same arguments. Empty-array-safe for old bash.
orig_args=("$@")

# --- defaults ---------------------------------------------------------------------------------
dir="$PWD"
base=""
target="auto"     # default: best-effort derive the MR/PR target branch, else the historical base
max_rounds=6
# /simplify gets its OWN, much lower cap. It is a TASTE pass with no fixpoint to find (there is
# always one more thing to tidy), so rounds 3..6 were paying a full review round each for churn —
# and then reporting "NOT-CONVERGED" as if that were a defect. 2 = one substantive pass plus one
# pass to clean up after it. Raise it with --simplify-rounds if you want the old behaviour.
# Deliberately NOT applied to the correctness phases (review, security, reconciliation): those
# keep --max-rounds, i.e. exactly the thoroughness they had.
simplify_rounds=2
# The escalation pass (see the phase list) is bounded HARD: at most this many attempts per run, and
# an attempt that changes nothing ends the phase. 2 = one real attempt plus one shot at whatever the
# re-review of its fix turned up. 0 disables escalation entirely (a RISKY finding then reports
# NEEDS-AI directly, the pre-escalation behaviour).
escalation_attempts=2
security="on"     # default: always run security-review; the command scopes itself to real findings
codex="on"        # historical flag name: independent opposite-engine cross-check on by default
codex_model="gpt-5.6-sol"
review_engine="${FOREMAN_REVIEW_ENGINE:-claude}"
stop_hook=0
self_test=0            # --self-test-verdict: run the verdict-rule cases and exit (see SELF-TEST)
force=0                # --force: bypass the shared-budget admission wait (human override, see below)
review_loop_marker=""  # our review-loops/<pid> marker, set once ADMITTED; removed by the EXIT trap

# Learn --stop-hook BEFORE the parse loop reaches it, so `die`'s exit-code softening (see below)
# holds for an error raised at ANY argument position — not only after --stop-hook was reached.
for _a in "$@"; do
  if [ "$_a" = "--stop-hook" ]; then stop_hook=1; break; fi
done

prog="review-loop"

# The one charset a branch NAME may use anywhere in this script: --target's value, a name derived
# from the forge CLI, and the branch we hand to that CLI. The first character excludes '-' so the
# name can never be read as an option by git/gh/glab (a trailing/interior '-' is fine), and the whole
# charset is URL-query-safe so it can go into a `glab api` query verbatim.
branch_re='^[A-Za-z0-9._][A-Za-z0-9._/-]*$'

# Run "$@" under `timeout SECS`, or BARE when coreutils `timeout` is missing (stock macOS ships
# none, and there `timeout`'s own 127 "command not found" would be misread as the guarded command
# failing — a wedged forge lookup, a logged-out codex). The bare branch is genuinely unguarded, and
# that trade is deliberate: a false "not logged in" / "no MR" on every macOS run is the worse
# failure, and each guarded site runs at most once per run. Shared by every hang-guard below.
_tmo() { local s="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi; }

usage() {
  # Print the usage block (the header comment's Usage section, condensed).
  cat <<'EOF'
review-loop — run review + simplify + codex + security over this branch's changes.

Usage:
  review-loop [--dir DIR] [--base REF] [--target REF|auto|none] [--max-rounds N]
              [--simplify-rounds N] [--security auto|on|off] [--escalation-attempts N]
              [--codex|--no-codex] [--codex-model MODEL] [--force]
  review-loop --stop-hook [ ...same opts... ]
  review-loop --self-test-verdict
  review-loop --help

FOREMAN_REVIEW_ENGINE=claude (default) preserves the established Claude phase commands and uses
Codex for the independent cross-check. FOREMAN_REVIEW_ENGINE=codex runs the phases with Codex and
uses Claude for the independent cross-check. The two roles intentionally never use one engine.

--self-test-verdict runs the verdict rule over fabricated phase results and exits — no agents, no
repo work. Use it to see exactly what does and does not flip the verdict.

--force bypasses the shared-budget admission WAIT (see below) and starts immediately — a human
override for when you knowingly want to exceed FOREMAN_MAX_WORKERS. Without it, a review-loop counts
as 2 slots against FOREMAN_MAX_WORKERS (shared with spawn-worker) and blocks until 2 slots are free,
or until FOREMAN_REVIEW_LOOP_WAIT_TIMEOUT seconds elapse (default 3600 → exit 4).

Scope: --base REF uses REF verbatim as the diff base (wins over --target); REF must resolve to a
commit or it is a usage error. --target REF diffs from the merge-base with the branch this work
merges INTO, so the review scope equals the MR/PR even for a branch stacked on another unmerged
branch; an explicit REF that does not resolve locally (try `git fetch`) or shares no history with
HEAD is likewise a usage error, NOT a silent fallback. --target auto (default) derives that branch
from the open MR/PR via glab/gh and IS best-effort: it falls back to the merge-base with origin/main
(with a stderr note when a branch was derived but turned out unusable). --target none skips
derivation.

Phases run in order, committing per round; the auto-fixing loops are capped at --max-rounds
(/simplify at --simplify-rounds):
  1. review                             (2 fixed passes: Claude `/review <PR>` / diff prompt, or a
                                         Codex diff-scoped prompt, REPORTS; then ONE apply pass)
  2. simplify loop                      (Claude `/simplify` or equivalent Codex prompt; own lower
                                         cap — a taste pass never runs out of things to tidy)
  3. opposite-engine cross-check        (independent 2nd model; auto-applies confident fixes,
                                         escalates risky ones; missing CLI is informational)
  4. security fix loop                  (auto-applies confident in-scope fixes; risky ones surfaced)
  5. final convergence                  (ONLY if simplify/cross-check/security changed code — bounded
                                         two-engine reconciliation, or one pass if cross-check off)
  6. escalation pass                    (ONLY if some phase left a RISKY finding: a fresh, better-
                                         resourced agent must FIX it or justify why it cannot be;
                                         anything it changes is re-reviewed. --escalation-attempts
                                         N, 0..2, default 2; 0 disables escalation entirely)

Defaults: DIR=cwd, target=auto, max-rounds=6, simplify-rounds=2, security=on, codex=on,
          codex-model=gpt-5.6-sol, escalation-attempts=2, base=merge-base of HEAD with the MR/PR
          target branch if derivable, else with origin/main.

Verdict: driven by CORRECTNESS signals only — a RISKY (deliberately unapplied) finding from any
phase, ANY security finding, or a phase ERROR. CONVERGENCE signals are informational and never flip
it: a phase stopping at its round cap, or Codex not running at all, are reported on their own line.
What a RISKY finding MEANS is decided by the escalation pass: fixed/refuted -> CLEAN, "needs a
product/data/ownership decision" -> NEEDS-DECISION, anything else -> NEEDS-AI.

Exit: 0 CLEAN | 3 NEEDS-AI (a RISKY finding no AI pass resolved / a security finding — more AI work)
| 6 NEEDS-DECISION (the escalation pass says a PERSON must choose: product / data migration /
ownership) | 5 FAILED (a phase errored, so the gate did not complete) | 2 usage/error | 4
budget-wait timeout. Precedence: FAILED > NEEDS-AI > NEEDS-DECISION > CLEAN.
EOF
}

# Exit 2 (usage/precondition) — EXCEPT under --stop-hook, where a non-zero exit is how a Stop hook
# BLOCKS the session from ending (and 2 specifically feeds stderr back to the model as instructions).
# A bad flag or an unresolvable --target would then wedge the very session the marker guard exists to
# let finish: a bad flag dies BEFORE the marker block below, so every subsequent Stop re-fires and
# re-blocks with nothing to stop it. The message is still printed in full; only the CODE is softened
# — same invariant as the always-exit-0 tail.
# $2="usage" also dumps the usage block (argument errors); runtime preconditions omit it, since 25
# lines of flag documentation only buries the one actionable line.
die() {
  echo "$prog: $1" >&2
  if [ "${2:-}" = "usage" ]; then echo >&2; usage >&2; fi
  # Claude Code surfaces a Stop hook's STDERR only when the exit code BLOCKS; on the softened exit 0
  # it is dropped. Repeat the reason on stdout so a typo'd hook command is not silently reviewing
  # nothing, session after session, with no visible signal at all.
  if [ "$stop_hook" -eq 1 ]; then
    echo "$prog: $1 — (stop-hook mode: exiting 0 to avoid wedging the session; NOTHING was reviewed)"
    exit 0
  fi
  exit 2
}
die_usage() { die "$1" usage; }

# --- arg parsing ------------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)        [ "$#" -ge 2 ] || die_usage "--dir needs DIR"; dir="$2"; shift 2;;
    --base)       [ "$#" -ge 2 ] || die_usage "--base needs REF"; base="$2"; shift 2;;
    --target)     [ "$#" -ge 2 ] || die_usage "--target needs REF|auto|none"; target="$2"; shift 2;;
    --max-rounds) [ "$#" -ge 2 ] || die_usage "--max-rounds needs N"; max_rounds="$2"; shift 2;;
    --simplify-rounds) [ "$#" -ge 2 ] || die_usage "--simplify-rounds needs N"; simplify_rounds="$2"; shift 2;;
    --security)   [ "$#" -ge 2 ] || die_usage "--security needs auto|on|off"; security="$2"; shift 2;;
    --escalation-attempts) [ "$#" -ge 2 ] || die_usage "--escalation-attempts needs N"; escalation_attempts="$2"; shift 2;;
    --codex)      codex="on"; shift;;
    --no-codex)   codex="off"; shift;;
    --codex-model) [ "$#" -ge 2 ] || die_usage "--codex-model needs MODEL"; codex_model="$2"; shift 2;;
    --force)      force=1; shift;;
    --stop-hook)  stop_hook=1; shift;;
    --self-test-verdict) self_test=1; shift;;
    -h|--help)    usage; exit 0;;
    *)            die_usage "unknown arg '$1'";;
  esac
done

# --- validation -------------------------------------------------------------------------------
case "$security" in auto|on|off) ;; *) die_usage "--security must be auto|on|off (got '$security')";; esac
case "$codex" in on|off) ;; *) die_usage "--codex/--no-codex only (got codex='$codex')";; esac

# One switch determines BOTH roles. Do not select these independently: the cross-checker's value is
# precisely that it is a different model from the phase engine. This small function is extracted by
# the unit test so the default and both directions stay pinned down.
configure_review_engines() {
  case "$review_engine" in
    claude) phase_runner="run_claude"; crosscheck_engine="codex"; crosscheck_runner="run_codex"
            phase_engine_display="Claude"; crosscheck_engine_display="Codex";;
    codex)  phase_runner="run_codex";  crosscheck_engine="claude"; crosscheck_runner="run_claude"
            phase_engine_display="Codex"; crosscheck_engine_display="Claude";;
    *) die_usage "unknown FOREMAN_REVIEW_ENGINE '$review_engine' (expected: claude|codex)"; return 2;;
  esac
}
configure_review_engines
# --target is either a mode word or a branch name we hand to git.
case "$target" in
  auto|none) ;;
  *) [[ "$target" =~ $branch_re ]] || die_usage "--target must be auto|none or a branch name matching $branch_re (got '$target')";;
esac
# --codex-model is interpolated into the `codex -m` command; restrict its charset (mirrors the
# <name>/<id> posture in spawn-worker.sh / wait-reply.sh) to keep it a single safe token.
[[ "$codex_model" =~ ^[A-Za-z0-9._-]+$ ]] || die_usage "--codex-model must match ^[A-Za-z0-9._-]+$ (got '$codex_model')"
[[ "$max_rounds" =~ ^[0-9]+$ ]] || die_usage "--max-rounds must be a non-negative integer (got '$max_rounds')"
max_rounds="$((10#$max_rounds))"  # normalize: strip leading zeros so 08/09 aren't parsed as octal by later arithmetic
[ "$max_rounds" -ge 1 ] || die_usage "--max-rounds must be >= 1"
[[ "$simplify_rounds" =~ ^[0-9]+$ ]] || die_usage "--simplify-rounds must be a non-negative integer (got '$simplify_rounds')"
simplify_rounds="$((10#$simplify_rounds))"   # same leading-zero normalization as --max-rounds
[ "$simplify_rounds" -ge 1 ] || die_usage "--simplify-rounds must be >= 1"
[[ "$escalation_attempts" =~ ^[0-9]+$ ]] || die_usage "--escalation-attempts must be a non-negative integer (got '$escalation_attempts')"
escalation_attempts="$((10#$escalation_attempts))"   # same leading-zero normalization
# Upper bound, not just a default: escalation is the most expensive thing in the run, and "try more
# passes" is not the answer to a finding two well-resourced passes could not fix.
[ "$escalation_attempts" -le 2 ] || die_usage "--escalation-attempts must be 0..2 (got '$escalation_attempts'); a finding two escalation passes cannot fix needs a human, not a third pass"

# --- VERDICT MODEL ----------------------------------------------------------------------------
# The one thing a human is asked to TRUST without reading a two-hour transcript. It therefore lives
# HERE, before any work starts, so `--self-test-verdict` (below) can drive it with fabricated phase
# results — the rule is verifiable in a second instead of only as the tail of a full run.
#
# WHY it was rewritten. It used to be a boolean: ANY phase status that was not CLEAN/SKIPPED flipped
# the run to NOT-CLEAN. Three consecutive review-loops then reported NOT-CLEAN while nothing was
# actually wrong — the reasons were "/simplify still changing at round 6", "reconcile still changing
# at cycle 6", and a Codex phase that had never started its sandbox. A verdict that is always
# NOT-CLEAN forces a human to read the whole log to discover there is nothing to do, which is
# exactly the work the verdict exists to save.
#
# The rule now separates CORRECTNESS signals from CONVERGENCE signals:
#
#   CORRECTNESS — these DRIVE the verdict and are named in the WHY line:
#     * a RISKY finding from any phase. A reviewer deliberately left something UNAPPLIED. What that
#       MEANS is no longer decided here: it is decided by what the escalation pass did with it (see
#       ESCALATION below). This is the signal the whole gate exists to produce.
#     * ANY security finding, including one the security phase auto-fixed: a vulnerability was
#       present in this branch, so the fix must be verified rather than assumed.
#     * a phase ERROR — the review invocation failed, or a round's changes could not be committed.
#       The phase did not actually run to completion, so its silence proves nothing.
#
#   CONVERGENCE — informational ONLY; printed, but they never flip the verdict and never appear in
#   the WHY line:
#     * simplify (or the final reconciliation) stopping at its round cap. /simplify is a TASTE pass:
#       it can essentially always find one more thing to change, so "still changing at round N" is
#       a fact about the cap, not evidence of a defect in the code.
#     * codex DID-NOT-RUN (see run_codex): the second opinion is MISSING. That degrades the run and
#       is called out loudly on the verdict line, but it is not a finding about the code, and
#       treating it as one is what turned a broken sandbox into a fake RISKY review result.
#
#   ESCALATION — what a RISKY finding MEANS. A RISKY finding no longer ends the run by itself: the
#   escalation phase hands it to a fresh, better-resourced agent that must fix it or justify why it
#   cannot. ESC_STATUS carries that answer back here, and it is what turns a RISKY finding into an
#   outcome:
#     * RESOLVED   — the escalation pass fixed or refuted every risky finding, and the correctness
#                    phases re-ran over whatever it changed. Informational note; the run can be CLEAN.
#     * DECISION   — the pass reports the fix requires a PRODUCT decision, a STORED-DATA migration,
#                    or an OWNERSHIP/POLICY choice ⇒ NEEDS-DECISION. This is the ONLY route to that
#                    outcome, and the pass has to have spent an attempt to claim it — no phase can
#                    dump a finding there directly, which is what keeps it rare and meaningful.
#     * UNRESOLVED — the pass could not fix it safely, ignored its output contract, or ran out of
#                    attempts ⇒ NEEDS-AI: real work is left, and it is AI work.
#     * MIXED      — both of the above happened in one run ⇒ NEEDS-AI (do the AI work first, re-run,
#                    and the decision question is what remains), with BOTH named in the WHY line.
#     * SKIPPED    — escalation disabled (--escalation-attempts 0) ⇒ a RISKY finding reports NEEDS-AI
#                    directly, exactly as it did before escalation existed.
#     * ERROR      — the escalation pass itself failed ⇒ FAILED, like any other broken phase.
#
# FOUR outcomes, because each names a different OWNER of the next step: CLEAN=0 (ship), NEEDS-AI=3
# (foreman has more work to do — the old NOT-CLEAN/NEEDS-HUMAN code, kept so callers testing
# `rc -eq 3` still work), NEEDS-DECISION=6 (a person genuinely has to choose), FAILED=5 (the gate
# broke; re-run it and do not mistake its silence for approval). Precedence: FAILED > NEEDS-AI >
# NEEDS-DECISION > CLEAN.
#
# Inputs are the phase-status globals as the phases leave them: CR_STATUS, SI_STATUS, CODEX_STATUS,
# SEC_STATUS, RECONCILE_STATUS (CLEAN|SKIPPED|RISKY|NOT-CONVERGED|ERROR|DID-NOT-RUN), ESC_STATUS
# (SKIPPED|RESOLVED|DECISION|UNRESOLVED|MIXED|ERROR) plus SEC_FINDINGS (the surfaced security lines)
# and ESC_REASON (a one-line human summary of the escalation pass). Outputs: VERDICT, VERDICT_WHY
# (ONLY reasons that actually contributed), VERDICT_NOTES (informational), VERDICT_RC.
VERDICT="CLEAN"; VERDICT_WHY=""; VERDICT_NOTES=""; VERDICT_RC=0
_verdict_why()  { VERDICT_WHY="${VERDICT_WHY:+$VERDICT_WHY; }$1"; }
_verdict_note() { VERDICT_NOTES="${VERDICT_NOTES:+$VERDICT_NOTES; }$1"; }
# Severity ladder, so a later signal can never DOWNGRADE an earlier one: "the gate broke" outranks
# "more AI work is left" outranks "a person must choose" outranks "ship it".
_verdict_rank() { case "$1" in FAILED) printf 3;; NEEDS-AI) printf 2;; NEEDS-DECISION) printf 1;; *) printf 0;; esac; }
_verdict_escalate() { [ "$(_verdict_rank "$1")" -gt "$(_verdict_rank "$VERDICT")" ] && VERDICT="$1"; return 0; }

compute_verdict() {
  VERDICT="CLEAN"; VERDICT_WHY=""; VERDICT_NOTES=""; VERDICT_RC=0
  local pair label status risky_labels="" risky=0 esc="${ESC_STATUS:-SKIPPED}" esc_why="${ESC_REASON:+ ($ESC_REASON)}"
  # One "<label>:<status>" pair per phase — statuses never contain ':', so the split is unambiguous.
  for pair in "review:${CR_STATUS:-CLEAN}" \
              "simplify:${SI_STATUS:-CLEAN}" \
              "codex:${CODEX_STATUS:-SKIPPED}" \
              "security:${SEC_STATUS:-SKIPPED}" \
              "final:${RECONCILE_STATUS:-CLEAN}"; do
    label="${pair%%:*}"; status="${pair##*:}"
    case "$status" in
      CLEAN|SKIPPED) ;;
      # Collected, not judged: the escalation block below decides what a RISKY finding means, and a
      # phase RISKY status is deliberately never cleared by a re-review (only escalation clears it).
      RISKY)         risky=1; risky_labels="${risky_labels:+$risky_labels, }$label";;
      ERROR)         _verdict_escalate FAILED
                     _verdict_why "$label: phase ERROR — the review did not complete (invocation failed, or a round's commit was rejected)";;
      NOT-CONVERGED) _verdict_note "$label: stopped at its round cap (informational — a cap, not a defect)";;
      DID-NOT-RUN)   _verdict_note "$label: DID NOT RUN — that reviewer contributed nothing to this run";;
      # An unrecognized status is a bug in a phase, not a clean bill of health. Fail toward more work.
      *)             _verdict_escalate NEEDS-AI
                     _verdict_why "$label: unrecognized phase status '$status' — treating it as unfinished AI work";;
    esac
  done
  # What the RISKY findings MEAN is the escalation pass's answer, not this loop's.
  if [ "$risky" -eq 1 ]; then
    case "$esc" in
      RESOLVED)   _verdict_note "$risky_labels: RISKY finding(s) were escalated to a fresh AI pass, which fixed or refuted them$esc_why — the correctness phases re-ran over the result";;
      DECISION)   _verdict_escalate NEEDS-DECISION
                  _verdict_why "$risky_labels: the escalation pass reports the finding(s) need a PRODUCT / STORED-DATA / OWNERSHIP decision, not more code$esc_why — a person must choose";;
      MIXED)      _verdict_escalate NEEDS-DECISION
                  _verdict_why "$risky_labels: part of the escalation needs a PRODUCT / STORED-DATA / OWNERSHIP decision$esc_why"
                  _verdict_escalate NEEDS-AI
                  _verdict_why "$risky_labels: and part of it is still unfixed code the escalation pass could not land safely — do that AI work first, then re-run";;
      ERROR)      _verdict_escalate FAILED
                  _verdict_why "escalation: the escalation pass itself ERRORed$esc_why — the RISKY finding(s) were never actually handled";;
      SKIPPED)    _verdict_escalate NEEDS-AI
                  _verdict_why "$risky_labels: finding(s) left UNAPPLIED as RISKY and no escalation pass ran (--escalation-attempts 0) — more AI work is needed (listed in the summary above)";;
      *)          _verdict_escalate NEEDS-AI
                  _verdict_why "$risky_labels: RISKY finding(s) the escalation pass could not fix safely$esc_why — more AI work is needed (listed in the summary above)";;
    esac
  fi
  # ANY security finding escalates, even one that was auto-fixed or fixed via escalation: a
  # vulnerability existed in the changed code and its fix must be verified, not assumed. Suppressed
  # only while an UNRESOLVED security RISKY is already saying so in its own words above.
  if [ -n "${SEC_FINDINGS:-}" ] && { [ "${SEC_STATUS:-}" != "RISKY" ] || [ "$esc" = "RESOLVED" ]; }; then
    _verdict_escalate NEEDS-AI
    _verdict_why "security: $(printf '%s\n' "$SEC_FINDINGS" | wc -l | tr -d ' ') finding(s) in the changed code (fixed) — the fix must be verified before this ships"
  fi
  case "$VERDICT" in
    CLEAN)          VERDICT_RC=0;;
    NEEDS-AI)       VERDICT_RC=3;;
    NEEDS-DECISION) VERDICT_RC=6;;
    FAILED)         VERDICT_RC=5;;
  esac
  return 0
}

# --- SELF-TEST (--self-test-verdict) ----------------------------------------------------------
# Drive compute_verdict with fabricated phase results and print what each case produces, then exit.
# WHY it exists: this script is the merge gate and a real run costs hours, so the verdict rule has to
# be checkable without one. Add a case here whenever the rule changes; the cases below are the ones
# the rewrite was specified against.
if [ "$self_test" -eq 1 ]; then
  # _st NAME CR SI CODEX SEC RECON ESC [SEC_FINDINGS]  — positional (not KEY=VALUE) so no eval and no
  # bash-4-only `declare -g`; this script still has to run under stock macOS bash 3.2.
  _st() {
    CR_STATUS="$2"; SI_STATUS="$3"; CODEX_STATUS="$4"; SEC_STATUS="$5"; RECONCILE_STATUS="$6"
    ESC_STATUS="$7"; SEC_FINDINGS="${8:-}"; ESC_REASON=""
    compute_verdict
    printf '%-26s -> %-14s exit=%s\n' "$1" "$VERDICT" "$VERDICT_RC"
    [ -n "$VERDICT_WHY" ]   && printf '%-26s    WHY : %s\n' "" "$VERDICT_WHY"
    [ -n "$VERDICT_NOTES" ] && printf '%-26s    note: %s\n' "" "$VERDICT_NOTES"
    return 0
  }
  echo "== review-loop verdict self-test =="
  echo
  _st "all-clean"                CLEAN CLEAN         CLEAN       CLEAN CLEAN SKIPPED
  _st "simplify-capped-only"     CLEAN NOT-CONVERGED CLEAN       CLEAN CLEAN SKIPPED
  _st "reconcile-capped-only"    CLEAN CLEAN         CLEAN       CLEAN NOT-CONVERGED SKIPPED
  _st "codex-did-not-run"        CLEAN CLEAN         DID-NOT-RUN CLEAN CLEAN SKIPPED
  _st "security-finding-fixed"   CLEAN CLEAN         CLEAN       CLEAN CLEAN SKIPPED \
      "SECFINDING: APPLIED | high | api.sh:42 | unquoted \$user in a shell call — quoted it"
  _st "security-risky-unfixable" CLEAN CLEAN         CLEAN       RISKY CLEAN UNRESOLVED \
      "SECFINDING: RISKY | high | api.sh:42 | auth check may be bypassable -- NOT APPLIED: needs a schema change"
  _st "review-risky-no-escal"    RISKY CLEAN         CLEAN       CLEAN CLEAN SKIPPED
  _st "review-risky-escalated"   RISKY CLEAN         CLEAN       CLEAN CLEAN RESOLVED
  _st "codex-risky-unresolved"   CLEAN CLEAN         RISKY       CLEAN CLEAN UNRESOLVED
  _st "risky-needs-decision"     RISKY CLEAN         CLEAN       CLEAN CLEAN DECISION
  _st "risky-mixed"              RISKY CLEAN         RISKY       CLEAN CLEAN MIXED
  _st "escalation-errored"       RISKY CLEAN         CLEAN       CLEAN CLEAN ERROR
  _st "phase-error"              ERROR CLEAN         CLEAN       CLEAN CLEAN SKIPPED
  _st "everything-at-once"       ERROR NOT-CONVERGED DID-NOT-RUN RISKY NOT-CONVERGED MIXED \
      "SECFINDING: RISKY | high | api.sh:42 | auth check may be bypassable -- NOT APPLIED: needs a schema change"
  echo
  echo "(informational signals must never appear in a WHY line, and must never change exit=0)"
  echo "(NEEDS-DECISION is reachable ONLY via an escalation pass reporting DECISION — no phase can"
  echo " land there on its own, which is what keeps it rare)"
  exit 0
fi

command -v git >/dev/null 2>&1 || die_usage "git not found on PATH"
case "$review_engine" in
  claude) command -v claude >/dev/null 2>&1 || die_usage "claude not found on PATH";;
  codex)
    command -v codex >/dev/null 2>&1 || die_usage "codex not found on PATH"
    _tmo 20 codex login status </dev/null >/dev/null 2>&1 \
      || die_usage "codex not logged in ('codex login status' failed)"
    ;;
esac

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
# a network round-trip (~10s worst case, twice) — paying that on every Stop fire just to hit
# the marker and exit would stall the end of every single session.
state_dir="${FOREMAN_STATE_DIR:-$dir/state}"
marker="$state_dir/.review-loop-ran"

# --- edit-while-running safety (self-snapshot + re-exec) --------------------------------------
# HAZARD: bash reads a script lazily, by BYTE OFFSET, as it runs — not all at once. This loop runs
# for minutes, and it reviews/edits the very git repo an agent may `git pull`/checkout concurrently.
# If THIS file is overwritten in place mid-run, bash resumes at its old byte offset in the NEW bytes
# and executes garbage (a subtly different command, or a syntax error). Defuse it by copying ourselves
# to a private snapshot under $STATE and re-execing from there exactly ONCE: the running bytes then
# live at a path nothing else writes. REVIEW_LOOP_SNAPSHOT guards against infinite re-exec; the child
# removes the snapshot on exit via a trap (and the late EXIT trap below also lists it, since a later
# `trap … EXIT` replaces this one). Best-effort: if the copy fails (read-only $STATE), run in place.
if [ "${REVIEW_LOOP_SNAPSHOT:-0}" != "1" ]; then
  snap="$state_dir/.review-loop.$$"
  if mkdir -p "$state_dir" 2>/dev/null && cp -- "$0" "$snap" 2>/dev/null; then
    export REVIEW_LOOP_SNAPSHOT=1 REVIEW_LOOP_SNAPSHOT_FILE="$snap"
    exec bash "$snap" ${orig_args[@]+"${orig_args[@]}"}
  fi
fi
# In the snapshot child, remove the snapshot however we exit. Replaced by the richer EXIT trap later
# in the script (which also lists REVIEW_LOOP_SNAPSHOT_FILE), so cleanup holds across both traps.
if [ -n "${REVIEW_LOOP_SNAPSHOT_FILE:-}" ]; then
  trap 'rm -f "${REVIEW_LOOP_SNAPSHOT_FILE:-}" 2>/dev/null || true' EXIT
fi

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

# --- admission gate (shared FOREMAN_MAX_WORKERS budget) ---------------------------------------
# A review-loop is a HEAVY consumer: it drives its own review agents (`claude -p`/`codex exec`), so
# it counts as 2 slots drawn from the SAME FOREMAN_MAX_WORKERS budget spawn-worker draws from. With
# the default cap of 2 that means one review-loop SATURATES the budget: a 2nd review-loop — or a
# worker launched while one runs — WAITS for a slot instead of blindly piling more agents on (the
# token blow-up this prevents). This runs before the network-y base/target resolution below so we do
# not pay that work until admitted.
#
# LOAD = (active workers) + 2*(active review-loops), where active workers = launch entries in
# workers.jsonl with no <name>.done marker, and active review-loops = LIVE pid markers under
# $state_dir/review-loops. This process may proceed once LOAD + 2 <= cap; otherwise it BLOCK-POLLS
# every 15s (cleaning stale markers + recomputing) until it fits, or exits 4 at the wait timeout.
review_cap="${FOREMAN_MAX_WORKERS:-2}"
[[ "$review_cap" =~ ^[0-9]+$ ]] || review_cap=2   # non-integer ⇒ coerce to the default (2)
review_loops_dir="$state_dir/review-loops"
mkdir -p "$review_loops_dir" 2>/dev/null || true

# Count LIVE review-loop pid markers under $1, deleting any whose pid is dead (stale). A review-loop
# registers an empty file named for its pid under review-loops/ while it runs; "live" = the pid still
# answers `kill -0`. Optional $2 = a pid to EXCLUDE (a review-loop skips its own marker). Echoes the
# live count. Kept in sync verbatim with the copy in spawn-worker.sh (small, so duplicated not sourced).
_review_loop_load() {
  local rl_dir="$1" self="${2:-}" n=0 f pid
  [ -d "$rl_dir" ] || { printf '0'; return 0; }
  for f in "$rl_dir"/*; do
    [ -e "$f" ] || continue                        # empty dir ⇒ the glob stays literal
    pid="${f##*/}"
    case "$pid" in ''|*[!0-9]*) continue;; esac     # not a pid marker we own — leave it untouched
    if kill -0 "$pid" 2>/dev/null; then
      [ "$pid" = "$self" ] && continue              # our own live marker — do not count it
      n=$((n + 1))
    else
      rm -f "$f" 2>/dev/null || true                # dead pid — clean the stale marker
    fi
  done
  printf '%s' "$n"
}

# Count ACTIVE workers: distinct names ever launched in workers.jsonl whose <name>.done is absent
# (mirrors spawn-worker's cap check). 0 when there is no registry yet.
_active_workers() {
  local reg="$state_dir/workers.jsonl" names n active=0
  [ -f "$reg" ] || { printf '0'; return 0; }
  if command -v jq >/dev/null 2>&1; then
    names="$(jq -r '.name // empty' "$reg" 2>/dev/null | sort -u)"
  else
    names="$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' "$reg" 2>/dev/null \
             | sed -E 's/.*"([^"]*)"$/\1/' | sort -u)"
  fi
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ -e "$state_dir/$n.done" ] || active=$((active + 1))
  done <<EOF
$names
EOF
  printf '%s' "$active"
}

# LOAD excluding THIS process (its own marker is skipped via $$).
_current_load() { printf '%s' "$(( $(_active_workers) + 2 * $(_review_loop_load "$review_loops_dir" "$$") ))"; }

review_loop_marker="$review_loops_dir/$$"
# Register the marker-cleanup EXIT trap NOW (it also carries the snapshot file this replaces the
# early trap for). The richer EXIT trap set later ALSO lists $review_loop_marker, so the marker is
# removed however/whenever we exit — verified below by the two traps both naming it.
trap 'rm -f "${review_loop_marker:-}" "${REVIEW_LOOP_SNAPSHOT_FILE:-}" 2>/dev/null || true' EXIT

if [ "$force" -eq 1 ]; then
  # Human override: skip the wait and register immediately.
  : > "$review_loop_marker" 2>/dev/null || true
else
  review_wait_timeout="${FOREMAN_REVIEW_LOOP_WAIT_TIMEOUT:-3600}"
  [[ "$review_wait_timeout" =~ ^[0-9]+$ ]] || review_wait_timeout=3600
  review_waited=0; review_announced=0
  while : ; do
    review_load="$(_current_load)"
    if [ "$((review_load + 2))" -le "$review_cap" ]; then
      if [ "$review_announced" -eq 1 ]; then
        echo "[review-loop] slot free (load $review_load/cap $review_cap) — proceeding" >&2
      fi
      break
    fi
    if [ "$review_waited" -ge "$review_wait_timeout" ]; then
      echo "[review-loop] budget still full (load $review_load/cap $review_cap) after ${review_wait_timeout}s — giving up" >&2
      exit 4
    fi
    if [ "$review_announced" -eq 0 ]; then
      echo "[review-loop] budget full (load $review_load/cap $review_cap) — waiting for a slot…" >&2
      review_announced=1
    fi
    sleep 15
    review_waited=$((review_waited + 15))
  done
  : > "$review_loop_marker" 2>/dev/null || true
fi

# --- base / target resolution -----------------------------------------------------------------
# Rationale for the scope rule: see the SCOPE block in the header comment.
# Resolution order: --base (verbatim) > --target REF > --target auto (derived) > historical default.

# Echo the first of the given refs/-relative candidates that names a commit; 1 if none does.
_first_ref() {
  local c
  for c in "$@"; do
    if git -C "$dir" rev-parse --verify --quiet "refs/$c^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "refs/$c"; return 0
    fi
  done
  return 1
}

# Resolve a branch NAME to a ref we can merge-base against. Echoes the ref; returns 1 if no form
# exists. Candidates are matched as full refs/remotes|refs/heads paths, NOT as a bare `NAME^{commit}`
# — the bare form also resolves TAGS, so a tag named like the target branch could win over it.
resolve_branch_ref() {
  local b="$1" r
  # HEAD is not a branch, and the refs/ prefixing alone does NOT reject it: `git clone` creates
  # refs/remotes/origin/HEAD, so `--target HEAD` would quietly resolve to origin's default branch
  # instead of erroring — and any candidate ending in /HEAD is that same pseudo-ref. Reject up front.
  case "$b" in HEAD|*/HEAD) return 1;; esac
  # Precedence: origin/<b> > <other-remote>/<b> > local <b> > <b> already remote-qualified. Every
  # remote-tracking copy outranks the local branch, because a stale local branch merge-bases BELOW
  # the real target — re-introducing the over-scoping this resolution exists to prevent. Other
  # remotes are only reached when origin does not carry the branch, so on a fork that mirrors it the
  # fork's own copy wins — pass `--target upstream/<b>` when the canonical remote must be used. The
  # already-qualified form is tried LAST so `--target origin/main` still works.
  # origin/<b> is probed on its OWN first, so the overwhelmingly common case never forks `git remote`
  # just to enumerate the others.
  _first_ref "remotes/origin/$b" && return 0
  local cands=()
  while IFS= read -r r; do
    [ "$r" != "origin" ] && cands+=("remotes/$r/$b")
  done < <(git -C "$dir" remote 2>/dev/null || true)
  _first_ref "${cands[@]}" "heads/$b" "remotes/$b"
}

# Extract a top-level "key": <scalar> field from JSON on stdin (both forges answer with a
# one-element ARRAY, so unwrap that first). jq only — it reads the field STRUCTURALLY, where any
# grep/sed approximation takes the first TEXTUAL match anywhere in the payload and so lets a nested
# occurrence of the same key win over the real one. No jq ⇒ empty output ⇒ the caller reads that as
# "no MR context" and falls back to the historical base, the documented graceful path anyway.
_json_str_field() {
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg k "$1" 'if type == "array" then .[0] else . end | .[$k]? // empty' 2>/dev/null
}

# Best-effort MR/PR context for the checked-out branch, via glab or gh. Two consumers need it now —
# the diff-scope derivation (--target auto) and the review phase (`/review <PR>`) — so it sets
# GLOBALS and memoizes, rather than echoing: the caller needs TWO values, and `$(...)` would both
# lose the second one and pay the forge round-trip twice.
#   MR_TARGET_BRANCH — the branch this work merges INTO; "" when there is no MR context (detached
#                      HEAD, no CLI, no open MR/PR, auth/network failure, junk output).
#   MR_PR_NUMBER     — the GitHub PR number, set ONLY on the gh path; "" otherwise. GitLab MRs
#                      deliberately do not set it: `/review` drives `gh pr view` / `gh pr diff` and
#                      cannot read an MR, so the GitLab path must take the diff-scoped fallback.
# Every invocation is stdin-closed and hang-guarded via _tmo, and at most two CLIs are asked — the
# second only if the first outright failed.
MR_CTX_DONE=0; MR_TARGET_BRANCH=""; MR_PR_NUMBER=""
detect_mr_context() {
  [ "$MR_CTX_DONE" -eq 1 ] && return 0
  MR_CTX_DONE=1
  local branch remote_url host out=""
  branch="$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || return 0                      # detached HEAD ⇒ no MR to look up
  # The branch goes into a CLI argument and (for glab) a URL query, so hold it to the same charset
  # we accept back. An exotic branch name just means "no MR context" — fall back, don't improvise.
  [[ "$branch" =~ $branch_re ]] || return 0
  remote_url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"

  # Pick the forge CLI from origin's HOST, not from a substring of the whole URL (which misroutes
  # github.com/acme/gitlab-migration). When the host identifies the forge, probe ONLY that CLI: the
  # other one cannot answer for this repo anyway, and on a repo with both a github and a gitlab
  # remote it can answer for the WRONG forge. An unrecognized (self-hosted) host lists both — glab
  # first, since self-hosted GitLab is the case that reaches here — but the second is only reached
  # when the first CLI outright FAILED (see the loop below), not merely when it found no MR.
  # Strip scheme, then the PATH, then userinfo, then the port — in that order. Dropping the path
  # first is what lets the userinfo strip be GREEDY (##*@), which it must be, or a `user@host@real`
  # URL yields the userinfo's host and routes to the wrong CLI.
  host="${remote_url#*://}"; host="${host%%/*}"; host="${host##*@}"; host="${host%%:*}"
  local order=(glab gh) tool
  case "$host" in
    *gitlab*) order=(glab);;
    *github*) order=(gh);;
  esac

  local raw field num=""
  for tool in "${order[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || continue
    # Capture the RAW response separately from the parse so a CLI that FAILED (missing auth, network
    # error, `timeout` kill) is distinguishable from one that answered fine with no open MR. Only the
    # former should try the next tool: on an unrecognized self-hosted host `order` is (glab gh), and
    # treating "answered, no MR" as a failure made every such run pay a SECOND 10s round-trip to a CLI
    # that cannot speak for this repo anyway.
    case "$tool" in
      # `pr list --state open`, not `pr view <branch>`: pr view also resolves a CLOSED or MERGED PR
      # for the branch, whose base could be a long-dead release branch — a wrong, over-narrow scope
      # is worse than falling back. --limit 1 keeps the response to the one MR/PR we act on.
      gh)   field="baseRefName"
            raw="$(cd "$dir" && _tmo 10 gh pr list --head "$branch" --state open --limit 1 \
                     --json baseRefName,number </dev/null 2>/dev/null)" || continue;;
      # `glab api`, not `glab mr view -F json`: `-F json` only exists on recent glab (on 1.36 it is
      # "unknown shorthand flag: 'F'"), so the mr-view form fails closed on every older install and
      # the GitLab path never derives anything. The REST endpoint is stable across versions and
      # filters to opened MRs the same way the gh call does.
      glab) field="target_branch"
            raw="$(cd "$dir" && _tmo 10 glab api \
                     "projects/:fullpath/merge_requests?source_branch=$branch&state=opened&per_page=1" \
                     </dev/null 2>/dev/null)" || continue;;
    esac
    # here-string, not `printf … | …`: $raw is already in memory, and the pipe costs an extra fork.
    out="$(_json_str_field "$field" <<<"$raw" || true)"
    # Only accept a plausible branch name — never feed CLI error prose or an option-looking string
    # into git. This CLI has spoken for the repo, so an unusable answer means "no MR context" for
    # real: fall back rather than asking the other forge's CLI about a repo that isn't its.
    [[ "$out" =~ $branch_re ]] || return 0
    MR_TARGET_BRANCH="$out"
    # The PR number is interpolated into a `/review <N>` slash command, so accept digits ONLY —
    # anything else (empty field, jq absent, error prose) leaves it unset and takes the fallback.
    if [ "$tool" = "gh" ]; then
      num="$(_json_str_field number <<<"$raw" || true)"
      [[ "$num" =~ ^[0-9]+$ ]] && MR_PR_NUMBER="$num"
    fi
    return 0
  done
  return 0
}

# A resolved ref in its short display form (origin/main, main) — the full refs/ path exists only to
# keep resolution unambiguous, and reads as noise in a log line.
_short_ref() { local r="${1#refs/remotes/}"; printf '%s' "${r#refs/heads/}"; }

# One place for "the target was unusable": a DERIVED target (--target auto) is best-effort, so it
# warns and lets the historical default take over; an explicit --target must fail LOUDLY instead,
# because the fallback chain can end at `rev-parse HEAD` (see the empty-range guard below).
_target_giveup() {
  [ "$target" != "auto" ] && die_usage "$1 (--target '$target'); pass --base REF explicitly"
  echo "$prog: $1 — falling back to the default base" >&2
}

if [ -z "$base" ] && [ "$target" != "none" ]; then
  # $target_src names the SOURCE for the log line: an explicit --target REF consulted no MR/PR at
  # all, so calling it "the MR/PR target branch" would misdirect anyone debugging a wrong scope.
  if [ "$target" = "auto" ]; then
    detect_mr_context
    target_branch="$MR_TARGET_BRANCH";              target_src="the MR/PR target branch"
  else
    target_branch="$target";                         target_src="the --target branch"
  fi
  # An empty $target_branch means --target auto found no MR context (detect_mr_context already
  # already knows every reason) — nothing to resolve, so the historical default below takes over.
  if [ -n "$target_branch" ]; then
    if ! target_ref="$(resolve_branch_ref "$target_branch")"; then
      _target_giveup "target branch '$target_branch' does not resolve locally — tried <remote>/$target_branch for every remote, local $target_branch, and $target_branch as a remote-qualified ref (try 'git fetch'; note that HEAD and */HEAD are refused outright — they are not branches)"
    elif base="$(git -C "$dir" merge-base HEAD "$target_ref" 2>/dev/null || true)"; [ -n "$base" ]; then
      echo "$prog: scoping the review to $target_src $(_short_ref "$target_ref")"
    else
      _target_giveup "no merge-base between HEAD and $(_short_ref "$target_ref") — unrelated histories"
    fi
  fi
fi

# Historical default: merge-base with origin/main, else origin/HEAD, else HEAD (⇒ empty diff,
# security auto=off). Reached whenever no target was given/derived/usable, so behaviour without MR
# context is exactly what it was before --target existed.
# Did the caller pin the base (--base REF, or a --target that resolved), or are we falling back?
# Decided HERE, while an empty $base still tells the two apart — the warning below needs to know.
base_pinned=1; [ -n "$base" ] || base_pinned=0
if [ -z "$base" ]; then
  base="$(git -C "$dir" merge-base HEAD origin/main 2>/dev/null \
        || git -C "$dir" merge-base HEAD origin/HEAD 2>/dev/null \
        || git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$base" ] || die "could not resolve a base ref (pass --base REF)"
# ...and it must NAME a commit. --base is used VERBATIM, so a typo or a deleted branch survives to
# here and would flow into every reviewer as `git diff <junk>...HEAD` — a command all four of them
# fail to run, while the security-auto heuristic's `git diff --name-only <junk> HEAD` comes back
# empty and skips the phase: the whole run then reports CLEAN having read zero lines. Resolve ONCE,
# loudly, and reuse the sha below.
base_resolved="$(git -C "$dir" rev-parse --verify --quiet "${base}^{commit}" 2>/dev/null || true)"
[ -n "$base_resolved" ] || die "base ref '$base' does not resolve to a commit (pass an existing --base REF)"
# From here on $base IS that commit — ONE name for the base, so no later call site has to pick between
# a raw ref and its sha. It is immutable from here on, so resolve the short display form ONCE too (the
# header + both prompt builders would otherwise fork `git rev-parse --short` on every call).
base="$base_resolved"
base_short="$(git -C "$dir" rev-parse --short "$base" 2>/dev/null || echo "$base")"

# ONE decision — "what does this run review?" — as a single range, so the scope cannot drift between
# the four reviewers. $range is EMPTY exactly when base IS HEAD, where `$base...HEAD` would be an
# empty range and a reviewer handed it reviews NOTHING. Compared on the RESOLVED sha, not on the ref
# the caller typed (`--base HEAD`) — the very case this guard exists to catch.
range=""
[ "$base" = "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" ] || range="$base_short...HEAD"

# The two forms the reviewer families need:
#   $scope_diff_ref — what the security/codex driver prompts spell out as `git diff <ref>`. Free-form
#                     prose with no self-derive fallback, so it must always name something real; with
#                     no range that is HEAD, i.e. the working tree.
#   the Claude slash-command <target> (below) — a BARE ref range and nothing else: that is the form
#                     they build the diff command from directly, where added prose would become a
#                     free-form instruction instead. OMITTED when there is no range, letting them
#                     self-derive (`git diff @{upstream}...HEAD`, else `main...HEAD`) exactly as
#                     before --target existed. Both fold in `git diff HEAD`, so uncommitted work is
#                     covered either way.
scope_diff_ref="${range:-HEAD}"

# Warn only when someone PINNED an empty range (--base REF, or a --target that resolved to HEAD) —
# there it is nearly always a mistake. On the fallback path it is the ordinary "no commits ahead yet"
# state, so warning every such run would be noise. Worded per family: the Claude commands self-derive,
# which can land WIDER than the base that was pinned, so "only uncommitted changes will be reviewed"
# would be false for half the reviewers.
if [ -z "$range" ] && [ "$base_pinned" -eq 1 ]; then
  echo "$prog: WARNING — the resolved base IS HEAD, so '$base_short...HEAD' is an EMPTY range; the security/codex phases and the diff-scoped review fallback see UNCOMMITTED changes only, /simplify falls back to self-deriving its own range, and '/review <PR>' reviews the whole PR regardless" >&2
fi

# Codex has no `/simplify` equivalent. This prompt mirrors the bundled command's cleanup-only
# review: reuse, simplification, efficiency, implementation altitude and explicit repository
# conventions, while preserving behavior exactly. (The installed Claude Code prompt was inspected
# when this mapping was added; see notes/tasks/review-loop-codex.md for the evidence.)
build_codex_simplify_prompt() {
  cat <<EOF
You are running an automated CODE SIMPLIFICATION pass over the pending changes on this git branch.
This is a TASTE/CLEANUP pass, not a bug hunt. APPLY only safe refinements that preserve exact
functionality, outputs and externally observable behavior.

SCOPE: inspect ONLY the code this branch changed — the diff \`git diff $scope_diff_ref\` plus any
uncommitted changes — and the smallest amount of surrounding code needed to understand it. Do not
clean up pre-existing code the branch did not touch.

Use the same cleanup angles as Claude Code's /simplify command:
  - reuse: replace new reimplementations with an existing helper already used by this codebase.
  - simplification: remove redundant/derivable state, needless duplication or variation, deep
    nesting, and dead code; choose the clearest behavior-equivalent form, not merely fewer lines.
  - efficiency: remove redundant computation or repeated I/O, and run genuinely independent work
    concurrently when that is already safe under the surrounding code's contracts.
  - altitude: fix the mechanism at the right shared layer instead of adding a fragile special case.
  - conventions: follow the explicit repository instruction files that govern the changed files.

Do not change intended behavior, fix speculative correctness issues, add dependencies, broaden the
diff, reformat unrelated code, or remove useful abstractions. If a simplification is debatable or
risky, leave it alone. Edit files directly for confident improvements. Do NOT run \`git commit\` or
\`git add\` — the caller commits. If nothing is clearly worth simplifying, make no edits.
EOF
}

si_cmd="/simplify${range:+ $range}"
si_display="$si_cmd"
if [ "$review_engine" = "codex" ]; then
  si_cmd="$(build_codex_simplify_prompt)"
  si_display="codex simplify prompt over $scope_diff_ref"
fi

# --- what the review phase reviews --------------------------------------------------------
# The report pass used to be `/code-review <effort> --fix`, which fans out a multi-agent review of
# the working diff on EVERY round — six of those per loop ate a whole session's quota. It is
# replaced by the built-in `/review <PR>`, a single-agent review that reads the PR's own diff via
# `gh pr view` / `gh pr diff` and REPORTS (it has no --fix).
#
# `/review` needs a PR NUMBER: called bare its prompt is "run `gh pr list` … then ask the user which
# one to review", which never resolves under headless `claude -p`. It is also GitHub-only. So we use
# it only when detect_mr_context found an open PR via gh, and otherwise fall back to a diff-scoped
# review prompt in the same shape as the security/codex drivers — NOT back to /code-review.
#
# The extra words after the PR number land in `/review`'s "Additional instructions from the user"
# slot. They must stay on ONE line: the command splits its argument on whitespace and rejoins with
# single spaces, so a multi-line instruction would be flattened anyway.
review_report_contract="Do NOT edit any files — this pass only REPORTS. After the review, emit machine-readable lines LAST, one per finding, each on its own line, in exactly this format: REVIEWFINDING: <severity> | <file:line-or-area> | <one line: the issue and the fix you recommend>. Report only real defects in the changed code — no style preferences, no speculative refactors, nothing about code the branch did not touch. If you found nothing worth fixing, emit exactly this single line instead: REVIEWFINDING: NONE"

# The diff-scoped fallback: the same review, self-driven, for a branch with no open GitHub PR.
build_review_prompt() {
  cat <<EOF
You are performing a CODE REVIEW of the changes on this git branch. This pass only REPORTS — do NOT
edit any files.

SCOPE: review ONLY the code this branch changed — the diff \`git diff $scope_diff_ref\` plus any
uncommitted changes. Do not audit or "improve" pre-existing code you did not touch.

Look for, in this order of importance:
  - correctness bugs: logic errors, wrong conditionals, off-by-one, unhandled error/edge cases,
    resource leaks, races, broken control flow, quoting/escaping bugs.
  - contract violations: a change that breaks an existing caller, test, or documented behaviour.
  - missing or wrong test coverage for the behaviour this branch adds.
  - clear violations of the conventions the surrounding code already follows.

Do NOT report style preferences, speculative refactors, or issues in code the branch did not touch.

OUTPUT — emit these machine-readable lines LAST, one per finding, each on its own line:
  REVIEWFINDING: <severity> | <file:line-or-area> | <one line: the issue and the fix you recommend>
If you found nothing worth fixing, emit exactly this single line instead:
  REVIEWFINDING: NONE
EOF
}

detect_mr_context   # memoized: free if --target auto already ran it above
if [ -n "$MR_PR_NUMBER" ]; then
  cr_cmd="/review $MR_PR_NUMBER $review_report_contract"
  cr_display="/review $MR_PR_NUMBER"
else
  cr_cmd="$(build_review_prompt)"
  cr_display="diff-scoped review of ${scope_diff_ref} (no open GitHub PR for this branch)"
fi

# Codex's report pass uses `codex exec` with this scoped prompt. Native `codex review` cannot accept
# both `--base` and a custom prompt on CLI 0.144.6, so it cannot simultaneously preserve this loop's
# resolved scope and REVIEWFINDING contract. Keep the Claude command above untouched: with the env
# var unset it is still byte-for-byte the same slash command / fallback prompt as before.
codex_review_prompt=""
if [ "$review_engine" = "codex" ]; then
  codex_review_prompt="$(build_review_prompt)"
  cr_display="codex exec review prompt over $scope_diff_ref"
fi

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

# Lines that mean codex NEVER GOT TO REVIEW — its sandbox failed to start — as opposed to codex
# reviewing and reporting something. Deliberately NARROW, because this loop reviews THIS FILE: the
# first alternative is anchored to line start (bubblewrap writes its errors there, while a reviewer
# quoting the comment below emits them behind a '#', a '+' or an indent), and the second is a full
# sentence codex itself prints only when it is about to use bubblewrap. Both were verified against
# real captures of a failing and a working run.
CODEX_SANDBOX_RE="^bwrap:|Codex.s Linux sandbox uses bubblewrap"
# Two flags, deliberately: an OBSERVATION and a DECISION.
#   HIT       — run_codex saw one of those lines. On its own this is only a hint: a healthy codex
#               reviewing THIS file could quote them.
#   CONFIRMED — run_fix_phase combined the hit with "and the round changed no files" (the report
#               pass uses its mandatory missing REVIEWFINDING marker), i.e. Codex demonstrably
#               did NOT work. Only then does run_codex stop spending calls. Keeping the decision out
#               of run_codex is what stops one suspicious line from poisoning later Codex rounds.
CODEX_SANDBOX_HIT=0
CODEX_SANDBOX_CONFIRMED=0
CODEX_SCAN=""          # run_codex's private scan copy; listed in the EXIT trap so it cannot leak

# Codex counterpart of run_claude: run one `codex exec` pass in DIR with the given full prompt,
# stream its output indented, and return codex's exit code. Same RUN_CLAUDE_CAPTURE contract so
# callers can post-parse findings. `</dev/null` is MANDATORY — without it codex blocks forever on
# "Reading additional input from stdin...". -m pins the model. run_fix_phase (not codex) does the
# git commit, so editing prompts tell codex not to.
#
# SANDBOX — `-s danger-full-access`, deliberately, and NOT the tighter `-s workspace-write`.
#   WHY: codex's Linux sandbox is bubblewrap, and bubblewrap cannot start in the container this
#   harness runs in. Reproduced on this box 2026-07-28:
#     -s workspace-write                        -> 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'
#     -s workspace-write, network_access=true   -> 'bwrap: setting up uid map: Permission denied'
#     bwrap --dev-bind / / --unshare-net true   -> the same RTM_NEWADDR failure
#     unshare --user --net true                 -> succeeds (so it is bwrap's netns setup
#                                                  specifically: no CAP_NET_ADMIN in the namespace)
#     -s danger-full-access                     -> works; codex ran git and returned the real diff
#   Under workspace-write EVERY codex round failed before running a single repository command, so
#   three consecutive review-loops got a second opinion of NOTHING while surfacing codex's "I could
#   not inspect the diff" prose as a RISKY finding that read like a review result.
#   TRADE-OFF, stated plainly: this removes codex's OWN sandboxing. That is acceptable HERE and only
#   here because this same script already runs every Claude reviewer as
#   `claude -p --dangerously-skip-permissions` over the same working tree — codex ends up with the
#   access its co-reviewers already have, so it is the same trust model, not a new exposure. Do NOT
#   copy this flag into a context where codex reviews UNTRUSTED code.
#   IF THE BOX CHANGES (new kernel, different container, CAP_NET_ADMIN granted), re-test with
#     codex exec --skip-git-repo-check -s workspace-write -m gpt-5.6-sol "run 'git log --oneline -1'"
#   and put workspace-write back the moment bubblewrap starts.
# shellcheck disable=SC2329  # invoked indirectly via run_fix_phase's $runner ("run_codex")
run_codex() {
  local prompt="$1" rc=0 scan=""
  # Once the phase has CONFIRMED the sandbox cannot start there is no reason to pay for another codex
  # call: every round would fail identically. Refuse fast, non-zero, with no output. (A mere HIT is
  # not enough — see the two-flag note above.)
  if [ "$CODEX_SANDBOX_CONFIRMED" -eq 1 ]; then
    echo "    | codex: not invoked — the sandbox failure is confirmed for this run (see above)"
    return 1
  fi
  # Private scan copy of the round's output. The sandbox errors are interleaved into the same stream
  # we indent for the transcript, and the pipeline runs in a SUBSHELL — a flag set inside it would be
  # lost — so tee the raw bytes out and grep them here, in the function body, where the assignment
  # sticks. If mktemp fails we simply cannot detect the failure; the review still runs (`cat`).
  scan="$(mktemp "${TMPDIR:-/tmp}/review-loop-codexscan.XXXXXX" 2>/dev/null)" || scan=""
  CODEX_SCAN="$scan"
  ( cd "$dir" && codex exec --skip-git-repo-check -s danger-full-access -m "$codex_model" "$prompt" </dev/null ) 2>&1 \
    | { if [ -n "$scan" ]; then tee -a "$scan"; else cat; fi; } \
    | _indent_tee
  rc="${PIPESTATUS[0]}"
  if [ -n "$scan" ]; then
    if grep -aqE "$CODEX_SANDBOX_RE" "$scan" 2>/dev/null; then
      CODEX_SANDBOX_HIT=1
      # Loud, and phrased as what it is: a missing second opinion, not a review result. codex exits
      # 0 in this state (the model completes, it is only its shell that never started), so the exit
      # code alone would never have told anyone.
      echo "    ** codex: SANDBOX/STARTUP FAILURE detected — codex could not run repository commands,"
      echo "    ** so it reviewed NOTHING this round. See the bubblewrap note above run_codex()."
    fi
    rm -f "$scan" 2>/dev/null || true
  fi
  CODEX_SCAN=""
  return "$rc"
}

# --- fix-phase runner (review, simplify, security) ---------------------------------------
# Runs a review→apply→recheck loop to convergence: each round invokes $slash (a slash command or a
# full prompt) via $runner, digests the working tree before/after, commits any changes, and stops
# when a round applies nothing (CLEAN) or the round cap is hit (NOT-CONVERGED). The security and codex
# phases reuse this unchanged, passing their review-and-fix driver prompt (and, for codex, the
# run_codex runner). $display overrides the (possibly long) prompt shown in the per-round header.
# $runner is the reviewer function to call (default run_claude; run_codex for the Codex phase) — it
# is passed EXPLICITLY rather than via a mutable global so a phase can never leak its runner into the
# next. $cap overrides the round cap (default --max-rounds) for a phase that is deliberately bounded
# tighter — the review apply pass passes 1, since there is nothing to converge towards there.
# Sets globals: PHASE_STATUS (CLEAN|NOT-CONVERGED|ERROR), PHASE_ROUNDS, PHASE_CHANGED (0|1).
run_fix_phase() {
  local label="$1" slash="$2" commit_prefix="$3" display="${4:-$2}" runner="${5:-run_claude}" cap="${6:-$max_rounds}"
  PHASE_STATUS="CLEAN"; PHASE_ROUNDS=0; PHASE_CHANGED=0
  local round before after rc
  for ((round = 1; round <= cap; round++)); do
    PHASE_ROUNDS="$round"
    before="$(_tree_digest)"
    echo ">>> $label: round $round/$cap — $runner \"$display\""
    rc=0
    "$runner" "$slash" || rc=$?
    after="$(_tree_digest)"

    # The second half of Codex's two-signal did-not-run check lives here so EVERY codex-driven
    # editing phase reuses it. Signal 1 is run_codex's narrow sandbox/startup HIT. Signal 2 is the
    # structural fact this round changed no files. A hit plus a real edit can only be quoted text;
    # clear it. A hit plus no edit confirms Codex executed nothing (it can still exit 0), so stop
    # later Codex calls and make this primary phase ERROR. The independent cross-check maps the same
    # confirmation to informational DID-NOT-RUN in run_crosscheck_phase below.
    if [ "$runner" = "run_codex" ] && [ "$CODEX_SANDBOX_HIT" -eq 1 ]; then
      if [ "$before" != "$after" ]; then
        echo "    codex: sandbox-error text seen, but the round edited files — codex DID run; treating it as quoted text" >&2
        CODEX_SANDBOX_HIT=0
      else
        CODEX_SANDBOX_CONFIRMED=1
        rc=1
        echo "    codex: DID NOT RUN (sandbox failure + no file changes)" >&2
      fi
    fi

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
      # re-review the same dirty tree. Surface it as a soft error (ERROR ⇒ the run reports FAILED).
      echo "    $label: round $round applied changes but the commit was REJECTED — tree left dirty (soft error)"
      PHASE_STATUS="ERROR"
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      echo "    $label: reviewer exited $rc after applying changes — ending phase (soft error)"
      PHASE_STATUS="ERROR"
      return 0
    fi

    if [ "$round" -eq "$cap" ]; then
      # A convergence signal, NOT a failure: the verdict rule treats it as informational (see the
      # VERDICT MODEL section). Worded so a transcript reader is not misled either.
      echo "    $label: still applying changes at round cap ($cap) — stopping here (informational, not a defect)"
      PHASE_STATUS="NOT-CONVERGED"
    fi
  done
  return 0
}

# Parse a captured review phase's output for its FINDING lines. Echoes the surfaced findings (every
# APPLIED/RISKY line, deduped across rounds, with the NONE sentinel dropped) to stdout, and RETURNS 0
# iff at least one RISKY (deliberately-unapplied) finding is present so the caller can escalate.
# Shared verbatim by the review, security and codex phases — only the token
# (REVIEWFINDING|SECFINDING|CODEXFINDING) differs.
# Call it in a conditional so its risky-return status is consumed rather than tripping `set -e`:
#   if FINDINGS="$(parse_findings SECFINDING "$cap")"; then RISKY=1; fi
parse_findings() {  # $1=token  $2=capture-file
  local token="$1" cap="$2" out
  # We extract from the token onward so leading markdown/indent doesn't matter — which also matches
  # the OUTPUT-contract lines inside the prompt itself whenever the reviewer echoes or quotes its
  # instructions back, turning an empty template into a phantom "finding" (and, for the security
  # contract, whose RISKY template reads `SECFINDING: RISKY | <severity> | …`, into a phantom
  # ESCALATION). Every contract writes the location as the literal placeholder `<file:line-or-area>`,
  # so dropping lines that still contain it removes the templates and nothing a reviewer would ever
  # emit for a real finding.
  out="$(grep -aoiE "$token:.*" "$cap" 2>/dev/null \
         | grep -viE "^$token:[[:space:]]*NONE[[:space:]]*$" \
         | grep -vF '<file:line-or-area>' | sort -u || true)"
  [ -n "$out" ] && printf '%s\n' "$out"
  # Last command → the function's return status: 0 if a RISKY finding exists, 1 otherwise. Judged on
  # the FILTERED list, never the raw capture, so a quoted-back template cannot force an escalation.
  grep -aiqE "^$token:[[:space:]]*RISKY([[:space:]]|\|)" <<<"$out"
}

# --- review phase (report → apply; deliberately NOT a convergence loop) -------------------
# Build the APPLY pass's prompt from the findings the REPORT pass produced.
build_review_apply_prompt() {  # $1 = the REVIEWFINDING lines from the report pass
  cat <<EOF
A code review of the changes on this git branch produced the findings below. Act on them. This is a
SINGLE pass — there is no second round, so do not defer work to one.

FINDINGS:
$1

For each finding:
  - If you agree it is REAL and its fix is minimal, localized, and does NOT change intended
    behaviour, APPLY the fix by editing the file(s) directly. Touch only what the finding requires.
  - If it is wrong, already fixed, or a matter of taste, DO NOT edit code — mark it DISMISSED with
    the reason. A dismissal is a judgement call you are making; be specific about why.
  - If it is real but its fix is uncertain, architectural, high-blast-radius, or could change
    behaviour / break functionality, DO NOT edit code — leave it UNAPPLIED and flag it RISKY. It is
    NOT dropped: a dedicated escalation pass with more room picks up every RISKY finding afterwards.
    When in doubt between APPLIED and RISKY, choose RISKY.

Do not add dependencies, do not refactor or reformat unrelated code, and do not fix anything that is
not in the list above. Do NOT run \`git commit\` or \`git add\` — the caller commits. Do not create
new files unless a fix strictly requires one.

OUTPUT — emit these machine-readable lines LAST, one per finding from the list above, each on its
own line:
  REVIEWFINDING: <APPLIED|RISKY|DISMISSED> | <file:line-or-area> | <one-line issue and action>
For RISKY findings end the final field with: -- NOT APPLIED: <why>
For DISMISSED findings end the final field with: -- DISMISSED: <why>
EOF
}

# Run ONE review phase: pass 1 REPORTS, pass 2 APPLIES what pass 1 found.
#
# WHY this is two fixed passes and not a loop. The old phase ran up to --max-rounds of
# `/code-review <effort> --fix` and stopped when a round applied nothing. `/review` does not fix, so
# that loop has no fixpoint to find here: pass 1 would report the same findings round after round
# forever. And the loop is exactly the cost we are removing — six multi-agent review rounds per
# review-loop, twice, drained a full session quota in one morning.
#
# So: report once, apply once. The apply pass runs through run_fix_phase (capped at 1) purely to
# reuse the digest/commit machinery every other phase uses. Anything the apply pass will not touch
# is surfaced as a RISKY finding for a human instead of being ground down by more rounds — the same
# posture the security and codex phases already take. The phases that genuinely DO auto-fix
# (simplify, codex, security) still converge; only this one is bounded.
#
# Sets globals: REVIEW_STATUS (CLEAN|RISKY|ERROR), REVIEW_PASSES, REVIEW_CHANGED (0|1),
# REVIEW_FINDINGS (surfaced lines, one per line).
run_review_phase() {
  local label="$1" commit_prefix="$2"
  local rc=0 report=""
  REVIEW_STATUS="CLEAN"; REVIEW_PASSES=0; REVIEW_CHANGED=0; REVIEW_FINDINGS=""

  CR_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-cr.XXXXXX" 2>/dev/null)" \
    || { REVIEW_STATUS="ERROR"; echo "    $label: could not create temp capture file"; return 0; }
  : > "$CR_CAP"

  echo ">>> $label: pass 1/2 REPORT — $cr_display"
  REVIEW_PASSES=1
  # Empty-output is a known transient flake: a dropped headless response, or a model that skipped the
  # output contract on ONE try, yields a capture with no REVIEWFINDING line. That was declared a hard
  # soft-error, failing the whole loop. Retry the single report pass ONCE before giving up; only a
  # SECOND empty result keeps today's fail-soft behaviour. A non-zero exit is not retried (it is a real
  # failure, not an empty flake).
  local report_try=0
  while : ; do
    rc=0
    : > "$CR_CAP"
    RUN_CLAUDE_CAPTURE="$CR_CAP"
    if [ "$review_engine" = "codex" ]; then
      run_codex "$codex_review_prompt" || rc=$?
    else
      run_claude "$cr_cmd" || rc=$?
    fi
    RUN_CLAUDE_CAPTURE=""
    if [ "$rc" -ne 0 ]; then
      echo "    $label: report pass exited $rc — ending phase (soft error)"
      REVIEW_STATUS="ERROR"; rm -f "$CR_CAP" 2>/dev/null || true; CR_CAP=""; return 0
    fi
    # No REVIEWFINDING line AT ALL (not even the NONE sentinel) means the pass never actually reviewed:
    # `/review` bailing out (gh missing, PR closed since we looked it up) prints prose and exits 0, and
    # so does a model that ignored the output contract. Treating that as "no findings" would report
    # CLEAN having read nothing — the exact silent pass this phase exists to prevent.
    if grep -aqiE 'REVIEWFINDING:' "$CR_CAP" 2>/dev/null; then
      # A valid mandatory marker is positive evidence that this read-only Codex report really ran.
      # If it also quoted the documented sandbox text, discard that lone HIT before a later
      # no-edit phase can accidentally combine it into a false did-not-run confirmation.
      if [ "$review_engine" = "codex" ] && [ "$CODEX_SANDBOX_HIT" -eq 1 ]; then
        echo "    codex: sandbox-error text seen, but the report emitted REVIEWFINDING — codex DID run; treating it as quoted text" >&2
        CODEX_SANDBOX_HIT=0
      fi
      break
    fi
    report_try=$((report_try + 1))
    if [ "$report_try" -ge 2 ]; then
      # For Codex review, the missing output-contract marker is the second signal that the
      # sandbox/startup HIT meant real did-not-run rather than quoted text. This report pass is
      # intentionally read-only, so a tree digest cannot provide the editing phases' second signal.
      if [ "$review_engine" = "codex" ] && [ "$CODEX_SANDBOX_HIT" -eq 1 ]; then
        CODEX_SANDBOX_CONFIRMED=1
      fi
      echo "    $label: report pass emitted no REVIEWFINDING line — nothing was reviewed (soft error)"
      REVIEW_STATUS="ERROR"; rm -f "$CR_CAP" 2>/dev/null || true; CR_CAP=""; return 0
    fi
    echo "    $label: report pass emitted no REVIEWFINDING line — retrying the report pass once (transient flake?)"
  done
  # Pass 1 emits no RISKY lines (that verdict only exists in pass 2's contract), so parse_findings'
  # risky-return is always 1 here — consume it rather than letting `set -e` trip on it.
  report="$(parse_findings REVIEWFINDING "$CR_CAP" || true)"
  rm -f "$CR_CAP" 2>/dev/null || true; CR_CAP=""

  if [ -z "$report" ]; then
    echo "    $label: review reported no findings — CLEAN"
    return 0
  fi
  REVIEW_FINDINGS="$report"
  echo "    $label: review reported $(printf '%s\n' "$report" | wc -l | tr -d ' ') finding(s)"

  CR_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-cr.XXXXXX" 2>/dev/null)" \
    || { REVIEW_STATUS="ERROR"; echo "    $label: could not create temp capture file"; return 0; }
  : > "$CR_CAP"
  echo ">>> $label: pass 2/2 APPLY — applying the fixes it is confident about"
  REVIEW_PASSES=2
  RUN_CLAUDE_CAPTURE="$CR_CAP"
  run_fix_phase "$label (apply)" "$(build_review_apply_prompt "$report")" "$commit_prefix" \
                "apply the confident fixes from the review report" "$phase_runner" 1
  RUN_CLAUDE_CAPTURE=""
  REVIEW_CHANGED="$PHASE_CHANGED"

  # Prefer pass 2's APPLIED/RISKY/DISMISSED verdicts over pass 1's bare findings — same issues, but
  # each now carries what was actually DONE about it. Keep pass 1's list if pass 2 emitted nothing.
  local applied risky=0
  if applied="$(parse_findings REVIEWFINDING "$CR_CAP")"; then risky=1; fi
  [ -n "$applied" ] && REVIEW_FINDINGS="$applied"
  rm -f "$CR_CAP" 2>/dev/null || true; CR_CAP=""

  # run_fix_phase reports NOT-CONVERGED whenever the last allowed round still applied changes — which
  # at cap=1 is the ORDINARY success path here (the apply pass is meant to change code exactly once).
  # Only a real ERROR carries over; escalation is driven by RISKY findings instead.
  [ "$PHASE_STATUS" = "ERROR" ] && REVIEW_STATUS="ERROR"
  if [ "$risky" -eq 1 ] && [ "$REVIEW_STATUS" = "CLEAN" ]; then
    REVIEW_STATUS="RISKY"
  fi
  return 0
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

SCOPE: review ONLY the code this branch changed — the diff \`git diff $scope_diff_ref\` plus any
uncommitted changes. Do the same analysis Claude Code's /security-review does: find REAL,
exploitable security vulnerabilities that these changes introduce. Do not audit or
"improve" pre-existing code you did not touch. Concentrate on:
  - authentication / authorization
  - input validation & injection (SQL, command, path traversal, XSS, SSRF, deserialization)
  - secrets / credential handling (leaks, weak storage, logging of secrets)
  - network / transport security (TLS, unsafe requests)
EOF

# The installed Claude Code /security-review prompt applies this high-signal filter. The existing
# Claude driver predates this switch and must stay byte-identical; spell the filter out only in the
# new Codex mapping so its prompt preserves the command's intent without changing the default path.
if [ "$review_engine" = "codex" ]; then
  cat <<'EOF'

Apply /security-review's false-positive filter: report only HIGH- or MEDIUM-severity issues where
you are over 80% confident there is a concrete exploit path and meaningful security impact. Exclude
denial of service/resource exhaustion/rate limiting, dependency-version findings, theoretical
hardening, test- or documentation-only code, resource leaks, and inputs controlled only through
trusted environment variables or CLI flags. Prefer missing a theoretical issue over creating noise.
EOF
fi

cat <<EOF

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

  # Drive the auto-fixing loop through the SAME run_fix_phase machinery as review/simplify:
  # apply confident fixes, digest before/after, commit + recheck until a round changes nothing
  # (CLEAN) or the cap is hit (NOT-CONVERGED). Capture each round's raw output so we can (a) surface
  # every finding and (b) detect a RISKY finding the model deliberately left unapplied.
  SEC_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-sec.XXXXXX" 2>/dev/null)" \
    || { SEC_STATUS="ERROR"; SEC_REASON="could not create temp capture file"; return 0; }
  : > "$SEC_CAP"
  RUN_CLAUDE_CAPTURE="$SEC_CAP"
  run_fix_phase "security-review" "$(build_security_prompt)" "chore(security): auto-fix" \
                "/security-review + apply confident in-scope fixes" "$phase_runner"
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
    SEC_STATUS="RISKY"; SEC_REASON="finding(s) too risky to auto-fix — handed to the escalation pass"
  fi
  return 0
}

# --- opposite-engine cross-check (independent second reviewer, auto-fixing) -------------------
# Build the driver prompt for ONE cross-check review→fix round. The opposite engine reviews the diff for
# correctness bugs + clear simplifications and APPLIES the fixes it is confident about, leaving
# risky/uncertain ones UNAPPLIED — exactly mirroring the security phase's "act on the confident,
# escalate the risky" posture, but for general correctness rather than security. The working-tree
# digest (not this prose) drives convergence. CODEXFINDING is a historical, stable parser token —
# keep it even when Claude is the cross-checker. The lines are parsed only to SURFACE findings and
# detect a RISKY (deliberately-unapplied) finding for escalation.
build_codex_prompt() {
  local reviewer="OpenAI Codex" peer="Claude"
  if [ "$crosscheck_engine" = "claude" ]; then reviewer="Claude"; peer="OpenAI Codex"; fi
  cat <<EOF
You are $reviewer acting as an INDEPENDENT second code reviewer on this git branch, working
ALONGSIDE $peer (which reviews the same diff). Your value is catching what the other model missed.
Review the code THIS branch changed for correctness BUGS and clear, low-risk SIMPLIFICATIONS, and
APPLY the fixes you are confident about (you can edit files directly).

SCOPE: review ONLY the changes on this branch — the diff \`git diff $scope_diff_ref\` plus any
uncommitted changes. Do NOT review or "improve" pre-existing code you did not touch. Do NOT modify
files outside this diff, and never touch logs, state/, notes/, generated
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
    as RISKY. A dedicated escalation pass picks those up later. When in doubt, do NOT apply.

Do NOT run \`git commit\` or \`git add\` — the caller commits. Do not create new files unless a fix
strictly requires one.

OUTPUT — emit these machine-readable lines LAST, one per finding, each on its own line:
  CODEXFINDING: <APPLIED|RISKY> | <bug|simplify> | <file:line-or-area> | <one-line issue and action>
For RISKY findings, end the final field with: -- NOT APPLIED: <why>
If you found NOTHING worth changing in the changed code, emit exactly this single line instead:
  CODEXFINDING: NONE
EOF
}

# Preflight: is the opposite-engine cross-checker usable here? Sets CODEX_REASON (the CODEX_ prefix
# is retained because compute_verdict's extracted interface already consumes these globals). Returns
# 0 if usable, 1 if it should be skipped
# (with CODEX_REASON explaining why — distinguishing DISABLED from the two UNAVAILABLE cases so the
# summary is honest about which happened). The `codex login status` probe makes no model call, and is
# timed + stdin-closed so it can never hang or bill.
crosscheck_usable() {
  if [ "$codex" != "on" ]; then CODEX_REASON="--no-codex (disabled)"; return 1; fi
  case "$crosscheck_engine" in
    codex)
      if ! command -v codex >/dev/null 2>&1; then
        CODEX_REASON="codex not found on PATH — degrading to Claude-only"; return 1
      fi
      # `codex login status` is a fast LOCAL check (no model call); guard it against wedging.
      if ! _tmo 20 codex login status </dev/null >/dev/null 2>&1; then
        CODEX_REASON="codex not logged in ('codex login status' failed) — degrading to Claude-only"; return 1
      fi
      CODEX_REASON="codex on (model $codex_model)"; return 0
      ;;
    claude)
      if ! command -v claude >/dev/null 2>&1; then
        CODEX_REASON="claude not found on PATH — independent cross-check unavailable"; return 1
      fi
      CODEX_REASON="claude on (opposite-engine cross-check)"; return 0
      ;;
  esac
}

# Sets globals: CODEX_STATUS (SKIPPED|CLEAN|RISKY|NOT-CONVERGED|ERROR), CODEX_REASON, CODEX_ROUNDS,
# CODEX_CHANGED (0|1), CODEX_FINDINGS (surfaced lines), CODEX_ACTIVE (0|1 — did the phase actually
# run, i.e. the cross-checker was usable). CODEX_CAP is a capture file kept alive across this phase AND the later
# reconciliation (so a RISKY surfaced by a reconcile recheck also escalates); it is parsed + removed
# by finalize_codex_findings after reconciliation.
run_crosscheck_phase() {
  CODEX_STATUS="SKIPPED"; CODEX_REASON=""; CODEX_ROUNDS=0; CODEX_CHANGED=0
  CODEX_FINDINGS=""; CODEX_ACTIVE=0

  if ! crosscheck_usable; then
    echo ">>> $crosscheck_engine review phase: SKIPPED — $CODEX_REASON" >&2
    return 0
  fi
  CODEX_ACTIVE=1
  echo ">>> $crosscheck_engine review-and-fix loop: $CODEX_REASON"

  # Build the (static, scope-only) driver prompt ONCE here and reuse it for every codex round in
  # this phase AND every reconcile recheck, instead of re-forking the heredoc via $(...) each time.
  CODEX_PROMPT="$(build_codex_prompt)"
  CODEX_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-codex.XXXXXX" 2>/dev/null)" \
    || { CODEX_STATUS="ERROR"; CODEX_REASON="could not create temp capture file"; CODEX_ACTIVE=0; return 0; }
  : > "$CODEX_CAP"
  RUN_CLAUDE_CAPTURE="$CODEX_CAP"
  local check_label="$crosscheck_engine-review" check_commit="chore(review): $crosscheck_engine auto-fix"
  local check_display="$crosscheck_engine review + apply confident fixes"
  run_fix_phase "$check_label" "$CODEX_PROMPT" "$check_commit" \
                "$check_display" "$crosscheck_runner"
  RUN_CLAUDE_CAPTURE=""
  CODEX_ROUNDS="$PHASE_ROUNDS"; CODEX_CHANGED="$PHASE_CHANGED"

  # The sandbox never started (see run_codex): codex reviewed NOTHING. Report that as its own status
  # instead of laundering codex's "I could not inspect the diff" prose through parse_findings into a
  # RISKY finding — that is a fact about this machine, not about the code, and dressing it up as a
  # review result is what hid the breakage for three consecutive runs. So: drop the capture (nothing
  # in it is a review), and mark codex INACTIVE so the joint reconciliation below degrades to the
  # Claude-only path rather than alternating with a reviewer that cannot start.
  # run_fix_phase owns the one two-signal confirmation. A missing CROSS-CHECK is informational — it
  # must never become WHY — while a primary Codex phase that cannot run is a real gate ERROR.
  if [ "$crosscheck_engine" = "codex" ] && [ "$CODEX_SANDBOX_CONFIRMED" -eq 1 ]; then
    CODEX_STATUS="DID-NOT-RUN"
    CODEX_REASON="sandbox failed to start — codex could not run repository commands; NO second opinion this run"
    CODEX_ACTIVE=0
    CODEX_FINDINGS=""
    rm -f "$CODEX_CAP" 2>/dev/null || true; CODEX_CAP=""
    echo "    codex: DID NOT RUN (sandbox failure) — this run has NO independent second opinion" >&2
    return 0
  fi

  # Convergence verdict from this phase (the RISKY overlay is applied later, in
  # finalize_codex_findings, so a reconcile-round RISKY is included too).
  map_review_verdict "$crosscheck_engine" "$PHASE_STATUS" "$CODEX_CHANGED"
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
    CODEX_STATUS="RISKY"; CODEX_REASON="finding(s) too risky/uncertain to auto-fix — handed to the escalation pass"
  fi
}

# --- escalation phase (a RISKY finding is AI work, not a question for a human) -----------------
# WHY this exists. Every phase above is a CHEAP pass with an explicit instruction to leave anything
# uncertain / architectural / high-blast-radius UNAPPLIED and flag it RISKY. That instruction is
# right — a cheap pass should not make a large change on a hunch — but the run then STOPPED there and
# handed the problem to a human. That is foreman giving up on work an AI can still do: "the minimal
# edit was not obviously safe" is not the same as "no AI can fix this".
#
# So a RISKY finding is now routed to a fresh agent that is told the opposite thing: you are the
# escalation pass, these were sent to you precisely because they need more than a minimal edit, and
# "too risky to touch" is not an answer you may repeat. It must FIX the finding, REFUTE it with
# evidence, or name concretely what blocks a safe fix — and it must distinguish the one case an AI
# genuinely must not decide (a product choice, a migration of already-stored user data, an
# ownership/policy call) from the case where more AI work is simply needed.
#
# Three structural safeguards, because this is the pass with the most freedom:
#   * BOUNDED — at most --escalation-attempts (default 2, max 2) attempts, and an attempt that
#     changes nothing ends the phase immediately. It cannot loop.
#   * RE-REVIEWED — anything it changes goes back through the correctness phases (review, codex if
#     active, security if it was in scope) before it can ship, so an escalation fix cannot itself
#     ship unreviewed. A finding raised BY that re-review is what a 2nd attempt is for.
#   * NEVER SILENT — a pass that emits no verdict line for its findings counts as UNRESOLVED, not as
#     resolved. Laundering a RISKY finding into silence is the one failure this must not have.
LF=$'\n'
ESC_SEEN=""          # every risky line already handed to an attempt (so attempt 2 gets only NEW ones)
_esc_mark_seen() { ESC_SEEN="${ESC_SEEN:+$ESC_SEEN$LF}$1"; return 0; }
# Echo the lines of $1 that have NOT been escalated yet. The case pattern is QUOTED, so a finding
# containing glob characters is matched literally.
_esc_new() {
  local line out=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$LF$ESC_SEEN$LF" in *"$LF$line$LF"*) continue;; esac
    out="${out:+$out$LF}$line"
  done <<<"${1:-}"
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
}

# Every RISKY (deliberately-unapplied) finding this run has produced, from all three reviewer
# families, deduped. The codex list is read from its live capture file while finalize_codex_findings
# has not run yet — which is the case here, since escalation runs BEFORE it (so a codex recheck
# inside escalation still lands in the same capture).
_risky_finding_re='^(REVIEWFINDING|SECFINDING|CODEXFINDING):[[:space:]]*RISKY([[:space:]]|\|)'
collect_risky_findings() {
  local all
  all="$( { [ -n "${CR_FINDINGS:-}" ] && printf '%s\n' "$CR_FINDINGS"
            if [ -n "${CODEX_FINDINGS:-}" ]; then
              printf '%s\n' "$CODEX_FINDINGS"
            elif [ -n "${CODEX_CAP:-}" ] && [ -f "$CODEX_CAP" ]; then
              parse_findings CODEXFINDING "$CODEX_CAP" || true
            fi
            [ -n "${SEC_FINDINGS:-}" ] && printf '%s\n' "$SEC_FINDINGS"
            true; } | grep -aiE "$_risky_finding_re" | sort -u || true)"
  [ -n "$all" ] && printf '%s\n' "$all"
  return 0
}

build_escalation_prompt() {  # $1 = the RISKY finding lines to act on
  cat <<EOF
An automated review of this git branch produced the findings below. A deliberately CHEAP apply pass
already REFUSED to fix them: it judged each one uncertain, architectural, high-blast-radius or
behaviour-changing and left it UNAPPLIED as RISKY. Its reason is on each line, usually after
"NOT APPLIED:".

You are the ESCALATION pass. These were routed to you PRECISELY BECAUSE they need more than a
minimal, obviously-safe edit, so "too risky to touch" is not an answer you may repeat. Take the time
and the room the earlier pass did not have.

RISKY FINDINGS:
$1

SCOPE: the changes on this branch — the diff \`git diff $scope_diff_ref\` plus any uncommitted
changes. Do not audit or "improve" pre-existing code the branch did not touch.

For EACH finding, in order:
  1. Read the code it points at, plus its callers and tests. Decide whether the finding is REAL. If
     it is not (the earlier reviewer misread the code, or the case is already handled elsewhere),
     say so with the specific evidence — refuting a finding is a legitimate outcome, guessing is not.
  2. If it IS real, FIX IT PROPERLY. You have more room than the earlier pass: you may change more
     than one file, restructure a function, introduce a helper, and add or update tests — as long as
     the change stays within this branch's scope and you can justify every line of it. If the repo
     has a fast build / typecheck / test command, RUN IT and make sure your change passes.
  3. Only if a correct fix is genuinely out of reach, say why, naming what blocks it. There are
     exactly two kinds of "cannot", and telling them apart is the most important thing you do here:
       - DECISION — the fix needs a PRODUCT choice, a migration of data users have ALREADY STORED,
         or an ownership/policy call (whose data, whose SLA, which team owns this). Nobody can settle
         that from inside the code; a person has to choose. Example: "filing this value under the
         right heading means storing a new field next to the existing ones, i.e. migrating
         annotations users already saved."
       - UNRESOLVED — it is still a coding problem; you just could not land it safely here (could not
         reproduce it, it needs an interface you cannot see, the blast radius is bigger than this
         branch). Another, better-informed pass could still do it.
     Do NOT reach for DECISION because a fix is large, tedious or unpleasant. If a competent engineer
     could implement it without asking anyone's permission, it is NOT a DECISION. Claiming DECISION
     falsely stops the machine and interrupts a person, so justify it in the line you emit.

Do NOT run \`git commit\` or \`git add\` — the caller commits. Do not add dependencies, do not
reformat unrelated code, and do not act on anything that is not in the list above.

OUTPUT — emit these machine-readable lines LAST, one per finding above, each on its own line:
  ESCFINDING: FIXED | <file:line-or-area> | <what you changed and why it is correct>
  ESCFINDING: DISMISSED | <file:line-or-area> | <the specific evidence that the finding is not real>
  ESCFINDING: DECISION | <product|data-migration|ownership> | <file:line-or-area> | <the choice a person must make, and the options>
  ESCFINDING: UNRESOLVED | <file:line-or-area> | <what blocks a safe fix, and what would unblock it>
Emit a line for EVERY finding listed above. A finding you do not mention is counted as UNRESOLVED.
EOF
}

# Re-run the CORRECTNESS phases over whatever the escalation pass just changed, so an escalation fix
# cannot ship unreviewed. Phase statuses are folded MONOTONICALLY (a re-run may raise ERROR/RISKY but
# never lowers one): clearing a RISKY finding is the escalation verdict's job in compute_verdict, not
# a re-review's. /simplify is deliberately not re-run — it is a taste pass, not a correctness one.
escalation_recheck() {
  echo ">>> escalation re-check — re-running the correctness phases over the escalation fix"
  run_review_phase "review (post-escalation)" "chore(review): post-escalation review"
  case "$REVIEW_STATUS" in
    ERROR) CR_STATUS="ERROR";;
    RISKY) [ "$CR_STATUS" = "ERROR" ] || CR_STATUS="RISKY";;
  esac
  _note_cr_findings
  if [ "${CODEX_ACTIVE:-0}" -eq 1 ] && [ -n "${CODEX_CAP:-}" ]; then
    RUN_CLAUDE_CAPTURE="$CODEX_CAP"
    run_fix_phase "$crosscheck_engine-review (post-escalation)" "$CODEX_PROMPT" \
                  "chore(review): post-escalation $crosscheck_engine" \
                  "$crosscheck_engine recheck of the escalation fix" "$crosscheck_runner"
    RUN_CLAUDE_CAPTURE=""
    [ "$PHASE_STATUS" = "ERROR" ] && CODEX_STATUS="ERROR"
    [ "$PHASE_CHANGED" -eq 1 ] && CODEX_CHANGED=1
  fi
  if [ "${SEC_STATUS:-SKIPPED}" != "SKIPPED" ]; then
    local sec_prev_findings="$SEC_FINDINGS" sec_prev_status="$SEC_STATUS"
    run_security_phase
    # Merge, never replace: the re-run must not DROP a finding the first run surfaced (both the
    # summary and the verdict read this list), and must not downgrade the status.
    SEC_FINDINGS="$(printf '%s\n%s\n' "$sec_prev_findings" "$SEC_FINDINGS" \
                    | grep -v '^[[:space:]]*$' | sort -u || true)"
    case "$sec_prev_status" in
      ERROR) SEC_STATUS="ERROR";;
      RISKY) [ "$SEC_STATUS" = "ERROR" ] || SEC_STATUS="RISKY";;
    esac
  fi
  return 0
}

_esc_count() { printf '%s\n' "${ESC_FINDINGS:-}" | grep -aciE "^ESCFINDING:[[:space:]]*$1([[:space:]]|\|)" || true; }

# Sets globals: ESC_STATUS (SKIPPED|RESOLVED|DECISION|UNRESOLVED|MIXED|ERROR), ESC_REASON,
# ESC_ATTEMPTS, ESC_CHANGED (0|1), ESC_FINDINGS (the surfaced ESCFINDING lines).
run_escalation_phase() {
  ESC_STATUS="SKIPPED"; ESC_REASON=""; ESC_ATTEMPTS=0; ESC_CHANGED=0; ESC_FINDINGS=""; ESC_SEEN=""
  local risky new attempt lines changed n leftover bound="" decision=0 unresolved=0 err=0

  risky="$(collect_risky_findings)"
  if [ -z "$risky" ]; then
    ESC_REASON="no RISKY finding to escalate"
    echo ">>> escalation pass: not needed — $ESC_REASON"
    return 0
  fi
  if [ "$escalation_attempts" -eq 0 ]; then
    ESC_REASON="--escalation-attempts 0 (disabled) — RISKY finding(s) reported as-is"
    echo ">>> escalation pass: SKIPPED — $ESC_REASON"
    return 0
  fi

  for ((attempt = 1; attempt <= escalation_attempts; attempt++)); do
    # Recomputed each attempt: a re-check may have raised NEW risky findings, and only those are
    # handed to the next attempt — re-sending a finding an attempt already answered would just buy
    # the same answer again.
    new="$(_esc_new "$(collect_risky_findings)")"
    [ -n "$new" ] || break
    _esc_mark_seen "$new"
    ESC_ATTEMPTS="$attempt"
    n="$(printf '%s\n' "$new" | wc -l | tr -d ' ')"
    echo ">>> escalation: attempt $attempt/$escalation_attempts — $n RISKY finding(s) handed to a fresh, better-resourced pass"
    printf '%s\n' "$new" | sed 's/^/    > /'
    ESC_CAP="$(mktemp "${TMPDIR:-/tmp}/review-loop-esc.XXXXXX" 2>/dev/null)" \
      || { err=1; echo "    escalation: could not create temp capture file"; break; }
    : > "$ESC_CAP"
    RUN_CLAUDE_CAPTURE="$ESC_CAP"
    # cap 1: one agent pass per attempt. The attempt LOOP is the bound; run_fix_phase is reused only
    # for its digest/commit machinery, exactly as the review apply pass does.
    run_fix_phase "escalation" "$(build_escalation_prompt "$new")" "chore(review): escalation fix" \
                  "fix the RISKY findings, or justify concretely why they cannot be fixed" \
                  "${phase_runner:-run_claude}" 1
    RUN_CLAUDE_CAPTURE=""
    changed="$PHASE_CHANGED"
    [ "$PHASE_STATUS" = "ERROR" ] && err=1
    # Same template guard as parse_findings: the contract lines above all carry the literal
    # <file:line-or-area> placeholder, so a pass that echoes its instructions back cannot become a
    # phantom verdict.
    lines="$(grep -aoiE 'ESCFINDING:.*' "$ESC_CAP" 2>/dev/null | grep -vF '<file:line-or-area>' | sort -u || true)"
    rm -f "$ESC_CAP" 2>/dev/null || true; ESC_CAP=""
    if [ -n "$lines" ]; then
      ESC_FINDINGS="${ESC_FINDINGS:+$ESC_FINDINGS$LF}$lines"
      grep -aqiE '^ESCFINDING:[[:space:]]*DECISION([[:space:]]|\|)' <<<"$lines" && decision=1
      grep -aqiE '^ESCFINDING:[[:space:]]*UNRESOLVED([[:space:]]|\|)' <<<"$lines" && unresolved=1
      # The contract is one verdict line per finding handed over. Fewer lines than findings means at
      # least one finding was never answered for — which the prompt says counts as UNRESOLVED. Do not
      # let a partial answer read as a full one; that is the same laundering the empty case prevents.
      if [ "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" -lt "$n" ]; then
        echo "    escalation: attempt $attempt answered for fewer findings than it was given — counting the rest as UNRESOLVED"
        unresolved=1
      fi
    else
      echo "    escalation: attempt $attempt emitted no ESCFINDING line — counting its findings as UNRESOLVED"
      unresolved=1
    fi
    [ "$err" -eq 1 ] && break
    if [ "$changed" -eq 1 ]; then
      ESC_CHANGED=1
      escalation_recheck
    else
      # Nothing changed ⇒ there is no new code to re-review, and a second pass over the same findings
      # would only repeat this one. End the phase rather than pay for that.
      echo "    escalation: attempt $attempt changed no code — nothing to re-review, ending the phase"
      break
    fi
  done

  if [ "$err" -eq 1 ]; then
    ESC_STATUS="ERROR"; ESC_REASON="the escalation pass itself did not complete"
    echo "    escalation: ERROR — $ESC_REASON"
    return 0
  fi
  # Still-RISKY findings that no attempt ever got to = the attempt bound ran out. Those are UNRESOLVED
  # by definition: nothing has answered for them.
  leftover="$(_esc_new "$(collect_risky_findings)")"
  if [ -n "$leftover" ]; then
    unresolved=1; bound=" (attempt bound exhausted)"
    echo "    escalation: $(printf '%s\n' "$leftover" | wc -l | tr -d ' ') RISKY finding(s) never reached an attempt — the bound (--escalation-attempts $escalation_attempts) is exhausted"
  fi
  if [ "$unresolved" -eq 1 ] && [ "$decision" -eq 1 ]; then ESC_STATUS="MIXED"
  elif [ "$unresolved" -eq 1 ]; then ESC_STATUS="UNRESOLVED"
  elif [ "$decision" -eq 1 ]; then ESC_STATUS="DECISION"
  else ESC_STATUS="RESOLVED"
  fi
  ESC_REASON="$ESC_ATTEMPTS/$escalation_attempts attempt(s); fixed=$(_esc_count FIXED) dismissed=$(_esc_count DISMISSED) decision=$(_esc_count DECISION) unresolved=$(_esc_count UNRESOLVED)$bound"
  echo "    escalation: $ESC_STATUS — $ESC_REASON"
  return 0
}

# --- drive the phases -------------------------------------------------------------------------
echo "== $prog =="
codex_disp="$codex"; [ "$codex" = "on" ] && codex_disp="on ($codex_model)"
echo "dir=$dir  base=$base_short  max-rounds=$max_rounds  security=$security  codex=$codex_disp  escalation-attempts=$escalation_attempts"
[ "$review_engine" = "codex" ] && echo "review-engine=codex  independent-cross-check=claude  (opposite engines by design)"
echo "review: $cr_display"
echo

# Init all codex/reconcile globals up front so `set -u` is happy on every path (e.g. codex disabled).
CODEX_CAP=""; CODEX_PROMPT=""   # opposite-engine driver prompt, built once (see run_crosscheck_phase)
CODEX_STATUS="SKIPPED"; CODEX_REASON="--no-codex (disabled)"; CODEX_ROUNDS=0
CODEX_CHANGED=0; CODEX_FINDINGS=""; CODEX_ACTIVE=0

# Belt against a temp-file leak: the review/security/codex phases mktemp capture files that they
# rm on the normal path, but an unexpected error under `set -e` (or a Ctrl-C) between mktemp and that
# rm would otherwise strand them in TMPDIR. An EXIT trap removes them regardless of how we leave. All
# three vars are initialized before any phase can create a file, so `set -u` is satisfied when it fires.
SEC_CAP=""; CR_CAP=""; ESC_CAP=""
# The escalation phase's own result globals, likewise initialized before anything can read them
# (compute_verdict reads ESC_STATUS on every path, including runs where escalation never ran).
ESC_STATUS="SKIPPED"; ESC_REASON=""; ESC_ATTEMPTS=0; ESC_CHANGED=0; ESC_FINDINGS=""
# Also lists REVIEW_LOOP_SNAPSHOT_FILE (the self-snapshot, see the edit-while-running block near the
# top) and $review_loop_marker (our admission-budget marker, see the admission gate): this trap
# REPLACES both the early snapshot-cleanup trap and the gate's marker-cleanup trap, so it must carry
# BOTH — otherwise a marker/snapshot would leak past this point.
trap 'rm -f "$SEC_CAP" "$CODEX_CAP" "$CR_CAP" "$ESC_CAP" "${CODEX_SCAN:-}" "${REVIEW_LOOP_SNAPSHOT_FILE:-}" "${review_loop_marker:-}" 2>/dev/null || true' EXIT

# Accumulates the review findings across the initial phase AND any reconcile / post-security
# pass, so a finding raised late still reaches the summary.
CR_FINDINGS=""
_note_cr_findings() { [ -n "$REVIEW_FINDINGS" ] && CR_FINDINGS="${CR_FINDINGS:+$CR_FINDINGS$'\n'}$REVIEW_FINDINGS"; return 0; }

run_review_phase "review" "chore(review): review fixes"
CR_STATUS="$REVIEW_STATUS"; CR_PASSES="$REVIEW_PASSES"; CR_CHANGED="$REVIEW_CHANGED"
_note_cr_findings
echo

# --simplify-rounds (default 2), NOT --max-rounds: a taste pass has no fixpoint to converge on, so
# the extra rounds bought churn. See the cap's rationale where simplify_rounds is defined.
run_fix_phase "simplify" "$si_cmd" "chore(review): simplify" "$si_display" "$phase_runner" "$simplify_rounds"
SI_STATUS="$PHASE_STATUS"; SI_ROUNDS="$PHASE_ROUNDS"; SI_CHANGED="$PHASE_CHANGED"
echo

# Opposite-engine independent review (before security so security keeps the final word over the
# exact code that ships — including anything the cross-checker changed). It is deliberately the
# opposite of $review_engine; never collapse this back to the primary model.
run_crosscheck_phase
echo

run_security_phase
echo

# --- gated final convergence ------------------------------------------------------------------
# Runs ONLY if a phase AFTER the initial review phase applied changes — simplify, codex, or security
# — otherwise the tree is already blessed by a correctness pass and there is nothing to re-check.
# (simplify is included because it reworks code AFTER the review pass and only shrinks the
# surface; a correctness regression it introduces would otherwise ship un-reviewed whenever codex and
# security both change nothing, e.g. under --no-codex with a clean security run.)
#   * cross-check active  → bounded primary<->opposite-engine RECONCILIATION: alternate the selected
#                           review phase (report + apply) and the independent recheck; the tree is
#                           clean only when a full alternation applies nothing on BOTH.
#   * cross-check inactive→ one gated primary-engine review pass (catch a regression a later fix made).
# RECONCILE_STATUS is the umbrella convergence verdict for this phase (CLEAN|NOT-CONVERGED|RISKY|ERROR).
FCR_RAN=0; FCR_CHANGED=0; FCR_PASSES=0     # primary-engine side of the final phase
FCC_RAN=0; FCC_CHANGED=0                    # opposite-engine side of the reconciliation
RECON_CYCLES=0; RECONCILE_STATUS="CLEAN"
_recon_note() {  # fold a per-pass status into the umbrella verdict (ERROR > NOT-CONVERGED > RISKY)
  case "$1" in
    ERROR)         RECONCILE_STATUS="ERROR";;
    NOT-CONVERGED) [ "$RECONCILE_STATUS" = "ERROR" ] || RECONCILE_STATUS="NOT-CONVERGED";;
    RISKY)         [ "$RECONCILE_STATUS" = "CLEAN" ] && RECONCILE_STATUS="RISKY";;
  esac
  return 0   # never let this bookkeeping helper's exit status trip `set -e` at the call site
}

if [ "$SEC_CHANGED" -eq 1 ] || [ "$CODEX_CHANGED" -eq 1 ] || [ "$SI_CHANGED" -eq 1 ]; then
  if [ "$CODEX_ACTIVE" -eq 1 ]; then
    echo ">>> joint reconciliation — code changed after the $crosscheck_engine phase; converging $phase_engine_display+$crosscheck_engine_display"
    for ((cyc = 1; cyc <= max_rounds; cyc++)); do
      RECON_CYCLES="$cyc"
      echo ">>> reconcile cycle $cyc/$max_rounds"
      run_review_phase "review (reconcile)" "chore(review): reconcile review"
      FCR_RAN=1; [ "$REVIEW_CHANGED" -eq 1 ] && FCR_CHANGED=1
      c_changed="$REVIEW_CHANGED"; _recon_note "$REVIEW_STATUS"; _note_cr_findings

      RUN_CLAUDE_CAPTURE="$CODEX_CAP"
      run_fix_phase "$crosscheck_engine-review (reconcile)" "$CODEX_PROMPT" \
                    "chore(review): reconcile $crosscheck_engine" \
                    "$crosscheck_engine recheck" "$crosscheck_runner"
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
        echo "    reconcile: both $phase_engine_display and $crosscheck_engine_display applied nothing — joint fixpoint reached"
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
        echo "    reconcile: still changing at cycle cap ($max_rounds) — stopping here (informational, not a defect)"
        _recon_note "NOT-CONVERGED"   # fold via the shared helper (ERROR still dominates)
      fi
    done
  else
    if [ "$review_engine" = "claude" ]; then
      echo ">>> final review pass — code changed after the initial review (simplify/security/codex); re-checking for regressions"
    else
      echo ">>> final review pass — code changed after the initial review (simplify/security/claude cross-check); re-checking for regressions"
    fi
    run_review_phase "review (post-security)" "chore(review): post-security review"
    FCR_RAN=1; FCR_PASSES="$REVIEW_PASSES"; FCR_CHANGED="$REVIEW_CHANGED"; RECONCILE_STATUS="$REVIEW_STATUS"
    _note_cr_findings
  fi
else
  echo ">>> final convergence pass — skipped (nothing changed after the initial review)"
fi
echo

# Escalation runs LAST of the working phases, so it sees every RISKY finding the run produced —
# including any the reconciliation raised. It is deliberately BEFORE finalize_codex_findings: that
# call consumes (and deletes) the codex capture, and escalation both reads risky codex findings out
# of it and appends its own post-escalation codex recheck to it.
run_escalation_phase
echo
# Parse codex findings from the whole run (main phase + reconcile rechecks + any escalation recheck)
# and overlay a RISKY escalation onto CODEX_STATUS if codex left anything unapplied.
finalize_codex_findings
echo

# --- summary + verdict ------------------------------------------------------------------------
yn() { [ "$1" -eq 1 ] && echo yes || echo no; }
# Render a phase status for the summary. NOT-CONVERGED is spelled out as what it actually is — a
# round-cap stop, which the verdict rule treats as informational — so a summary line can no longer
# be misread as "this phase failed". Everything else prints verbatim.
status_disp() {
  case "$1" in
    NOT-CONVERGED) printf 'stopped at round cap (informational)';;
    *)             printf '%s' "$1";;
  esac
}
echo "== summary =="
printf '  review      : passes=%s changed=%s status=%s (%s)\n' "$CR_PASSES" "$(yn "$CR_CHANGED")" "$CR_STATUS" "$cr_display"
if [ -n "$CR_FINDINGS" ]; then
  echo "  review findings (surfaced — APPLIED/DISMISSED included; RISKY ones go to the escalation pass):"
  printf '%s\n' "$CR_FINDINGS" | sort -u | sed 's/^/    - /'
fi
printf '  simplify    : rounds=%s/%s changed=%s status=%s\n' "$SI_ROUNDS" "$simplify_rounds" "$(yn "$SI_CHANGED")" "$(status_disp "$SI_STATUS")"
if [ "$CODEX_STATUS" = "DID-NOT-RUN" ]; then
  # Deliberately NOT the rounds=/changed= shape the other phases use: this line must not read like a
  # review result. The second opinion is missing and that is the whole message.
  if [ "$crosscheck_engine" = "codex" ]; then
    printf '  codex       : ** DID NOT RUN (%s)\n' "$CODEX_REASON"
  else
    printf '  claude-xchk : ** DID NOT RUN (%s)\n' "$CODEX_REASON"
  fi
else
  if [ "$crosscheck_engine" = "codex" ]; then
    printf '  codex       : rounds=%s changed=%s status=%s (%s)\n' "$CODEX_ROUNDS" "$(yn "$CODEX_CHANGED")" "$(status_disp "$CODEX_STATUS")" "$CODEX_REASON"
  else
    printf '  claude-xchk : rounds=%s changed=%s status=%s (%s)\n' "$CODEX_ROUNDS" "$(yn "$CODEX_CHANGED")" "$(status_disp "$CODEX_STATUS")" "$CODEX_REASON"
  fi
fi
if [ -n "$CODEX_FINDINGS" ]; then
  if [ "$crosscheck_engine" = "codex" ]; then
    echo "  codex findings (surfaced — auto-fixed ones included; RISKY ones go to the escalation pass):"
  else
    echo "  claude cross-check findings (surfaced — auto-fixed ones included; RISKY ones go to the escalation pass):"
  fi
  printf '%s\n' "$CODEX_FINDINGS" | sed 's/^/    - /'
fi
printf '  security    : rounds=%s changed=%s status=%s (%s)\n' "$SEC_ROUNDS" "$(yn "$SEC_CHANGED")" "$(status_disp "$SEC_STATUS")" "$SEC_REASON"
if [ -n "$SEC_FINDINGS" ]; then
  echo "  security findings (surfaced — auto-fixed ones included; RISKY ones go to the escalation pass):"
  printf '%s\n' "$SEC_FINDINGS" | sed 's/^/    - /'
fi
if [ "$FCC_RAN" -eq 1 ]; then   # FCC_RAN=1 only on the reconcile path (implies FCR_RAN=1)
  if [ "$review_engine" = "claude" ]; then
    printf '  final-recon : cycles=%s status=%s (claude changed=%s / codex changed=%s)\n' \
      "$RECON_CYCLES" "$(status_disp "$RECONCILE_STATUS")" "$(yn "$FCR_CHANGED")" "$(yn "$FCC_CHANGED")"
  else
    printf '  final-recon : cycles=%s status=%s (codex changed=%s / claude changed=%s)\n' \
      "$RECON_CYCLES" "$(status_disp "$RECONCILE_STATUS")" "$(yn "$FCR_CHANGED")" "$(yn "$FCC_CHANGED")"
  fi
elif [ "$FCR_RAN" -eq 1 ]; then
  printf '  final-review: passes=%s changed=%s status=%s (ran: code changed after review)\n' "$FCR_PASSES" "$(yn "$FCR_CHANGED")" "$(status_disp "$RECONCILE_STATUS")"
else
  printf '  final-recon : skipped (no code changed after the initial review)\n'
fi
if [ "$ESC_STATUS" = "SKIPPED" ]; then
  printf '  escalation  : not run (%s)\n' "${ESC_REASON:-no RISKY finding to escalate}"
else
  printf '  escalation  : attempts=%s changed=%s status=%s (%s)\n' \
    "$ESC_ATTEMPTS" "$(yn "$ESC_CHANGED")" "$ESC_STATUS" "$ESC_REASON"
fi
if [ -n "$ESC_FINDINGS" ]; then
  echo "  escalation outcomes (one per RISKY finding it was given):"
  printf '%s\n' "$ESC_FINDINGS" | sort -u | sed 's/^/    - /'
fi

# The rule itself lives in compute_verdict (see the VERDICT MODEL section near the top, which is
# also what --self-test-verdict exercises). Here we only print what it decided.
compute_verdict

echo
# Informational FIRST and clearly separated, so the WHY line below carries only reasons that
# actually contributed to the verdict.
[ -n "$VERDICT_NOTES" ] && echo "review-loop: informational (did NOT affect the verdict): $VERDICT_NOTES"
case "$VERDICT" in
  CLEAN)
    if [ "$CODEX_ACTIVE" -eq 1 ]; then
      echo "review-loop: CLEAN — no unresolved RISKY finding, no security finding, no phase error ($phase_engine_display+$crosscheck_engine_display)."
    else
      echo "review-loop: CLEAN — no unresolved RISKY finding, no security finding, no phase error."
    fi;;
  NEEDS-AI)
    echo "review-loop: NEEDS-AI — FOREMAN's move, not a human's: another AI pass is what this needs. WHY: $VERDICT_WHY";;
  NEEDS-DECISION)
    echo "review-loop: NEEDS-DECISION — a PERSON has to choose; no amount of AI effort settles this. WHY: $VERDICT_WHY";;
  FAILED)
    echo "review-loop: FAILED — the gate did not complete, so this is NOT an approval. WHY: $VERDICT_WHY";;
esac
final_rc="$VERDICT_RC"

# In stop-hook mode always exit 0 so the Stop hook lets the session end (loop-safety); the real
# status was printed above and any fixes were committed.
if [ "$stop_hook" -eq 1 ]; then
  [ "$final_rc" -eq 0 ] || echo "review-loop: (stop-hook mode — exiting 0 to avoid Stop recursion; status above is authoritative)"
  exit 0
fi
exit "$final_rc"
