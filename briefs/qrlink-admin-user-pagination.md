# QRLink admin customer/user pagination and user search

Work only in `/home/dev/qrlink-admin-user-pagination` on branch
`feat/admin-user-pagination-search`, based on current `origin/master` `f452a0f2`.

Human request (Henk msg 333051099): in the QRLink admin dashboard there is a customer list and,
inside a customer, a user list. Verify whether pagination is missing; if so add pagination. Also add
a search bar for users that searches user name and email address. Open a PR when done.

Mandatory repo instructions:
- Read and follow `/home/dev/qrlink-admin-user-pagination/AGENTS.md` and `CLAUDE.md` before editing.
- Preserve the hexagonal Go/API architecture; SQL queries through storage interfaces and SQLC.
- Run `sqlc generate` after SQL changes.
- Before push run the relevant `just ci-job api-test` and `just ci-job dashboard-test` checks (and
  `just ci` only if proportionate/feasible). Do not claim unrun checks.
- Gitea repository, not GitHub/GitLab. Push a regular branch and open a draft PR against master.
- Commit identity must remain Henk van Maanen <henk@qrlink.nl> via existing includeIf config.

Implementation expectations:
1. Trace the real customer-list and per-customer user-list UI/API/data paths first. Explicitly report
   whether each already paginates and avoid rewriting working pagination.
2. Where absent, implement server-side pagination rather than slicing a full dataset in Vue. Reuse
   established pagination request/response conventions and components from this repo.
3. User search must be server-side, case-insensitive where the existing database conventions allow,
   and match both display/name fields actually used by the domain and email. Trim input and make an
   empty search equivalent to no filter. Use parameterized SQL; preserve tenant/customer scoping.
4. Decide and test what happens when search changes while on a later page (normally reset to page 1).
   Preserve URL/query state if the surrounding admin dashboard already follows that convention.
5. Add regression tests at the appropriate API/storage and dashboard levels for pagination, name
   search, email search, empty/no-result states, and tenant isolation. Avoid brittle snapshot-only proof.
6. Keep API compatibility where practical. Validate bounds/default page size and avoid unbounded reads.
7. Inspect the diff for generated/unrelated churn. The box currently has limited free disk, so do not
   pull large unrelated containers/caches; if a required check cannot run, report the exact blocker.
8. Commit, push, and open a DRAFT Gitea PR. Do not run review-loop and do not merge; Henk reviews the
   draft first.
9. Update `/home/dev/foreman/notes/tasks/qrlink-admin-customer-users-pagination.md` with findings,
   validation, branch/head, and PR URL. Write the standard result JSON for worker id
   `qrlink-admin-user-pagination`.
