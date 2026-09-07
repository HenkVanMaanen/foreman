# Task: reconcile current main into consultatie MR !55 and merge safely

Henk authorized merging MR !55 in Telegram msg 333051137. Work only in
`/home/dev/consultatie-organisation-exports` on `feat/organisation-pdf-csv-exports`.

The prior Codex-only final gate returned CLEAN and pushed head
`d877420b5b4efdb48cc1dff8f47918a4e46ce0fa`. Pipeline 2812807517 was running, but `main`
advanced to `af05ef9` via the real-VNG-comments PDF work and GitLab now reports conflicts.

Fetch and verify the worktree is clean and those refs are current. Reconcile `origin/main` into the
feature branch with a normal merge commit (do not rewrite published history). Resolve conflicts by
preserving the current-main PDF matching/annotation behavior and MR !55's organization export
behavior and review fixes. Inspect each conflict semantically; do not choose an entire side blindly.

Run focused tests for every conflicted component plus `go test ./internal/web ./internal/pdfexport`
and the relevant Playwright list/check if available. Commit the merge resolution. Because the tested
tree changes after the prior gate, run the final gate again, Codex-only:

`FOREMAN_REVIEW_ENGINE=codex FOREMAN_REVIEW_CROSSCHECK=off /home/dev/foreman/bin/review-loop --dir .`

Handle verdicts per policy: CLEAN proceeds; NEEDS-AI fix and rerun; NEEDS-DECISION stops with the
precise human choice; FAILED reruns. Never use Claude and never run two review loops concurrently.

After CLEAN, push, wait for the exact new-head pipeline to succeed, mark MR !55 ready, verify it is
mergeable, merge it using the normal project method, and report the merge SHA plus main pipeline
URL/status. Do not touch MR !56 or deploy manually. Preserve unrelated files and do not edit foreman
notes.
