# Implement configurable consultation end dates

Work only in `/home/dev/consultatie-end-date` on `feat/consultatie-end-date`, based on current `origin/main`.
The prior pass was read-only; the worktree should be clean.

Confirmed product policy from Henk (msgs 333051095–096):

- Every consultation has an optional configurable calendar end date.
- An administrator must be able to set or change it afterward for existing consultations, not only at creation.
- Existing and new consultations without a date remain open indefinitely.
- The date is inclusive through the end of that local day in `Europe/Amsterdam`.
- After closure participant comments remain readable, but participants cannot create, edit, or delete them.
- Administrators may still handle/resolve comments after closure.

Implement this completely across both document tiers discovered earlier: Git-backed Markdown and uploaded DOCX.
Use strict, stripped front matter for Git documents and a nullable DB date plus admin create/update controls for
uploaded documents. Centralize the Amsterdam deadline policy with a testable clock. Enforce it server-side on all
participant write routes, then make UI states match: visible status/deadline, closed notice, no create/edit/delete
or selection-comment controls, existing comments still rendered. Preserve admin resolution and unrelated admin
document operations.

Add focused repository-native tests for parsing/invalid metadata, DB migration/persistence and updating existing
documents, missing-date compatibility, Amsterdam CET/CEST and exact-midnight boundaries, direct/stale HTTP write
rejection, admin resolution after closure, templates, and one E2E closed fixture. Keep unrelated fixtures open.

Work in small coherent commits. Run quick relevant/full sanity checks in proportion to the change, but DO NOT run
`bin/review-loop` or any final heavy review: that is foreman's gate only after Henk approves the draft. Push the
branch and open a DRAFT GitLab MR with a concise description, validation evidence, migration/backward-compatibility
notes, and screenshots only if practical. Do not merge. Return the MR URL, exact head SHA, tests run, and risks.
