You are a fresh-context implementation worker for consultatie. Work only in
`/home/dev/consultatie-pdf-title-body` on branch `fix/pdf-title-body-annotation`, based on exact current
`origin/main` merge commit `e5f96faea0a6c17218ccb37b82ba980e31af00f3`.

Authoritative human report (Telegram msg 333051140): after MR !56, the yellow PDF highlight and attached comment
are missing when a single selected passage spans a title and the following body text. Exact reported selection:

`Wijziging ten opzichte van de vorige versie (versie 1.0) In de duiding bij de afspraak is tekst opgenomen met
betrekking tot de aandachtspunten voor de beoordeling van een data-afnemer. Deze waren in de vorige versie beperkt
tot aandachtspunten voor data-aanbieders. Daarnaast is de duiding aangepast in lijn met het hernieuwde
deelnameproces. Ook is het stuk over de beëindiging van inbreng van een dataset uit de afspraak gehaald en
verplaatst naar een nieuwe afspraak.`

Goal: reproduce the title→body spanning-selection failure on current main, identify the exact DOM/Typst/PDF mapping
cause, and implement the smallest robust fix. Add a generated-output regression that proves both the yellow
appearance is actually rendered (Poppler/pixel oracle where appropriate) and the linked comment content exists at
the correct title+body passage. It must fail before the fix. Preserve duplicate-quote, overlap, multiline,
multipage, organization-export, and fail-closed behavior.

Inspect repository guidance first. Do not use real/private consultation data; turn the supplied text into a safe
test fixture if needed. Run focused tests, then proportionate full race/vet/lint/nilaway/build checks. Keep the
tree clean. Push normally and open a DRAFT GitLab MR with a clear reproduction/root-cause/validation description.
Wait for its exact feature pipeline, including preview publication/render, to be fully green and verify preview
health. Do NOT run `review-loop`, mark ready, merge, delete branches, or touch unrelated work. Report exact commit,
MR URL, pipeline, tests, and any blocker in the normal worker output.
