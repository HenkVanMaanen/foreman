You are the implementation worker for qrlink support report Henk msg 333051081.

Repository worktree: /home/dev/qrlink-qr-tab-multi-action
Branch: fix/qr-tab-multi-action, based on current origin/master.

Problem: The earlier search problem is fixed. From a QR code's QR-tab, searching for an existing action finds it
and adding it reports success, but a third action (example label "deel uw ervaring") does not appear/persist.
Multiple actions can be linked from the inverse action-tab flow. Reproduce and compare both directions.

Deliver a small, reviewable fix with focused regression coverage. Diagnose the actual write/read/refresh cause;
do not paper over it with a forced reload and do not weaken the exact-one action-type schema contract. Audit likely
Vue state/store API flow and backend association semantics. Run proportional targeted tests plus the relevant full
suite/lint/build. Commit and push the branch, then open a DRAFT Forgejo PR against master with clear reproduction,
cause, fix, and test evidence. Do not run bin/review-loop and do not merge/undraft. Preserve unrelated work.

Use Codex only. Write a durable handoff to /home/dev/foreman/notes/tasks/qrlink-qr-tab-multi-action.md and update
/home/dev/foreman/notes/tasks/qrlink-qr-tab-multi-action.status with a one-word DONE or BLOCKED when finished.
