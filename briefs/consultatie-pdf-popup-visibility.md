# Consultatie PDF popup visibility regression on MR !59

Work in `/home/dev/worktrees/consultatie-complete-export-placement-audit`, branch `fix/complete-export-comment-placement`, current pushed head `7bf2ae2`, draft MR https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/59.

Human feedback (authoritative msg 333051165): the yellow marking for annotation `01a04005-13d2-76a9-8321-7804ba88dc82` now appears correct, but the popup with the correct VNG comment is not visible to him in the proof PDF `/tmp/consultatie-evidence/repro_after2.pdf`.

Investigate as a real remaining bug; do not treat mere existence of `/Popup` as sufficient. Read repo guidance and the existing task notes. Private inputs/evidence stay under `/tmp` and must never be committed or quoted in MR/tests.

Required:

1. Reproduce popup interaction/visibility in realistic PDF viewers available on-box (browser PDF.js/Chromium if possible, plus structural inspection with pdfcpu/qpdf/pypdf). Capture private screenshots/evidence.
2. Compare the target VNG annotation with known-working visible comments in the same supplied/reconstructed PDF. Inspect `/Highlight`, `/Popup`, `/Parent`, `/Contents`, `/NM`, `/M`, flags, rects, Open state, page annotation arrays, appearance, encoding, and any link/destination behavior. Establish whether the correct comment is merged under another annotation or hidden by overlap/annotation ordering.
3. Determine whether user interaction requires clicking a particular overlapping highlight and whether that is unacceptable/ambiguous. The target selection overlaps many other highlights; verify which annotation wins hit testing.
4. Implement the narrowest general fix if evidence supports one. Preserve correct yellow geometry, privacy, safe matching, and existing behavior.
5. Add privacy-safe synthetic regression(s) that prove comment visibility/hit-test reachability, not merely object presence. Run focused/full relevant tests, race, lint/nilaway/build as appropriate.
6. Push updates directly to the existing draft MR !59. Do not run review-loop, un-draft, or merge.
7. Generate a new private proof PDF under `/tmp` that Foreman can send Henk. Record exact page/action needed to open the target comment and screenshot paths.
8. Update `/home/dev/foreman/notes/tasks/consultatie-complete-export-placement-audit-worker.md` and write result JSON for worker id `consultatie-pdf-popup-visibility-codex` last.

If viewer tooling cannot reproduce interaction, exhaust structural/hit-order analysis and state the exact limitation; do not claim fixed without viewer proof.
