Fresh Codex task in /home/dev/worktrees/consultatie-complete-export-placement-audit, branch fix/complete-export-comment-placement, draft MR !59 at head 0a439db.

Exact pipeline 2820147146 test job failed in clean GitLab CI while local race tests passed:
TestAnnotateQuadPoints -> blankTwoPagePDF -> api.Create(nil config) -> pdfcpu model.NewDefaultConfiguration -> `config problem: invalid validationMode:`. The new popup tests added around commit 0a439db use t.Parallel and also exercise pdfcpu configuration; inspect whether concurrent default-config creation or shared pdfcpu config-dir state makes the tests non-hermetic. Fetch trace if needed. Reproduce in a clean temporary HOME/config environment and under repeated/race runs. Implement the smallest test-hermetic fix; do not weaken assertions or alter production behavior unless evidence requires it. Check existing pdfcpu test helpers/config handling for established pattern.

Run focused repeated/race tests plus full `go test ./... -race -count=1`, lint/nilaway, and build. Commit and push to existing branch/MR, keep draft. Do not review-loop or merge. No private data in repo. Update task worker note and result JSON.
