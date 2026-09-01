# Task: fix remaining qrlink E2E CI failures

Source authorization: Henk msg 333051033 asked to fix all CI errors and deploy. DNS is now merged and run 2914 preview deploy succeeds. Remaining E2E job 24804 fails.

Work in `/home/dev/qrlink` on branch `fix/687-qr-search-in-actions`, currently pushed at `10ac9908` in draft PR #688. No other worker is editing this repo; post-DNS verification worker is read-only.

Evidence from run 2914 job 24804:
- Preview deploy is green; DNS/auth/bootstrap work.
- First `npx playwright test`: 105 passed, 1 skipped, tag test flaky/recovered, persistent Stripe checkout failure across test retries. Exact Stripe failure: timeout at `checkout.spec.ts:160`, waiting for `iframe[title="Secure payment input frame"]` card-number placeholder; likely Stripe iframe/Elements DOM changed or selector assumption stale.
- Workflow then automatically runs the entire 108-test suite again. The second run reproduces Stripe, then many page/invite/project-user tests that passed first run time out together, suggesting whole-suite retry against mutated/shared environment or resource collapse. Inspect `.gitea/workflows/ci.yaml` and Playwright config for the exact retry shell semantics.

Deliverables:
1. Pull exact authenticated logs for run 2914/job 24804 and inspect test/config/workflow history. Diagnose Stripe using trace/screenshot artifacts if downloadable, live preview UI if safe, and current Stripe iframe DOM. Do not weaken or skip the payment test merely to get green.
2. Diagnose the second whole-suite retry. Prefer Playwright per-test retries and deterministic isolation; do not blindly rerun an already-mutated full suite if that is the cause. Preserve meaningful coverage.
3. Implement the smallest robust fix, with a failing-first reproduction where practical. Run focused tests against preview or local stack, plus config/lint checks. Avoid touching unrelated application code.
4. Commit as `Henk van Maanen <henk@qrlink.nl>`, push existing branch/PR #688. Do not merge, un-draft, deploy prod/dev, close issues, or run review-loop.
5. Write `/home/dev/foreman/notes/tasks/qrlink-e2e-reliability.md` with root cause evidence, files/diff, verification, commit, and remaining risk. Standard result JSON for `qrlink-e2e-reliability` last.

Do not edit qrlink/dns or qrlink/server. Server PR #86 is declined by Henk and must remain untouched.
