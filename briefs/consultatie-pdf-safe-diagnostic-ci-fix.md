# Fix CI failures on consultatie draft MR !58

Work in `/home/dev/worktrees/consultatie-pdf-title-body-safe-diagnostic` on branch
`chore/pdf-unmatched-safe-diagnostic` at `ae132e4`. Draft MR:
https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/58.

The exact-head pipeline `2813618267` has green tests/Helm but failed lint and nilaway. Fix all findings cleanly,
without weakening/removing privacy gating or diagnostics and without broad nolint suppressions unless narrowly and
rigorously justified:

- nilaway: possibly nil `safeDiagnostics` passed then sliced in `completeDetectionTextDiagnostics` and
  `completeGeometryDiagnostics`.
- funlen: `generate` 48 > 40 statements; refactor coherent diagnostic work out.
- goconst: repeated `geometry_not_detected` and `matched` outcomes.
- gosec G204: variable-path `pdftotext` subprocess; use the established binary/config mechanism or a narrowly
  justified safe executable contract, not arbitrary input.
- paralleltest: diagnostic tests and subtests must be parallel-safe/parallelized.
- revive: unused test param and explicit inferred function type.

Run the exact relevant lint/nilaway commands if tooling is available, plus focused tests/full quick tests. Commit
and push to the same branch. Do not open a new MR, do not run review-loop, and do not merge. Verify the replacement
exact-head pipeline is created and record status in `/home/dev/foreman/notes/tasks/consultatie-pdf-title-body-safe-diagnostic.md`
plus standard result JSON for worker id `consultatie-pdf-safe-diagnostic-ci-fix`.
