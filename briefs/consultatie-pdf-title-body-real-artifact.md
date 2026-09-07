# Consultatie: diagnose real title-to-body PDF annotation regression

Work in `/home/dev/worktrees/consultatie-pdf-title-body-real-artifact`, based exactly on current `origin/main`
(`35b6c4c0d8a132278a2ac1fc4aaf07874069d362`). The exact failing PDF supplied by Henk is private at
`/tmp/consultatie-title-body-bug-20260902.pdf` (SHA-256
`bb12c778983fbff831c1f28db591c38e083e374beebd893a595d4c38da3b612e`). Never commit, copy into the repo, or
emit its real extracted content into tracked files/log summaries.

The bug: a comment selection spanning a title and following body text is missing its yellow marking/comment in
this generated PDF. MR !57 attempted to fix an invisible Typst-label boundary, but Henk confirmed the real artifact
still fails. Diagnose from evidence, not that prior hypothesis. Inspect PDF annotation dictionaries, QuadPoints,
Rect, AP streams, popup/comment linkage, page placement, and selected-text/geometry boundaries; compare what is
present/missing with the generator pipeline and current tests. You may use private throwaway extraction under /tmp,
but sanitize all reported examples.

Then implement the smallest root-cause fix with a privacy-safe synthetic regression reproducing the actual failure
mechanism. Run focused and proportionate package/full tests. Commit on the worktree branch and open a DRAFT GitLab
MR with a concise explanation and validation. Do NOT run review-loop and do NOT merge. If the evidence is
insufficient to implement safely, stop after a precise diagnosis and state what additional input is required.

Record status/result in `/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-real-artifact.md` and finish cleanly.
