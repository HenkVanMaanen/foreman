# Finalize rasterless PDF implementation

Work only in `/home/dev/consultatie-pdf-rasterless` on `perf/pdf-contentstream-geometry`. Preserve current uncommitted
implementation (`contentstream.go`, tests, hot-path changes). Do not restart discovery or rewrite a working parser.

Verified externally after the prior Codex session stalled:
- `go test ./internal/pdfexport -run 'Test(ContentScanner|ExtractPageRects)' -count=1` passes.
- full `TestGenerate` quality set passes: IDs/popups, duplicate/overlap, labels, nested styling.
- 1000-comment generation is 1.435s (old raster baseline ~63s; spike ~6s).

Finish the change:
1. Run stable 69 benchmark at least 2x and 1000 test/benchmark multiple times; record cold/warm phase timings.
2. Audit the content lexer/interpreter narrowly for PDF correctness and fail-closed behavior: arrays/dicts/strings/
   comments must not leak operands/operators; q/Q and CTM composition; fill colours; path resets; unsupported paint/
   clipping/XObject operations that could affect a target colour; page rotation/crop/media coordinates. Add missing
   focused tests, but keep scope to Typst-produced detection PDFs.
3. Ensure bad/ambiguous geometry causes that colour/comment to drift/endnotes, never partial misplaced rectangles.
4. Remove dead raster hot-path code/imports if safe. Retain Binaries.Pdftoppm compatibility if needed, but update
   stale comments/timing/log fields. Do not add dependencies.
5. Run gofmt/diff-check, `go test ./... -race -count=1`, vet, golangci-lint, nilaway, server/frontend build as relevant.
6. Commit, push, open a DRAFT MR against main. Do not review-loop, ready, merge, tag, or deploy.
7. Write benchmark/design/test handoff to `/home/dev/foreman/notes/tasks/consultatie-pdf-rasterless-worker.md` and
   result JSON to `/home/dev/foreman/state/consultatie-pdf-rasterless.result.json`.

Use Codex only; never invoke Claude.
