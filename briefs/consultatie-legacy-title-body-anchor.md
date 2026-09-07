# Diagnose/fix legacy stored title→body PDF selector

Repo/worktree: `/home/dev/worktrees/consultatie-legacy-title-body-anchor`
Branch: `fix/pdf-legacy-title-body-anchor`, based on MR !58 head `efb980a`.

Authoritative bug: Henk's existing production comment selects the RE006 heading
"Wijziging ten opzichte van de vorige versie (versie 1.0)" plus its complete following paragraph, but his
downloaded PDF has neither yellow highlight nor linked comment for it. Private artifact (never commit/copy into
repo): `/tmp/consultatie-title-body-bug-20260902.pdf`, sha256
`bb12c778983fbff831c1f28db591c38e083e374beebd893a595d4c38da3b612e`.

Important new evidence:
- Current full-context regression at `dd592e9` uses all rendered `voorbeeld.md` text, real UTF-16 offset and
  prefix/suffix and passes unchanged product code with 5 quads.
- Foreman also created a real selector online on the live MR preview from `#doc.textContent`: start 903, end 1376,
  exact length 473. Download `/tmp/consultatie-preview-exact-title-body.pdf` visibly highlights full heading and
  paragraph and has object 1361 with 5 quads/popup.
- Henk supplied a flattened visible quote reportedly ~480 chars; artifact analysis found its normalized visible
  passage (~471 chars) in page text but the comment landed unmatched. The original stored selector/documentText
  are not in the PDF.

Task:
1. Inspect current matching pipeline and both PDFs. Determine plausible legacy stored-anchor shape(s), especially
   browser Selection.toString/block-whitespace/footnote marker differences versus current textContent slicing.
2. Build a regression that faithfully creates a legacy selector variant from the same RE006 DOM/rendered content
   and fails before the fix. Do not accept a guessed fix without a red reproduction closely matching the known
   lengths/text behavior.
3. Implement the smallest backward-compatible fix that preserves occurrence/context disambiguation and avoids
   moving ambiguous comments. Verify full title+paragraph 5-quads/yellow/popup/no-endnote, plus existing tests.
4. Run focused/full tests, vet, templ, golangci-lint, nilaway as appropriate.
5. Commit locally only. Do not push, open MR, run review-loop, or expose private PDF/content in repo/logs. Write a
   concise handoff with exact reproduced legacy difference, fix, checks, and commit hash. If evidence is
   insufficient, stop with the exact blocker rather than guessing.
