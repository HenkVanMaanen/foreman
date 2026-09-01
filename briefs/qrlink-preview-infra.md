# Task: repair qrlink preview infrastructure

Source: Henk Telegram msg 333051036: "can you also fix the preview infra then? its in the qrlink/server repo and you have access to the review server".

Work in `/home/dev/qrlink-server` on the already-created branch `fix/preview-infra`.

Context:
- The qrlink app PR #688 Actions `deploy-preview` job currently fails during `Configuring Zitadel` → `Creating project`, process exit 6 / curl DNS resolution failure. The last known successful preview deployment was 2026-05-14.
- The related app repo is `/home/dev/qrlink`; read-only inspection there is allowed if you need the workflow/scripts or exact failure path. Do not edit that repo: another worker owns an active uncommitted pnpm repair there.
- Henk explicitly says this infra lives in `qrlink/server` and that we have review-server access. Find existing SSH/config conventions without exposing credentials or secret values. Never print raw secrets.
- Production is out of scope. Do not mutate production. Changes on the review server are allowed only as needed to diagnose and validate the preview fix; preserve/recover state and avoid destructive operations.

Deliverables:
1. Diagnose the actual root cause using repository history/config, the failing Actions path/logs, DNS resolution, and review-server state. Do not assume the prior curl exit-6 diagnosis is sufficient.
2. Implement the smallest durable fix in qrlink/server on this branch. Include documentation or validation where appropriate.
3. Run quick, relevant sanity checks. If a safe review-server change is necessary to validate, make it carefully and report exactly what changed.
4. Commit with author `Henk van Maanen <henk@qrlink.nl>`, push the branch, and open a DRAFT PR against master. Do not merge, un-draft, deploy production, or run the expensive foreman review-loop.
5. Write the final report to `/home/dev/foreman/notes/tasks/qrlink-preview-infra.md`: root cause evidence, files/remote state changed, tests, commit, branch, PR URL, remaining risks, and any human decision needed.

Stay focused on this preview-infra failure. Preserve unrelated work and follow any repository instructions you discover.
