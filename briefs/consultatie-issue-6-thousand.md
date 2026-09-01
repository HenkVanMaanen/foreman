# Consultatie MR !48 iteration: scale seeded stress case to 1000 reactions

Work only in `/home/dev/consultatie-wt/issue-6` on branch `perf/issue-6`, existing draft MR:
https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/48

Human instruction Henk msg 333051069: "maybe do a thousand reactions?" Treat this as approved iteration on the
same draft MR. Update the deterministic shipped/demo seed from 273 to exactly 1000 representative reactions while
preserving the existing 19 resolutions and privacy-safe identities/behavior. Update benchmark/regression tests and
documentation/config assumptions so the 1000-reaction scenario is genuinely exercised. Profile before/after or
at least record current 1000-reaction server payload/render/allocation and browser parse/Alpine/selection metrics.
Keep thresholds generous but capable of catching the former quadratic duplication. Do not weaken behavior,
accessibility, statistics, filters, resolution picker semantics, export, or privacy.

Run full race tests, lint/nilaway, build, Playwright, focused benchmark, and diff check. Commit and push to the
existing branch/MR. Do not run review-loop, undraft, or merge. Update
`/home/dev/foreman/notes/tasks/consultatie-issue-6.md` with the new 1000-reaction evidence and final SHA. Return a
concise handoff.
