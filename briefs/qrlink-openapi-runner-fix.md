# Follow-up: make qrlink OpenAPI CI resilient to runner cache corruption

Source: Henk msg 333051033 asked to fix all CI errors. Existing draft PR #688 branch `fix/687-qr-search-in-actions` is clean at `fa74bac2` and owned by this task now that the prior worker exited.

Hosted run 2913 job 24769 `openapi-lint` fails inside `actions/setup-node@v4` before project code:
`lstat /root/.cache/act/.../eslint.config.mjs: no such file or directory`.
It also failed similarly in run 2912, but passed the prior run of the same PR. This indicates Forgejo/act runner cache corruption or a brittle setup-node cache input, not a Redocly lint error.

Work in `/home/dev/qrlink` on current branch `fix/687-qr-search-in-actions`.

Deliverables:
1. Inspect `.gitea/workflows/ci.yaml`, exact job logs/history, and setup-node cache configuration. Establish the smallest durable repository-side mitigation. Do not paper over actual OpenAPI lint errors and do not broadly disable unrelated caching.
2. Implement and locally validate the workflow change as far as practical. Preserve commit `fa74bac2` and all existing work.
3. Commit as `Henk van Maanen <henk@qrlink.nl>` and push the existing branch/PR #688. Do not merge, un-draft, deploy, or run review-loop.
4. Write `/home/dev/foreman/notes/tasks/qrlink-openapi-runner-fix.md` with root cause evidence, diff, validation, commit, and remaining risk. Write standard result JSON for task id `qrlink-openapi-runner-fix` last.

Be conservative: if no safe repo-side mitigation exists, report that with evidence rather than changing semantics. Another worker may inspect `/home/dev/qrlink-dns`; do not touch it or `/home/dev/qrlink-server`.
