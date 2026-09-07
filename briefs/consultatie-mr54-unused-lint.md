# MR !54 final unused lint cleanup

Work only in `/home/dev/consultatie-pdf-real-vng` on the existing branch. The completed Codex-only gate is CLEAN,
but a subsequent full `golangci-lint run ./...` reports exactly one issue:
`internal/pdfexport/pdfexport.go:674:6: func matchProjected is unused`.

Inspect to confirm the wrapper is truly unused, remove only the dead wrapper (not the used matching machinery),
run gofmt if needed, `git diff --check`, focused PDF tests, and full golangci-lint. Commit the cleanup locally.
Do not push, open/modify MR, run review-loop, merge, tag, or deploy. Write result JSON as required. Codex only.
