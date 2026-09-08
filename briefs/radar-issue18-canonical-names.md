# Task: finish Radar issue #18 canonical naming in both draft MRs

Henk Telegram msg 333051181 says preserve only the existing database identity so no database migration is needed.
Normalize all other application, chart, deployment, Flux and Kubernetes names by removing migration-era `go`.

Read `/home/dev/foreman/notes/tasks/radar-issue18-cleanup.md` and
`/home/dev/foreman/notes/journal/2026-09-07-radar18-canonical-migration-checkpoint.md` first.

Existing clean worktrees and draft MRs:

- `/home/dev/worktrees/radar-issue18`, branch `fix/issue18-cleanup`, head `e3e5668e`, standaard-radar MR !56.
- `/home/dev/worktrees/simulation-radar-issue18`, branch `chore/issue18-radar-deployments`, head `5af17fbf`, simulation MR !443.

Implement the approved scope in both branches. Keep the Database object name `standaard-radar-go`, physical name
`standaard_radar_go`, and required matching Helm value reference intact. Rename chart/publication path,
OCIRepository, HelmRelease, application resources, labels/selectors, manifest filename, image/chart references and
docs to canonical `standaard-radar` identities wherever applicable.

Treat persistence carefully. The current derived PVC is `standaard-radar-go-data`; Henk did not authorize silent
loss of its text cache. Determine a safe declarative transition, or establish from code semantics/tests that it is
disposable and rebuildable before changing it. Avoid collision/adoption of the retired Python canonical PVC. Guard
the legacy canonical OCIRepository/HelmRelease so publishing the renamed stable chart cannot auto-upgrade old
Python values. Do not touch live infrastructure, publish stable manually, merge, or run review-loop.

Run proportionate validation in both repos: chart package/lint/render, Kustomize/manifest validation, CI lint,
tracked/rendered stale-name sweeps, and relevant app tests/lint. Commit and push both existing branches, update and
cross-link draft MR descriptions, then inspect exact-head pipelines. Keep both MRs draft. Write detailed status in
`/home/dev/foreman/notes/tasks/` and report commits, pipelines, tests, and residual rollout ordering or decisions.
