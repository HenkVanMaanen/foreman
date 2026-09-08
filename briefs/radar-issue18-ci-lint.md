# Fix standaard-radar !56 exact-head lint failure

Work only in `/home/dev/worktrees/radar-issue18` on existing branch `fix/issue18-cleanup`, draft MR !56.

The exact-head pipeline is https://gitlab.com/datastelsel.nl/federatief/simulation/standaard-radar/-/pipelines/2826163968
and job `Lint (go)` id `16343826111` failed. Inspect the job trace, identify the precise cause, make the
smallest correct fix, run the relevant local checks plus `git diff --check`, commit, push to the same branch,
and leave the MR draft. Do not run `bin/review-loop`, merge, deploy, change DNS, or touch the companion
simulation branch/MR. Do not weaken lint or tests. Preserve all user/worker changes already present.

Record the diagnosis, changed files, checks, commit SHA, and new pipeline URL/status in
`/home/dev/foreman/notes/tasks/radar-issue18-ci-lint.md`, then write the normal result JSON expected by
`bin/spawn-worker`.
