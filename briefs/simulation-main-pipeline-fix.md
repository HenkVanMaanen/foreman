# Task: fix current Simulation main pipeline failures

Authoritative request: Henk Telegram msg 333051201 asks for an MR fixing the pipeline issues on the Simulation
repo's main branch.

Worktree: `/home/dev/worktrees/simulation-main-pipeline-fix`, branch `fix/main-pipeline`, based on exact current
`origin/main`. GitLab project id 61564605.

Tasks:

1. Inspect the newest pipelines on `main`, enumerate every failed job, and read each relevant job log. Reproduce
   the failures locally where practical. Do not assume older evidence remains current.
2. Find the smallest root-cause fix. Prior evidence suggests catalog/metagen/website image builds fail at `pnpm
   fetch` with `ERR_PNPM_IGNORED_BUILDS`, and registry coverage may be 88.8% vs 90%, but verify both.
3. Implement only fixes needed to restore main pipeline health. Avoid unrelated dependency upgrades/refactors.
   Add focused tests only when necessary; do not lower quality/coverage thresholds merely to turn CI green.
4. Run proportional local validation, commit in small reviewable increments, push the branch, and open a DRAFT MR
   with exact failure evidence and test results. Do NOT run foreman's final review-loop, undraft, merge, or modify
   production/cluster state.
5. Write `notes/tasks/simulation-main-pipeline-fix-worker.md` and a result JSON in the normal spawn-worker format,
   including MR URL, branch/head, pipeline id/status, failed job evidence, files changed, and remaining caveats.

Respect `/home/dev/worktrees/simulation-main-pipeline-fix/AGENTS.md` completely.
