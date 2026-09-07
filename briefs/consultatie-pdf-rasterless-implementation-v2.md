# Implement now: direct PDF highlight geometry

Repository/worktree: `/home/dev/consultatie-pdf-rasterless`, branch `perf/pdf-contentstream-geometry`, clean at
`af05ef94` (merged MR !54). A prior discovery session stalled without edits. Do not repeat broad discovery.

Known facts:
- `Generate` currently spends ~4.17s of 4.59s/69 comments in pdftoppm raster + pixel scan.
- Typst highlight content is a decoded PDF stream sequence like:
  `q 1 0 0 -1 83.67 787.79 cm /c1 cs 0.03137 0.28235 0.53333 scn 0 0 m 454.91 0 l ... h f Q`.
- Existing pdfcpu v0.13 exposes decoded `xRefTable.PageContent(pageDict,pageNr)` and page rectangles; use it.
- Existing code already uses pdfcpu and knows each exact synthetic RGB layer colour.

Start coding immediately. Implement a small real PDF content lexer/operator interpreter (not regex) supporting the
needed numeric/name/string/comment tokens and `q`, `Q`, `cm`, `cs/CS`, `sc/scn`, `rg`, `m`, `l`, `re`, `h`,
`f/f*/F`; maintain stack/CTM/fill/path, transform all path points, accept only closed axis-aligned filled rectangle
geometry matching an expected layer RGB, and fail closed on malformed/unsupported state that could affect geometry.
Extract per-page rectangles from pdfcpu decoded streams and feed the current downstream annotation pipeline.

First milestone before further refactoring:
1. Focused unit tests for lexer, q/Q, nested CTM, fill colour, m/l/h/f and re/f, comments/strings, malformed input,
   unsupported path/transform fail-closed.
2. Swap the detect-pass hot path to this extractor while leaving pdftoppm config compatibility intact initially.
3. Run the existing full PDF quality regression (duplicates, overlaps, multiline/multipage, IDs/popups/drift).
4. Benchmark 69 and 1000. If quality differs or performance is not materially better, diagnose before cleanup.

Then remove truly dead raster code/imports only if safe, run full race/vet/lint/nilaway/build, commit, push, and open
a DRAFT MR. No review-loop, ready, merge, tag or deploy. Record detailed benchmark and handoff in
`/home/dev/foreman/notes/tasks/consultatie-pdf-rasterless-worker.md`; result JSON in
`/home/dev/foreman/state/consultatie-pdf-rasterless.result.json`. Codex only; never invoke Claude.
