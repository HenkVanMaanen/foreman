# Fix lint on exact title/body PDF regression in MR !58

Work in `/home/dev/worktrees/consultatie-pdf-title-body-safe-diagnostic` on exact branch head `3f4acb4`, existing
draft MR !58. Pipeline `2813746285` has Helm/chart test green but lint fails only in the newly integrated exact PDF
regression:

- `internal/pdfexport/pdfexport_test.go:610`: gocyclo 32 > 30 for
  `TestGenerateExactTitleBodySelectionRegression`.
- line ~694: gosec G703 tainted path on optional evidence `os.WriteFile(evidence, res.PDF, ...)`.

Refactor the test into clear focused helpers to reduce complexity without weakening any exact assertion: full title
+ body coverage, five valid line quads, yellow AP, popup/comment linkage, no drift/endnotes. Eliminate the tainted
path safely; preferably remove runtime arbitrary evidence-path writing from the committed test or constrain it to a
fixed test temp location. Do not add broad nolint suppressions and do not change product behavior.

Run exact focused test, full Go tests/vet, `templ generate && golangci-lint run`, and nilaway if affected. Commit and
push same branch, no new MR/review-loop/merge. Record replacement pipeline and standard result JSON for worker id
`consultatie-exact-selftest-lint-fix`; update existing task note concisely.
