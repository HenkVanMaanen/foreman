Work in /home/dev/qrlink-server (Gitea qrlink/server). Read all repo AGENTS.md/CLAUDE.md files fully.

Source: Henk asked to fix preview infra (msgs 333051036/37) and later said obsolete server PR #86 was unnecessary after DNS merged. Do NOT modify/reuse/merge #86. This is a newly proven separate analytics readiness defect blocking qrlink PR #689 E2E.

Evidence on review host 95.217.34.151, preview pr-507d162c:
- OAuth succeeds; API log at 13:42:24: `authenticate failed for GetSelf: get: customer get: register: Post "http://analytics:8000/api/v1/sites": dial tcp: lookup analytics on 127.0.0.11:53: server misbehaving`.
- Plausible `analytics` is restart-looping (29 restarts), repeatedly fails ClickHouse connection to `analytics-events-db:8123` with connection refused.
- compose uses `analytics-events-db: condition: service_started`, not healthy.
- API container reports unhealthy because its healthcheck invokes `curl`, absent from the image.
- deploy-preview nevertheless returned success, so readiness gate is unsound.

Task:
1. Start a NEW branch `fix/preview-analytics-readiness` from current `origin/master`; preserve existing `fix/preview-infra` and PR #86 untouched.
2. SSH read-only first using root@95.217.34.151 and key /home/dev/.ssh/preview_key. Inspect exact ClickHouse container state/logs/config/networks and compose template/scripts. Determine why it refuses connections (startup ordering vs crash/restart/config). Never print secrets.
3. Implement the smallest robust server-repo fix: correct ClickHouse/Plausible dependency health ordering and ensure deploy readiness verifies analytics before claiming success. Fix invalid API healthcheck with a command actually present in the image or a sound alternative. Do not merely add sleeps; do not weaken readiness or hide failures.
4. Add/update shell/template tests or validation. Run proportional local checks (`bash -n`, compose config with safe dummy values, repo tests). If safe, use a disposable local compose project; do not mutate the live review host in this worker.
5. Commit/push and open a NEW draft PR against master. Do not merge, deploy host changes, edit DNS, close #86, un-draft, tag, or run review-loop.
6. Write /home/dev/foreman/notes/tasks/qrlink-preview-analytics-fix.md and state result JSON with root cause, diff, validation, PR URL, and exact next deployment verification.
