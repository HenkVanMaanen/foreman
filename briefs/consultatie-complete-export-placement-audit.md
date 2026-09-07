# Consultatie exhaustive PDF/comment placement audit and fix

You are a fresh-context senior engineer working in a dedicated consultatie worktree. Read repository guidance.

Authoritative human task: investigate the supplied original displayed document, full all-organisations PDF, and
all-comments CSV. Many comments are reportedly absent from the PDF, attached to unrelated sentences, or placed on
blank pages. Use browser/rendered screenshots and any appropriate PDF/source tooling. Determine what is actually
wrong, prove root causes exhaustively, and implement a narrow robust fix with regressions if evidence supports it.

Private inputs (never commit/copy into repo, never expose raw potentially sensitive content in logs/notes/MR):
- `/tmp/consultatie-complete-export-20260904/document.md.rtf` (317155 B; RTF despite name)
- `/tmp/consultatie-complete-export-20260904/reacties_all.pdf` (644001 B; PDF 1.7, 2 pages)
- `/tmp/consultatie-complete-export-20260904/reacties_all.csv` (507062 B, UTF-8)

Required investigation:
1. Establish what each artifact contains and whether the supplied PDF is the annotated document or a response
   report. Parse safely. Quantify CSV rows, unique selectors/comments, PDF annotations/pages, matched/missing/
   misplaced/blank-page cases, and reconcile identifiers/quotes where possible.
2. Convert the RTF to faithful plain/source text without destructive assumptions; inspect its actual structure.
3. Exercise the real current production-equivalent export pipeline from clean `origin/main` using the inputs or a
   privacy-safe derived fixture. Use browser automation when useful. Render PDF pages to images, inspect screenshots,
   PDF objects/QuadPoints/AP/linkage and text geometry. Preserve a small private evidence directory under `/tmp`.
4. Classify symptoms by root cause. Distinguish source selector drift, repeated quotes/overlaps, RTF/control-marker
   projection, pagination/coordinate errors, report-vs-document confusion, and intentionally unmatched endnotes.
5. Add privacy-safe synthetic regressions for every demonstrated bug. Implement the narrowest general fix; do not
   weaken occurrence/context safety and do not add fuzzy matching that can silently target unrelated text.
6. Run focused tests, full relevant Go tests/race where appropriate, vet/lint/nilaway, and any real PDF/browser
   checks. Produce before/after quantitative reconciliation and screenshot paths.
7. Work in small commits. Push branch and open a DRAFT GitLab MR only after evidence and sanity checks. Do NOT run
   review-loop, merge, or alter production. MR description must contain no raw supplied content/private data.

Keep the orchestrator responsive: write detailed progress/status to
`/home/dev/foreman/notes/tasks/consultatie-complete-export-placement-audit-worker.md`, and finish with exact commits,
tests, artifact/evidence paths, counts, remaining uncertainty, branch/MR URL. If blocked, document exactly what is
missing and continue every safe analysis that does not require it.
