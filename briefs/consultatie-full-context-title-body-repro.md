# Reproduce exact online title/body comment with full RE006 context

Work in `/home/dev/worktrees/consultatie-full-context-title-body-repro`, based on MR !58 exact head `c301942`.
Do not push/open an MR; foreman will integrate after independent verification.

Critical correction from Henk msg 333051153: the existing exact regression is invalid as an online reproduction
because `generateExactTitleBodyPDF` passes `documentText=quote` and the Comment uses `Start: 0`. Online, the quote
appears inside the full RE006 document with position, prefix and suffix. Henk supplied the full surrounding visible
context, which exactly matches the RE006 section at the start of `testdata/content/voorbeeld.md`: document title,
Regie, RE006 heading, intro, Afspraak, the selected Wijziging heading+paragraph, then Waarom deze afspraak and its
paragraph. Use that fixture as the source of truth.

Rewrite the regression so `documentText` realistically represents the full visible sample document (or at minimum
the complete supplied RE006 context with exact same preceding/following text), Comment.Start is the actual UTF-16
offset of the selected quote within it, and Prefix/Suffix match the browser TextQuoteSelector context around the
right occurrence. There are multiple `Wijziging...` headings; prove the test targets RE006 specifically. Prefer using
the same production web `pdfDocumentText`/DOM projection pathway or an equivalent fixture helper rather than an ad
hoc quote-only string.

Run the real Pandoc→Typst→pdfcpu PDF pipeline and retain all strong assertions: full title/body coverage, exactly
five valid quads (or explain a deterministic geometry change), yellow AP/rendering, linked popup/comment, no drift/
endnotes. First run against unmodified product code. If it fails, diagnose and implement the smallest root-cause
product fix with this regression. If it passes, report why it is now genuinely equivalent and commit the corrected
test only. Run focused/full tests, vet, lint and nilaway. Commit locally on branch
`test/pdf-full-context-title-body-repro`; do not push. Write notes/tasks/consultatie-full-context-title-body-repro.md
and standard result JSON.
