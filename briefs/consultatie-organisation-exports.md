# Task: PDF and CSV exports per organisation

Work as a fresh Codex implementation worker in the Consultatie repository. The human explicitly requests a
separate MR that lets admins export comments per organisation in both PDF and CSV formats.

Your dedicated repository worktree is `/home/dev/consultatie-organisation-exports`; perform all repository
inspection, edits, commits, pushes and MR commands there. Do not create another branch/worktree.

Start from current origin/main on a new branch. First inspect existing export UI, routes, authorization,
organisation grouping semantics, PDF export code, CSV conventions, and tests. Implement the smallest coherent
UX/API solution. Preserve privacy/access controls and avoid stacking on open MR !54. Define edge behavior for
unknown/empty organisation names and filename escaping based on existing product semantics. Add focused tests for
filter correctness, authorization, content/disposition, Unicode/CSV quoting, and zero-result behavior. Run
appropriate Go tests, race/vet/lint, frontend/build/E2E sanity proportional to changes.

Open a DRAFT GitLab MR only; do not run review-loop, mark ready, merge, tag, or deploy. Report branch, commits,
MR URL, design choices, test results, and any real blocker in notes/tasks/consultatie-organisation-exports-worker.md.
Use Codex only; do not invoke Claude.
