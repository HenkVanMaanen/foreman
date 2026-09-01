# Task: speed up comment PDF generation

Work only in `/home/dev/consultatie-pdf-performance` on branch `perf/comment-pdf-1000` based on current main.
Read every applicable `AGENTS.md`/repo instruction first.

Source requirement: a user with about 70 comments cannot download their PDF with comments because generation is
so slow that the browser closes/times out. Diagnose and substantially speed up the real production PDF download
path. Add a realistic automated performance/regression test that generates one PDF containing **1000 comments**.

Constraints and delivery:
- Measure/profile the current path before changing it; identify the actual bottleneck and retain useful before/after
  evidence in your handoff.
- Preserve PDF content, ordering, ownership/privacy filtering, annotations, accessibility expectations, and error
  behavior. Do not weaken security or silently omit comments to win the benchmark.
- Prefer the smallest robust fix at the correct layer. Keep response streaming/timeout behavior in mind, but solve
  actual generation cost rather than merely increasing a timeout.
- The 1000-comment test must exercise the real PDF generator sufficiently to catch this regression and must have a
  defensible, non-flaky performance bound or benchmark evidence suitable for CI.
- Run focused tests plus the repository-required lint/test/build sanity checks proportionate to the change.
- Commit coherent changes, push the branch, and open a **draft** GitLab MR. Do not run `bin/review-loop`; that gate
  happens only after human content approval.
- Update `/home/dev/foreman/notes/tasks/consultatie-pdf-performance.md` with diagnosis, before/after timings,
  commits, validation, MR URL, and remaining risks. Do not edit `notes/INDEX.md`.
