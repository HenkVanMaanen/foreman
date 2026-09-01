Work in /home/dev/qrlink. This is a follow-up to qrlink issue/PR work.

Current state:
- PR #688 was squash-merged into master as 21f0caec and its source branch was deleted.
- The branch fix/687-qr-search-in-actions was then recreated and commit bd170581 (ci: stabilize Stripe checkout E2E) pushed.
- Draft PR #689 is open, but because the recreated branch retained the old pre-squash ancestry, its comparison currently includes all old #688 commits instead of only the E2E follow-up.

Task:
1. Read repo AGENTS.md and CLAUDE.md fully.
2. Repair branch fix/687-qr-search-in-actions so it is based on current origin/master and contains ONLY the semantic change from bd170581. Use a safe temporary branch/cherry-pick approach, verify exact commit/diff, then update the remote branch. A force-with-lease push is authorized for this draft branch because it is required to fix its ancestry; never force plain.
3. Confirm PR #689 remains draft and its file diff is only `.gitea/workflows/ci.yaml` and `e2e/tests/dashboard/checkout.spec.ts` (expected roughly 8 additions/21 deletions).
4. Verify a fresh CI run is associated with corrected head; report URL/run ID and initial job state. Do not merge, un-draft, deploy dev/prod, run the expensive review-loop, or weaken/skip E2E coverage.
5. Write notes/tasks/qrlink-e2e-rebase.md and a state result JSON if the worker harness expects it.

Be especially careful: do not lose the already-merged #688 changes from master; the PR must show only the follow-up. Do not expose credentials in output.
