# Fix silent chart-label regression test failure on MR !58

Work in `/home/dev/worktrees/consultatie-pdf-title-body-safe-diagnostic` on branch/MR !58 at `a2f5035`.
Pipeline `2813732355` has `helm lint` green, then `deploy/helm/consultatie/tests/chart-labels.sh` exits 1 silently.
Reproduce with `sh -x` under the same Helm 3.20 environment if possible. The likely issue is the boundary fixture's
length arithmetic (`consultatie-` prefix plus `0.0.0-` plus 46 `a`s may be 64, not exactly 63), but verify rather
than assume. Fix the test and any helper issue it reveals; improve assertion diagnostics so a future failure is not
silent. Preserve the generic Kubernetes-safe, <=63, stable-hash uniqueness behavior introduced by `a2f5035`.

Run exact chart lint and script under Helm 3.20 plus shell syntax/diff checks. Commit/push same branch, no new MR,
no review-loop, no merge. Record replacement exact-head pipeline and result JSON for worker id
`consultatie-chart-label-test-ci-fix`; append concise status to the existing diagnostic task note.
