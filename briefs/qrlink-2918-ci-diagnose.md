Work read-only first in /home/dev/qrlink. Read AGENTS.md and CLAUDE.md fully.

Context: draft PR #689 at corrected head 91f0094c contains only two E2E files. Henk authorized merge once done. Fresh Gitea Actions run 2918 has early failures in api-build, webscan-build, qrgenereren-build, cms-test, cms-build while other jobs are still running; deploy-preview/E2E are waiting. Similar prior simultaneous failures were a shared BuildKit daemon crash.

Task:
1. Use authenticated Gitea API without exposing credentials to inspect exact failing step/logs and timestamps for all failed jobs in run 2918.
2. Determine whether failures are runner/BuildKit/transient vs caused by the two-file PR change. Cite exact evidence.
3. If and only if failures are conclusively transient infra and Gitea supports it, POST rerun-failed-jobs for run 2918 once. This reversible CI rerun is authorized. Do not edit code, merge, un-draft, deploy dev/prod, or run review-loop.
4. Monitor only enough to confirm rerun was accepted/new attempts started, then report. Do not block for the whole suite.
5. Write notes/tasks/qrlink-2918-ci-diagnose.md and the required state result JSON.
