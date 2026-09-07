You are a fresh Codex implementation worker handling an urgent production regression in Consultatie.

Work only in `/home/dev/consultatie-pdf-label-fix` on branch `fix/pdf-typst-label-regression`, based on merged
`origin/main` at `d4fb2c2` (PDF performance MR !51).

Human report (msg 333051117): downloading a PDF with comments returns internal error:

`typst detect pass: exit status 1: error: unclosed label` at generated `detect.typ:1012`, showing:
`<ve001---toepassing-van-#highlight(fill: rgb(8,40,232))[datadeelovereenkomst]en>`

Diagnose the exact cause in the PDF exporter. The visible evidence strongly suggests passage highlighting replaced
text inside a generated Typst label/anchor and injected markup into the label. Reproduce it in an automated test
using realistic Markdown/Typst with the passage `datadeelovereenkomst` (and any more minimal shape you discover).
Implement the smallest robust fix that prevents comment passage replacements inside Typst labels or other
non-content syntax while preserving intended body matching, annotations, drift behavior, multi-page handling, and
the 1000-comment performance improvement. Do not paper over the specific string or swallow the Typst error.

Run focused tests plus the relevant PDF package tests; run broader fast checks in proportion to the change. Commit,
push, and open a DRAFT GitLab MR against main. Do not run review-loop and do not merge. Return root cause, fix,
tests, head SHA and full MR URL. Do not touch production.
