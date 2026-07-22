# review-loop as an opt-in Claude Code Stop hook

`bin/review-loop` is normally driven two ways:

1. **Explicitly** — a worker runs `bin/review-loop --dir .` as its definition-of-done step
   (spawn-worker.sh appends this instruction to every worker brief). This is the primary path.
2. **Automatically via a `Stop` hook** (documented here) — so even *inline*, non-worker changes in
   an interactive session get reviewed when Claude finishes responding.

Option 2 is **opt-in and belt-and-suspenders**. It is intentionally **not** enabled in any live
`settings.json` — you wire it in yourself when you want it.

## Loop-safety (why the `--stop-hook` flag exists)

A Claude Code `Stop` hook fires every time the session is about to end. A naive hook that does work
and lets the session continue can *re-trigger itself*. `review-loop --stop-hook` guards against this
two ways:

- **Marker file** — on first run it creates `${FOREMAN_STATE_DIR:-<dir>/state}/.review-loop-ran`.
  While that marker exists, subsequent `--stop-hook` invocations no-op (exit 0) instead of running
  the loop again. Clear the marker to allow another run (see below).
- **`stop_hook_active`** — Claude Code passes a JSON payload on stdin with
  `"stop_hook_active": true` when the stop is already the result of a prior Stop hook. `--stop-hook`
  reads stdin and, if it sees that flag, no-ops immediately.
- **Always exits 0** in `--stop-hook` mode — it never returns a blocking exit code, so it cannot
  force the session to loop. The real CLEAN / NOT-CLEAN status is still printed to the transcript,
  and any auto-fixes are committed.

Because it commits its own fixes and only runs the bounded loops (hard round cap), it makes
measurable progress and terminates every time.

## settings.json snippet

Add this to `.claude/settings.json` (project) or `~/.claude/settings.json` (user). Adjust the path
to `bin/review-loop` for your checkout.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bin/review-loop --stop-hook --dir . --max-rounds 3 --effort high"
          }
        ]
      }
    ]
  }
}
```

## Clearing the marker (arming it for the next session)

The marker makes the loop run **once per marker lifetime**. Clear it when you want the next stop to
re-run the loop. Options:

- Manually: `rm -f state/.review-loop-ran`
- On session start, via a `SessionStart` hook that removes it:

  ```json
  {
    "hooks": {
      "SessionStart": [
        { "matcher": "*", "hooks": [
          { "type": "command", "command": "rm -f state/.review-loop-ran" } ] }
      ]
    }
  }
  ```

## Enable / disable

- **Enable:** add the `Stop` (and optionally `SessionStart`) block above, then restart the session
  (hooks are read at startup).
- **Disable:** remove the `Stop` block (or the whole `hooks` key) and restart. Deleting the marker
  file alone does **not** disable the hook — it only re-arms it.

## Review scope (`--base` / `--target`)

Every phase reviews the diff from a single resolved **base**. By default (`--target auto`) the loop
asks `glab`/`gh` for the **open MR/PR of the current branch** and uses the merge-base with that MR's
*target* branch, so the review scope equals the MR — including for a branch stacked on another
not-yet-merged branch, where the merge-base with `origin/main` would drag the parent's commits in.

For the per-flag semantics of `--base` / `--target`, see `review-loop --help` — the single copy, so
this doc cannot drift from what the script does.

Hook-specific: in `--stop-hook` mode the derivation runs **after** the marker check, so a stop that is
skipped never pays the forge round-trip.

## Codex — an independent second reviewer (default ON)

review-loop runs an **OpenAI Codex** review-and-fix phase as a genuinely independent second model,
in addition to the Claude phases. Codex reviews the branch diff (vs `--base`) for correctness bugs
and clear simplifications and **auto-applies the fixes it is confident about**, escalating anything
risky/uncertain — exactly like the security phase, but for general correctness rather than security.
It runs through the *same* digest/convergence machinery and the *same* round cap as the Claude
phases; every finding (fixed or not) is surfaced in the summary.

- **Ordering:** Claude `/code-review` → Claude `/simplify` → **Codex review** → security → final
  convergence. Codex runs *before* security so security keeps the final word over the exact code
  that ships (including anything Codex changed).
- **Joint fixpoint:** when Codex is active, the gated final pass is a bounded **Claude↔Codex
  reconciliation** — it alternates a Claude `/code-review` pass and a Codex recheck and is CLEAN only
  when a full alternation applies nothing on *both* models (so a Codex fix Claude would flag, and a
  Claude fix Codex would flag, are both caught). The alternation is capped at `--max-rounds` cycles
  and each pass is itself round-capped — no infinite ping-pong.
- **Disagreement / escalation:** a Codex finding it judges too risky to auto-fix is left UNAPPLIED
  and surfaced as an escalation (`review-loop: NOT-CLEAN`, WHY printed) — the same human-decides
  channel as security escalations. Nothing risky is silently applied.
- **Flags:** `--codex` / `--no-codex` (default **on**), `--codex-model MODEL` (default
  `gpt-5.6-sol`).
- **Graceful skip:** if the `codex` CLI is not installed or not logged in (`codex login status`
  fails), the phase prints a warning and is **skipped** — the loop degrades to Claude-only and never
  hard-fails. The summary distinguishes `--no-codex (disabled)` from `codex not found` /
  `codex not logged in`.

## `second-opinion` — a Codex critique of a plan/design (companion tool)

`bin/second-opinion` is a separate, **non-mutating** helper: pipe a plan/design to it and Codex
returns an independent critique (key risks, hidden assumptions, missing cases, simpler approaches,
and a build-as-is verdict). It invokes Codex with a read-only sandbox so it cannot edit files or
touch git. Usage: `second-opinion [--model M] [--title T] <plan-file>` or `... | second-opinion`.
Same graceful behavior when codex is missing/not-logged-in (warns, exits nonzero, never hangs).

## Notes

- The hook runs `claude -p` **and `codex exec`** sub-invocations (`/code-review`, `/simplify`, the
  Codex review loop, the security fix loop, and — only if Codex or security changed code — a final
  reconciliation / `/code-review`). Each costs tokens/time; keep `--max-rounds` modest for
  interactive use, or pass `--no-codex` to run Claude-only.
- The security phase **auto-fixes** the findings it is confident about (auth / input / secrets /
  network scope) and loops to convergence like the other phases. It escalates (NOT-CLEAN) only if it
  can't converge within the cap or it found a finding too risky to auto-fix (surfaced with WHY). In
  `--stop-hook` mode the process still exits 0 so it doesn't wedge the session; the real status and
  any surfaced findings are printed to the transcript, and all applied fixes are committed.
