# Qrlink migration 091 recovery

Work only in `/home/dev/qrlink-coronacheck-migration` on branch `fix/091-coronacheck-migration` from current
`origin/master`. Use Codex. Henk explicitly authorized building, reviewing and rolling out the CoronaCheck
migration recovery in msg 333051073.

Production deploy 4.24.10 ran API migration 091 and failed at re-adding `qrlinks_chk_1` with MySQL error 3819.
Because MySQL DDL autocommits, production is now partially applied: the old check and `qrlinks.corona_location_id`
were dropped; adding the new XOR constraint failed because former CoronaCheck-only qrlinks now have every action
column NULL. Later drops of `corona_contact`, `qrlink_corona_locations`, and permission cleanup did not execute.
No application containers were restarted. All 4.24.10 images exist.

Design and implement the smallest robust recovery that works for both:

1. a pristine pre-091 database (column/check/tables still present), and
2. this exact partially applied production state (column/check absent, obsolete tables remain, invalid all-NULL
   qrlinks remain).

Before deleting obsolete CoronaCheck-only data, preserve an auditable backup/archive in a durable and clearly
named database table or equally robust migration-owned mechanism. Account for the fact that the partial state has
already lost `corona_location_id`; preserve all remaining identifiable qrlink and related CoronaCheck data. Avoid
manual production-only SQL as the primary solution. Make reruns/retries safe. Do not weaken the intended XOR
constraint. Audit the migrator's versioning/transaction behavior and the down migration implications. Add focused
integration/migration tests exercising pristine and simulated partial failure/recovery states using the repository's
existing MySQL test machinery. Run proportional full API/repository tests, linters and builds.

Commit, push, and open a DRAFT PR against master. Do not run review-loop, merge, tag or deploy; Foreman owns the
final gate and rollout after your handoff. Write `/home/dev/foreman/notes/tasks/qrlink-coronacheck-migration.md`
with root cause, data semantics, exact validation, SHA and PR URL, and write result JSON to
`/home/dev/foreman/state/qrlink-coronacheck-migration.result.json` as the final filesystem action.
