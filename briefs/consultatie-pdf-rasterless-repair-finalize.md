# Repair test corruption, then finalize rasterless PDF MR

Work only in `/home/dev/consultatie-pdf-rasterless`, branch `perf/pdf-contentstream-geometry`, with current
uncommitted parser/hot-path work. Two previous sessions stalled; do not repeat discovery.

FIRST, repair `internal/pdfexport/pdfexport_test.go`: compare its full diff to `origin/main`. Some unrelated existing
annotation loops were accidentally deleted/mangled (notably around `TestAnnotateQuadPoints`, duplicate/overlap
quality checks, and `TestGenerate1000Comments`). Restore every such block exactly from `origin/main`. Preserve only
intentional changes: parser tests live in `contentstream_test.go`, benchmark/test compatibility with the new
geometry timing/hot path, and any deliberate strengthened quality assertion you can explain. Run gofmt and compile
the package immediately. Do not proceed while the diff contains unexplained deletions.

Then finish:
- Apply the narrow audit rule already identified: clipping, shading, inline images, XObjects, or unsupported
  paint/state operations that could affect detection must invalidate all potentially affected target colours;
  never return partial geometry for an invalidated colour. Add focused tests.
- Keep scope to Typst-produced detection PDFs. Correct q/Q, CTM, fill colour, path reset, page coordinates. Fail
  closed for page rotation/crop ambiguity if not explicitly supported.
- Run parser tests and the full existing PDF quality suite.
- Benchmark 69 at least 2x and 1000 at least 3x; record totals/phase timings. Known good interim result: 1000 in
  1.435s, all quality tests green before the later accidental test corruption.
- Remove only dead raster hot-path code/imports; retain Pdftoppm struct/config compatibility if appropriate; update
  logs/comments/timing.
- Full go race/vet/golangci-lint/nilaway and relevant builds.
- Commit, push, open DRAFT MR. No review-loop, ready, merge, tag, deploy.
- Handoff `/home/dev/foreman/notes/tasks/consultatie-pdf-rasterless-worker.md`, result JSON
  `/home/dev/foreman/state/consultatie-pdf-rasterless.result.json`.

Use Codex only; never Claude.
