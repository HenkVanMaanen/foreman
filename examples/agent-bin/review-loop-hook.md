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

## Notes

- The hook runs `claude -p` sub-invocations (`/code-review`, `/simplify`, conditionally
  `/security-review`). Each costs tokens/time; keep `--max-rounds` modest for interactive use.
- Security findings are **never** auto-applied — a NOT-CLEAN / ESCALATE result is printed for you to
  act on, but in `--stop-hook` mode the process still exits 0 so it doesn't wedge the session.
