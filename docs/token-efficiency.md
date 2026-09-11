# Foreman token efficiency

The September 11 audit measured 100.57M tokens in 48 hours: 93.64M cached input,
6.05M fresh input and 0.89M output. Resident coordination accounted for 43%; review
phases accounted for 15% of total tokens and 32% of fresh input. These changes
address those workflows with unchanged models, effort settings and required review gates.

| Area | Behavior |
|---|---|
| Waiting | Resident instructions use `wait-on <worker...>` and end the turn. The existing supervisor waits for worker attention or human input without another model request. Approval notifications already wait for the worker lock to clear and coalesce unchanged receipt counts. |
| Notes | `notes-context` returns at most 15,000 UTF-8 bytes of INDEX, preserving the beginning and end with an explicit notice pointing to the full source. Short indexes pass through unchanged. Durable notes are never overwritten. |
| Approvals | `approval-list` returns unresolved summaries with receipt counts and versions. `approval-read <id>` returns that handoff's complete authenticated receipts, grants and resolution history. The resident must read those receipts before granting; exact receipt-snapshot validation and revocation handling remain in place. |
| Tool output | `bounded-run -- command [args...]` keeps the full combined stdout/stderr in a private artifact and returns at most 10,000 bytes of text. It preserves the command's exit status and reports binary output by artifact reference. Capture memory is bounded. |
| Review evidence | Each gate creates a private evidence directory. Each phase receives paths to the manifest and full diff; unchanged source bundles reuse the same content key. Base, head, tracked diff, untracked paths/content and symlink targets affect the key. Every required reviewer still runs. |
| Review output | `approval-review` saves complete stdout to a private log and returns a 10KB view. The actual final line, process exit, current receipt grant and exact head still determine CLEAN. |
| Measurement | Codex review invocations append numeric usage plus phase, model, starting head and exit status to the evidence directory's `usage.jsonl`. Cached input and reasoning remain nested subtotals; unavailable fields are null. |

Examples:

```sh
notes-context
bounded-run -- git diff --stat
bounded-run -- bash -lc 'bun test test/agent-context.test.ts'
thread-control approval-list
thread-control approval-read <handoff-id>
wait-on <worker-name>
```

The wrapper operates on text-producing commands chosen by the agent; it cannot
intercept arbitrary tools inside the external Codex CLI. Bootstrap, bound-thread,
worker and review guidance make bounded reads the default workflow. Image payloads
remain separate from text byte measurements. Small command output is returned directly;
large output includes an explicit full-artifact path. The source artifacts are evidence,
not instructions, cached findings or authorization. Existing CLEAN/head/receipt checks,
review phase ordering, models, effort, sandbox flags and CI requirements are unchanged.

The 15KB INDEX view intentionally omits the middle of an oversized file. It is an
entry point, not a semantic summary or a substitute for a relevant task journal,
repository instructions, actual approval receipts or policy. Shared INDEX compaction
remains a notes-owner operation; the runtime view supplies the model-context reduction
without a destructive migration. A fresh resident lifetime is needed to replace already
retained historical context.

Activation is resident-owned after the specific implementation head has passed its
required review and merge workflow. The bound worker cannot deploy or harness-sync.
The activation owner should:

1. Activate the merged harness using the existing authorized procedure; preserve unrelated
   configuration, secrets, model/effort choices, review policy and keeper behavior.
2. Ensure the updated bootstrap and helper sources are installed. `ensureWorkspace` seeds
   `notes-context`, `bounded-run` and `review-context` as symlinks. It preserves deliberate
   regular-file overrides, so check the installed `review-loop`, worker footer and bootstrap
   for overrides before claiming these changes live; apply the corresponding changes through
   the authorized activation procedure rather than blindly overwriting customizations.
3. Start a fresh resident lifetime and verify a compact INDEX view, compact approval list,
   complete `approval-read` receipts, and event-based waiting. Use an offline synthetic
   worker/helper probe where possible; do not create production review calls as a smoke test.
4. Compare the next comparable 48-hour window using the audit parser's unique-response
   accounting: resident response count, prompt size/cache mix, fresh input, output,
   review phase usage and quota snapshots. Keep the same model/effort for the comparison.

The audit's savings estimates are conditional and overlapping. Neither byte caps nor
raw token totals establish exact Pro subscription debit reductions. Evidence directories
and command/review logs remain local for inspection; no automatic retention cleanup or
shared-notes rewrite is introduced.
