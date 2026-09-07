# Continue private PDF diagnosis without emitting document text

Work only in `/home/dev/worktrees/consultatie-pdf-title-body-real-artifact` on branch
`fix/pdf-title-body-real-artifact`. The private artifact remains
`/tmp/consultatie-title-body-bug-20260902.pdf`; never copy it into Git or print/extract any verbatim real document
text to stdout/stderr, worker logs, notes, commits, MR descriptions, or result files. This prohibition includes
snippets and surrounding context. Use only counts, hashes, offsets, Unicode code-point categories, edit-operation
types, and fully invented/sanitized synthetic text. Redirect any unavoidable private command output directly to
private `/tmp` files.

Evidence already established: the PDF has 63 complete highlight/popup pairs, but one 480-character quote is sent
to the final unmatched-comments section; other quote groups match. Current main's generic title→body synthetic
test passes, so the earlier invisible-label theory does not reproduce this artifact. Determine the FIRST
normalized mismatch and its structural cause using a script whose output contains only numeric offsets, code-point
names/categories and edit types. Then implement the smallest generator fix with an invented privacy-safe synthetic
regression, validate it, commit, push, and open a DRAFT GitLab MR. Do not run review-loop or merge. If evidence is
insufficient, stop with a sanitized diagnosis/blocker instead of guessing.

Write the sanitized status to `/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-real-artifact.md` and as
your final act write `/home/dev/foreman/state/consultatie-pdf-title-body-real-artifact-v3.result.json` with the
standard worker result object.
