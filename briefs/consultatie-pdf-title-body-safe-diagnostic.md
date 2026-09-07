# Consultatie: privacy-safe diagnostic for unmatched PDF selector

Work in a NEW worktree/branch based on exact current consultatie `origin/main` (`35b6c4c...`). This task follows
the sanitized evidence in `/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-real-artifact.md`; read that
file. The exact PDF is private and must not be inspected or copied for this task.

Implement the smallest temporary/reviewable diagnostic that lets one preview export distinguish where a comment
selection becomes unmatched: original selector versus browser `documentText`, Pandoc/Typst visible projection,
and detection-pass extracted text/geometry. It must NEVER log or return raw document/selector/comment text or
snippets. Emit only correlation-safe comment ID if already non-secret, lengths, hashes, offsets, Unicode names/
categories, edit operation types/counts, region/style boundary metadata, and stage outcome. Avoid making sensitive
content inferable character-by-character; cap/bucket diagnostics where appropriate. Prefer a diagnostic artifact or
structured server log accessible to foreman after Henk exports once on preview. Gate it tightly (preview/debug flag
or affected PDF export path) so normal production behavior and output are unchanged.

Add privacy/safety tests proving raw sentinel text never appears and stage classification works. Run quick relevant
tests, commit, push, and open a DRAFT MR so its preview can be tested. Do not run review-loop and do not merge.
Document exactly how foreman retrieves the sanitized diagnostic after Henk regenerates the PDF. Record result in
`/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-safe-diagnostic.md` and the standard result JSON.
