Work in /home/dev/qrlink on existing branch fix/687-qr-search-in-actions / draft PR #689. Read AGENTS.md and CLAUDE.md fully.

Source task remains Henk's request to fix all qrlink CI errors and his explicit "ok merge when done" approval. Run 2918 is otherwise green after infra rerun, but E2E job 24865 failed identically twice before test collection:
- activation completes
- login reaches dashboard URL `https://dash-507d162c.pr.qrlink.dev/error`
- setup waits 10s, logs `WARNING: App did not render <nav> — auth state may be incomplete`, but saves auth state anyway
- seeding then throws `Could not get customerId from /api/self` at e2e/global-setup.ts:256
Thus Stripe checkout was never exercised.

Task:
1. Inspect global-setup.ts, dashboard auth/error routing, API/self behavior, preview config, and relevant git history/logs. Determine the real causal bug; do not assume it is merely timing.
2. Implement the smallest robust fix on the existing branch. It must validate successful authentication before saving state/seeding and handle the actual preview startup/auth contract. Do not skip coverage, swallow failures, hardcode secrets, or restore the removed whole-suite retry.
3. Add/update focused regression tests if feasible, and run proportional local checks. If live-preview validation is possible without destructive state, use it; be honest about limits.
4. Commit and push the existing branch to update draft PR #689. Do not open another PR, merge, un-draft, deploy dev/prod, push tags, or run review-loop.
5. Report exact cause, diff, validation, new SHA/run URL in /home/dev/foreman/notes/tasks/qrlink-e2e-global-setup.md and state result JSON.

Preserve current clean PR ancestry (one commit on master before your new commit). Do not touch unrelated files or expose credentials.
