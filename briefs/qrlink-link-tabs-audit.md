Continue PR #693 in /home/dev/qrlink-qr-tab-multi-action on branch fix/qr-tab-multi-action.

New explicit Henk request msg 333051083: audit whether other link/association tabs have the same Vuetify mismatch
as QRCode/Edit/QRLinks: autocomplete without return-object (or equivalent item-value contract) while handlers or
selection helpers treat model entries as full objects, causing empty/incorrect IDs and false-success no-ops.

Systematically enumerate comparable add/link autocompletes across dashboard/src, especially QR code, QR link,
short link, advertisement, project/user, label and similar association tabs. For each, trace template model type,
return-object/item-value, add handler payload, checkbox selected-state logic, and refresh. Distinguish safe ID-model
flows from unsafe object-model flows. Fix every actual instance in the same PR with focused regression coverage;
avoid speculative refactors and do not change backend/schema semantics. Run targeted tests plus full dashboard
tests, lint-ci, and build:check. Commit and push updates to the existing branch/PR #693, keep it draft. Do not run
review-loop, merge, release, or undraft. Update /home/dev/foreman/notes/tasks/qrlink-qr-tab-multi-action.md with
the audit matrix/findings and verification, and write DONE to
/home/dev/foreman/notes/tasks/qrlink-link-tabs-audit.status on completion.
