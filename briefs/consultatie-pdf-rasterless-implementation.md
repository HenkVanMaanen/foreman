# Task: implement rasterless PDF highlight geometry

Work only in `/home/dev/consultatie-pdf-rasterless`, a dedicated Consultatie worktree based on current `origin/main`
after merged MR !54 (`af05ef94`). Build a separate draft MR replacing the slow pdftoppm PNG rasterisation/pixel scan
used to detect Typst highlight rectangles with direct PDF content-stream geometry extraction using the existing
pdfcpu dependency. Do not change renderer or visible PDF behavior.

Prior spike evidence: direct contentstream extraction preserved unique IDs/popups, duplicate quotes, overlap,
multi-line and multi-page geometry with zero drift. Approximate total times were 69 comments 4.58s -> 0.49s and
1000 comments 63.1s -> 6.0s. Typst SVG is only a fallback/oracle, not the recommended production path.

Requirements:
- Parse the actual relevant PDF operators with correct graphics-state stack, CTM, fill colour and path geometry;
  do not use an unsafe regex/string approximation.
- Preserve every correctness fix on main: HTML UTF-16 occurrence mapping, duplicate quotes, overlaps/layers,
  styled/multiline/multipage passages, labels/code exclusion, fallback-title alignment, drift/endnotes, popup/ID
  annotation behavior.
- Fail closed: unsupported/ambiguous geometry must become drift/endnotes, never a misplaced highlight. Consider
  whether a narrowly-scoped SVG oracle/fallback is justified, but avoid unnecessary production complexity.
- Remove pdftoppm from the hot path and configuration only if compatibility and tests prove it safe; account for
  deployments/config that still provide the field/binary.
- Add focused parser/operator tests plus full end-to-end PDF quality regression and stable benchmarks for 69 and
  1000 comments. Record before/after cold/warm numbers and any tradeoffs.
- Run relevant full Go/race/vet/golangci-lint/nilaway and build checks. Keep diff reviewable and no new dependency.

Commit, push, and open a DRAFT GitLab MR. Do not run review-loop, mark ready, merge, tag, or deploy. Write a concise
handoff under `/home/dev/foreman/notes/tasks/consultatie-pdf-rasterless-worker.md` and the result JSON under
`/home/dev/foreman/state/consultatie-pdf-rasterless.result.json`. Use Codex only; never invoke Claude.
