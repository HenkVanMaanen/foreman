# Exact end-to-end self-test for real title-to-body selector

Work in `/home/dev/worktrees/consultatie-exact-title-body-selftest`, based on commit `e016c84` from MR !58. Henk
explicitly requires us to test the real selection ourselves; do not ask him to retest. The repository already has
the exact heading in `testdata/content/voorbeeld.md` near lines 25 and 595. Use the exact title plus following
paragraph Henk provided in msg 333051150:

`Wijziging ten opzichte van de vorige versie (versie 1.0) In de duiding bij de afspraak is tekst opgenomen met
betrekking tot de aandachtspunten voor de beoordeling van een data-afnemer. Deze waren in de vorige versie beperkt
tot aandachtspunten voor data-aanbieders. Daarnaast is de duiding aangepast in lijn met het hernieuwde deelnameproces.
Ook is het stuk over de beëindiging van inbreng van een dataset uit de afspraak gehaald en verplaatst naar een nieuwe
afspraak.`

First prove whether current `e016c84` places this exact selector when generating the REAL PDF from the matching
sample document through Pandoc/Typst/pdfcpu. Inspect/assert the selected text coverage across the heading/body style
boundary, yellow highlight appearance, non-empty correct QuadPoints across all required lines/pages, popup/comment
linkage, and absence from unmatched/endnotes. This must be a deterministic automated regression, not a mocked
planner-only test. Ensure it would fail if the annotation were missing/truncated.

If current code fails, diagnose and implement the smallest real root-cause fix, rerun the exact test plus focused
and full quick checks. If it passes, commit the exact regression test alone and clearly report that the earlier
artifact came from a different input/runtime path; still provide generated evidence. Commit locally on branch
`test/pdf-exact-title-body-selector`, but DO NOT push or open another MR because another worker is changing MR !58;
foreman will integrate the commit after the chart-label fix. Do not run review-loop or merge. Write status to
`/home/dev/foreman/notes/tasks/consultatie-exact-title-body-selftest.md` and standard result JSON.
