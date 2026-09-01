# Consultatie issue 6 — whole-UI performance at 1,000 reactions

You are the implementation worker. Work only in `/home/dev/consultatie-wt/issue-6` on existing branch
`perf/issue-6` and existing draft MR !48. Use Codex. Henk reports that with the now-shipped deterministic
1,000-reaction seed, the feedback overview is very slow and other parts of the UI also load slowly.

Diagnose with real server/browser profiling across the full relevant UI, especially feedback overview and
shared/global paths. Establish useful before measurements, identify root causes, implement robust bounded fixes,
and add regression tests/benchmarks/browser checks proportional to the issue. Preserve behavior, accessibility,
privacy, permissions, filters, CSV/print/admin flows, and the deterministic 1,000-reaction fixture. Avoid merely
loosening ceilings, hiding content, or replacing work with arbitrary timeouts. Prefer structural reductions in
server work, response size, DOM size, and client initialization where evidence supports them.

Run full race tests, lint/nilaway, production build, normal Playwright, and targeted 1,000-reaction browser
profiling/tests. Record exact before/after results. Commit and push to the same branch/MR. Keep MR draft. Do not
run review-loop, merge, or create a new MR. Update `/home/dev/foreman/notes/tasks/consultatie-issue-6.md` with
the new SHA, diagnosis, changes, exact validation, and metrics. Write a concise result JSON to
`/home/dev/foreman/state/consultatie-issue-6-whole-ui.result.json` as your final filesystem action.
