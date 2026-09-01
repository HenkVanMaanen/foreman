# Follow-up: add a manual 1000-comment preview user to MR !51

Work only in `/home/dev/consultatie-pdf-performance` on existing branch `perf/comment-pdf-1000` and existing draft
MR !51. Read applicable `AGENTS.md` first. Human explicitly approved this follow-up in msg 333051109.

Goal: make the live MR preview manually testable with a clearly named login (recommend “PDF Testgebruiker”) whose
session owns exactly all 1000 seeded comments, so the user can open the seeded document and download their own
1000-comment PDF through the real browser route.

Requirements:
- Preview/test only: do not alter production data, production login choices, privacy semantics, or the PDF route's
  ownership filtering.
- Prefer the smallest coherent fixture/model change. The preview mock OIDC subject must resolve to the same actor ID
  as all 1000 seeded commenting annotations. Preserve the existing 1000-comment diversity used by beheerder UI tests
  where feasible (organizations/content may remain representative), but ownership must be unambiguous for the new
  login. Do not break the mock beheerder/admin flow or existing fixture invariants/resolutions.
- Show the exact preview login label/email/flow and seeded document in the handoff. Add automated coverage proving
  exactly 1000 live comments belong to this login actor and that unrelated/moderating events stay correct.
- Run focused tests and the required fast lint/test/build sanity checks. Commit, push the same branch so MR !51
  updates, keep it draft. Do not run review-loop.
- Update `/home/dev/foreman/notes/tasks/consultatie-pdf-performance.md` and write
  `/home/dev/foreman/state/consultatie-pdf-preview-user.result.json` as the final act.
