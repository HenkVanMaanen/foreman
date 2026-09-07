Work in /home/dev/consultatie-pdf-real-vng on branch fix/pdf-real-vng-comments at 1b5e496.

The exact-head GitLab lint job failed with only:
- gocognit: matchProjectedClaimed complexity 36 > 30
- nestif: the `if !overlaps` block complexity 6
- gocritic offBy1 in TestPlanCommentsUsesContextWhenDOMAndTypstOffsetsDiffer because strings.Index is used inline.

Make the smallest behavior-preserving refactor that fixes all three. Preserve the review-proven selection semantics:
matching context must outrank incompatible DOM-vs-Typst offsets; UTF-16 position disambiguates ties/otherwise.
Fix the test warning by assigning and checking the index explicitly. Do not change dependencies, scope, or generated files.
Run gofmt, git diff --check, go test ./internal/pdfexport ./internal/web, and the repo's golangci-lint command.
Commit the verified fix to the current branch with a concise message, but DO NOT push or touch the MR.
Write a concise result to /home/dev/foreman/state/consultatie-pdf-real-vng-lint-result.md.
