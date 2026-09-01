# Fix MR !50: end date must be editable for every existing consultation

Work in `/home/dev/consultatie-end-date` on pushed branch `feat/consultatie-end-date`, MR !50.

Henk tested the draft and found a real requirement miss (msg 333051098): the admin UI only allows setting/changing
the end date for uploaded DOCX documents. Existing Git-backed consultations merely show their status. His confirmed
requirement is that an administrator can set, change, or clear the end date via the app for EVERY existing
consultation, including Git-backed ones. Foreman acknowledged this as a bug; do not defend the current design.

Inspect the current four commits and redesign the persistence/model so there is one clear effective deadline for
both document tiers. Prefer a shared persisted consultation-settings record keyed by stable document identity if
that is the cleanest option; avoid two divergent writable sources of truth. Decide and document precedence/backward
compatibility if Git front matter remains as an initial/default value. The admin UI must expose an editable date form
for every existing row and save/clear it server-side with admin authorization. The participant write gates and UI
must consume the resulting effective deadline identically for Git and uploaded documents.

Add focused tests proving admin set/change/clear on an existing Git-backed consultation and an existing upload,
effective closure of direct create/edit/delete, persistence across reload, missing-date open compatibility, and
admin resolution after closure. Update the E2E flow to exercise changing an existing consultation via the admin UI,
then confirm the participant page closes. Re-run Go/race/lint/nil/build and the focused Chromium test. The previous
pipeline also requires an intentional mobile document-list snapshot update; do that only after the final UI is stable,
verify only intended visual baselines change, and run the focused visual test.

Commit coherent fixes and push to the existing branch/MR. Do not run final review-loop and do not merge. Return exact
head, design/precedence summary, tests, snapshot paths, and new pipeline URL/status.
