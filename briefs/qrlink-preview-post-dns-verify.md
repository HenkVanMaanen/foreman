# Task: verify merged preview DNS and rerun preview

Source: Henk msg 333051039: "i merged dns. #86 not necessary anymore since ip is always resolved correctly now".

Honor that decision: do not merge/deploy/modify/close server PR #86. It remains untouched unless Henk separately asks to close it.

Repositories are read-only for this verification. Relevant app PR: https://git.sallandpioneers.com/qrlink/qrlink/pulls/688, commit `10ac9908`; latest Actions run 2914 previously had all builds/tests green after failed-job rerun, but preview failed before DNS was merged.

Deliverables:
1. Verify DNS PR #52 merge state and authoritative/public resolution for `pr.qrlink.dev` plus representative wildcard names used by PR `507d162c` (including accounts, plausible/app endpoints as defined by workflow/templates). Confirm A target is `95.217.34.151`; check from multiple resolvers as reasonable. Do not expose credentials.
2. Read-only check the review host at `root@95.217.34.151` using `/home/dev/.ssh/preview_key`: ensure Traefik/cert remain healthy. No remote mutation.
3. Once DNS is live, use authenticated Gitea API credentials from git credential helper to rerun failed jobs for run 2914 (or specifically deploy-preview if supported). This CI rerun is authorized by the task; do not trigger prod/dev jobs. Monitor deploy-preview through completion and then E2E if it runs.
4. If preview still fails, diagnose exact step/log and report; do not deploy #86 or change code unless separately authorized.
5. Write `/home/dev/foreman/notes/tasks/qrlink-preview-post-dns-verify.md` with DNS evidence, rerun API action, job IDs/log outcome, URLs, and any remaining blocker. Write standard result JSON for task id `qrlink-preview-post-dns-verify` last.

No branch/PR changes, merges, server writes, Cloudflare API changes, or review-loop.
