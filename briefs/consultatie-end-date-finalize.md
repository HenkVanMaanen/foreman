# Finalize consultation end-date fix on MR !50

Work only in `/home/dev/consultatie-end-date` on the existing branch `feat/consultatie-end-date`.
You are continuing a prior Codex worker that was terminated because the filesystem filled during
`bash e2e/visual.sh --update`. Do not redesign or discard the uncommitted work.

Current facts:
- The implementation now stores admin deadline overrides centrally for both `content:<slug>` and
  `upload:<uuid>`, while Git frontmatter remains the fallback when no override row exists.
- Admin can set/change/clear the deadline for existing Git and uploaded consultations.
- Participant write gates consume the effective deadline; existing content stays readable and
  admin resolution remains allowed.
- `mise run fmt && mise run test && mise run lint && mise run build` passed after lint fixes.
- Focused Chromium passed 3/3, including changing an existing Git consultation deadline and the
  closed participant view.
- The earlier MR pipeline visual failure was only the intended mobile document-list height change.
- About 2 GB was freed with `go clean -cache` after the disk-full event.

Tasks:
1. Inspect the current diff carefully and preserve the intended implementation/tests/docs.
2. Finish the CI-matched visual workflow. If updating snapshots, verify that only the intended
   document-list mobile baseline changes; do not accept unrelated visual churn.
3. Re-run proportionate verification after the disk-full interruption (at minimum formatting,
   relevant Go tests/lint/build if needed, focused Chromium functional tests, and focused visual
   verification). Fix real failures.
4. Commit all intended changes in one or more clear commits and push the existing branch so draft
   MR https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/50 updates.
5. Do not run review-loop and do not merge. Human content approval comes first.
6. Update `/home/dev/foreman/notes/tasks/consultatie-end-date.md` with final head, validation, and
   MR status. Write the standard worker result JSON for id `consultatie-end-date-finalize`.

Avoid deleting source/worktree data. If disk space is again insufficient, report the exact command
and required space rather than silently accepting an incomplete result.
