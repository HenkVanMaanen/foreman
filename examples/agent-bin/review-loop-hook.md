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
  force the session to loop. The real verdict (CLEAN / NEEDS-HUMAN / FAILED) is still printed to the transcript,
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
            "command": "bin/review-loop --stop-hook --dir . --max-rounds 3"
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

Every phase reviews the diff from a single resolved **base**, derived by default (`--target auto`)
from the open MR/PR of the current branch — see `review-loop --help` for the flags.

Hook-specific: in `--stop-hook` mode the derivation runs **after** the marker check, so a stop that
is skipped never pays the forge round-trip.

## Verdict — what CLEAN actually means

The run ends in exactly one of three states, and only **correctness** signals decide which:

| verdict | exit | what caused it |
| --- | --- | --- |
| `CLEAN` | 0 | no RISKY finding, no security finding, no phase error |
| `NEEDS-HUMAN` | 3 | a reviewer left a finding UNAPPLIED as RISKY, and/or the security phase found anything in the changed code (even something it auto-fixed) |
| `FAILED` | 5 | a phase ERRORed — a review invocation failed, or a round's commit was rejected. The gate did not complete, so its silence is **not** approval |

**Convergence** signals are reported but never flip the verdict, and never appear in the `WHY:` line:

- a phase stopping at its round cap (`simplify: stopped at round cap (informational)`). `/simplify`
  is a taste pass with no fixpoint — it can always find one more thing to tidy, so "still changing at
  round N" says something about the cap, not about the code. Treating it as a failure is what made
  the old boolean verdict read `NOT-CLEAN` on every single run.
- `codex: ** DID NOT RUN (...)` — the second opinion is missing. That degrades the run and is printed
  loudly on its own line, but a reviewer that never started is not a finding about the code.

`review-loop --self-test-verdict` drives the rule with fabricated phase results and prints the
outcome for each case — no agents, no repo work. Use it (and extend it) whenever the rule changes.

## Codex — an independent second reviewer (default ON)

review-loop runs an **OpenAI Codex** review-and-fix phase as a genuinely independent second model,
in addition to the Claude phases. Codex reviews the branch diff (vs `--base`) for correctness bugs
and clear simplifications and **auto-applies the fixes it is confident about**, escalating anything
risky/uncertain — exactly like the security phase, but for general correctness rather than security.
It runs through the *same* digest/convergence machinery and the *same* round cap as the Claude
phases; every finding (fixed or not) is surfaced in the summary.

- **Ordering:** Claude code-review → Claude `/simplify` → **Codex review** → security → final
  convergence. Codex runs *before* security so security keeps the final word over the exact code
  that ships (including anything Codex changed).
- **Joint fixpoint:** when Codex is active, the gated final pass is a bounded **Claude↔Codex
  reconciliation** — it alternates a Claude review pass (report + apply) and a Codex recheck and is
  CLEAN only when a full alternation applies nothing on *both* models (so a Codex fix Claude would
  flag, and a Claude fix Codex would flag, are both caught). The alternation is capped at
  `--max-rounds` cycles — no infinite ping-pong.
- **Disagreement / escalation:** a Codex finding it judges too risky to auto-fix is left UNAPPLIED
  and surfaced as an escalation (`review-loop: NEEDS-HUMAN`, WHY printed) — the same human-decides
  channel as security escalations. Nothing risky is silently applied.
- **Flags:** `--codex` / `--no-codex` (default **on**), `--codex-model MODEL` (default
  `gpt-5.6-sol`).
- **Graceful skip:** if the `codex` CLI is not installed or not logged in (`codex login status`
  fails), the phase prints a warning and is **skipped** — the loop degrades to Claude-only and never
  hard-fails. The summary distinguishes `--no-codex (disabled)` from `codex not found` /
  `codex not logged in`.
- **Sandbox:** Codex is invoked with `-s danger-full-access`, not `-s workspace-write`. Codex's Linux
  sandbox is bubblewrap, which cannot start in this container (`bwrap: loopback: Failed RTM_NEWADDR:
  Operation not permitted`), so under `workspace-write` every Codex round failed before it could run
  a single git command. The trade-off is real but narrow: it removes Codex's *own* sandboxing, which
  is acceptable only because review-loop already runs every Claude reviewer as
  `claude -p --dangerously-skip-permissions` over the same working tree — same trust model, not a new
  exposure. Do not copy the flag to a context where Codex reviews untrusted code. The exact bwrap
  errors and the re-test command are documented above `run_codex()` in the script.
- **DID NOT RUN:** if the sandbox fails to start anyway, review-loop detects it, prints
  `codex: ** DID NOT RUN (sandbox failure)`, **discards** that phase's output instead of parsing
  Codex's "I could not inspect the diff" prose into a finding, and degrades the final pass to
  Claude-only. A missing second opinion must never masquerade as a review result.

## `second-opinion` — a Codex critique of a plan/design (companion tool)

`bin/second-opinion` is a separate, **non-mutating** helper: pipe a plan/design to it and Codex
returns an independent critique (key risks, hidden assumptions, missing cases, simpler approaches,
and a build-as-is verdict). It invokes Codex with a read-only sandbox so it cannot edit files or
touch git. Usage: `second-opinion [--model M] [--title T] <plan-file>` or `... | second-opinion`.
Same graceful behavior when codex is missing/not-logged-in (warns, exits nonzero, never hangs).

## Notes

- The hook runs `claude -p` **and `codex exec`** sub-invocations (the code-review report+apply
  pair, `/simplify`, the Codex review loop, the security fix loop, and — only if simplify, Codex or
  security changed code — a final reconciliation / code-review pass). Each costs tokens/time; keep
  `--max-rounds` modest for interactive use, or pass `--no-codex` to run Claude-only.
- **`/simplify` has its own cap** (`--simplify-rounds`, default **2**, vs `--max-rounds` 6 for the
  correctness phases). A taste pass never runs out of suggestions, so rounds 3+ bought churn — they
  were a large share of why a 20-line change took two hours. The correctness phases (code-review,
  security, reconciliation) keep the full `--max-rounds`.
- **The code-review phase is deliberately not a loop.** It runs the built-in `/review <PR>` once to
  REPORT (resolving the open GitHub PR for the branch via `gh`; with no PR it uses a diff-scoped
  review prompt instead), then ONE apply pass for the findings it is confident about. It replaced an
  up-to-`--max-rounds` loop of `/code-review high --fix`, whose per-round multi-agent review of the
  whole diff was by far this script's biggest token cost. Anything the apply pass will not touch is
  escalated as a RISKY finding, not re-reviewed. `--effort` is gone with it — nothing took it.
- The security phase **auto-fixes** the findings it is confident about (auth / input / secrets /
  network scope) and loops to convergence like the other phases. It escalates (NEEDS-HUMAN) if it
  found ANY finding in the changed code — a risky one it left unapplied, or one it auto-fixed that a
  human should still verify (all surfaced with WHY). In
  `--stop-hook` mode the process still exits 0 so it doesn't wedge the session; the real status and
  any surfaced findings are printed to the transcript, and all applied fixes are committed.
