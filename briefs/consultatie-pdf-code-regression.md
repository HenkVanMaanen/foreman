You are a fresh Codex implementation worker handling a second urgent production PDF regression in Consultatie.

Work only in `/home/dev/consultatie-pdf-code-fix` on branch `fix/pdf-typst-code-matching`, based on current main
`3a02b8bc` (which includes the prior label-span fix).

Human production report msg 333051121:

`typst detect pass: exit status 1: error: unknown variable: e` at generated source:
`#strong[#e#highlight(fill: rgb(8,40,120))[m]ph[Dit is een wijziging op de ...`.

The unmodified Pandoc output was evidently `#strong[#emph[Dit is een wijziging ...]]`; a short comment quote
matched inside the non-rendered Typst function identifier `emph`, and highlight injection split that identifier.

Diagnose and reproduce the exact nested strong/emph form in unit and real Pandoc→Typst→PDF tests. Implement a
robust, minimal way for comment passage matching to ignore non-rendered Typst syntax/code tokens—not a hard-coded
exception for `emph`, and not merely another isolated heuristic that leaves other `#function`, label, link-target,
string/argument syntax vulnerable. Prefer a clearly specified tokenizer/span classifier or another mapping from
rendered text regions to source offsets. Preserve visible-text matching (including styled text), first occurrence,
overlap/drift behavior, annotations, and the 1000-comment one-pass performance. Include adversarial tests for short
quotes that appear in syntax before visible text and ensure the prior label and inline `a < b` regressions stay green.

Run focused tests, the full pdfexport suite including 1000 comments, repository Go tests after generation, vet/lint
as appropriate. Commit, push, and open a DRAFT GitLab MR against main. Do not run review-loop and do not merge.
Return root cause, design, validation, head SHA and full MR URL. Do not touch production.
