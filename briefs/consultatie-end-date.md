# Consultatie end date — discovery pass

Work in `/home/dev/consultatie-end-date` on branch `feat/consultatie-end-date`.

Henk wants a configurable end date for each consultation. After the deadline, participant comments must remain
readable but participants must not be able to add or edit them. Foreman has proposed an inclusive calendar date
through 23:59:59 Europe/Amsterdam, while administrators retain resolution/handling capabilities; Henk's answer
is still pending.

For this first pass, inspect the domain model, content/front matter/configuration, participant comment create/edit
routes, admin handling routes, templates, seed data, and tests. Do not edit files yet and do not open an MR.
Return a concise implementation plan naming exact files, all server-side enforcement points, UI changes, data/
backward-compatibility behavior, timezone edge cases, and focused tests. Flag any additional genuinely blocking
product question. This must be evidence-based from the repository, not speculation.
