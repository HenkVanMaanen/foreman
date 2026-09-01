# Consultatie issue 6: Werkbank performance with 273+ comments

Work only in `/home/dev/consultatie-wt/issue-6` on branch `perf/issue-6`.

Source instruction: Henk msg 333051065. GitLab work item:
https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/work_items/6

The real consultation has 273 comments and the Werkbank UI becomes very slow. Diagnose with evidence; do not
guess. Reproduce/profile the server and browser path at realistic volume, identify the actual bottleneck(s), and
implement the smallest robust improvement. Expand the project seeder to create at least a realistic 273-comment
scenario (prefer deterministic and representative data). Preserve current behavior, privacy properties, stats,
filters, and CSV export. Add regression coverage or a reliable performance-focused check where appropriate.

Run proportionate tests including race tests/build/lint and any relevant UI/E2E checks. Keep changes small and
reviewable. Commit and push the branch, then open a **draft** MR linked to issue 6. Do not run `review-loop`, do
not undraft, and do not merge. Record profiling evidence, exact validation, commit SHA, and MR URL in
`/home/dev/foreman/notes/tasks/consultatie-issue-6.md`. Do not touch unrelated worktrees or qrlink tasks.
