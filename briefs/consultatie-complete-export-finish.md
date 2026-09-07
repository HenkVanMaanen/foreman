# Finish and independently verify existing consultatie PDF fix

Work in `/home/dev/worktrees/consultatie-complete-export-placement-audit` on branch `fix/complete-export-comment-placement`.

The prior investigation/implementation worker hit its provider session limit before committing. Independently inspect all existing changes; do not trust them blindly. Read repository guidance plus:

- `/home/dev/foreman/notes/tasks/consultatie-complete-export-placement-audit.md`
- `/home/dev/foreman/notes/tasks/consultatie-complete-export-placement-audit-worker.md`

Private evidence is under `/tmp/consultatie-evidence` and inputs under `/tmp/consultatie-complete-export-20260904`; never commit or expose private/raw data.

Required:

1. Review the production diff and four intended privacy-safe tests for correctness, scope, security, and maintainability. Remove any accidental/debug content.
2. Confirm the exact acceptance case annotation `01a04005-13d2-76a9-8321-7804ba88dc82` in `/tmp/consultatie-evidence/repro_after2.pdf` is a real yellow `/Highlight` with linked popup over the intended RE006 heading+paragraph, not merely an endnote. Do not include real content or identity in tests/MR.
3. Classify the six `verify2.py` mismatches rather than assuming they are product failures; fix only demonstrated production defects. Preserve safe occurrence/context matching.
4. Run focused tests, full relevant tests, build, race tests where proportionate, vet/lint/nilaway. Confirm tests fail under relevant mutations if practical.
5. Ensure `git diff` contains only intended production code and synthetic tests and no private filenames/data.
6. Commit in reviewable increments, push branch, and open a DRAFT GitLab MR against `main`. Do not run review-loop and do not merge.
7. Update `/home/dev/foreman/notes/tasks/consultatie-complete-export-placement-audit-worker.md` with exact findings, before/after counts, tests, commits, and MR URL. Write result JSON for worker id `consultatie-complete-export-finish-codex` as the last action.

Human-approved final review/merge has not happened. Stop at draft MR.
