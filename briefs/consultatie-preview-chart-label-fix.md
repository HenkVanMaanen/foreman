# Fix invalid Helm chart label blocking consultatie preview MR !58

Work in `/home/dev/worktrees/consultatie-pdf-title-body-safe-diagnostic` on the existing branch/MR !58. Fetch/reset
only by fast-forward if needed; preserve all commits. Henk supplied the exact Flux failure:

`ServiceAccount ... is invalid: metadata.labels: Invalid value:
"consultatie-0.0.0-chore-pdf-unmatched-safe-diagnostic-e016c84e_"`

The preview chart version includes build metadata (`+...`); a chart/template label helper sanitizes it into a value
ending in `_`, violating Kubernetes label syntax. Find the shared chart label construction, fix it generically so
all generated label values begin/end alphanumeric and remain <=63 chars while preserving useful uniqueness. Do not
special-case this branch. Add a Helm/template regression covering this exact long prerelease+build-metadata shape
and relevant boundary cases. Ensure selectors/immutable labels remain stable for already-valid ordinary versions.

Run Helm lint/template tests plus existing quick tests/lint appropriate to the change. Commit and push to the same
branch; do not open another MR, run review-loop, or merge. Confirm a replacement exact-head pipeline is created.
Write status to `/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-safe-diagnostic.md` and standard result JSON
for worker id `consultatie-preview-chart-label-fix`.
