# Fix MR !50 e2e-ui visual baseline

Work in `/home/dev/consultatie-end-date` on `feat/consultatie-end-date`. MR:
https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/50

Exact-head pipeline 2804989938 failed only job e2e-ui 16201264605. Behavior tests and desktop visuals passed;
mobile `e2e/visual/app.spec.ts:27` document list failed consistently because expected 393x727, actual 393x786,
6510 pixels / ratio 0.03. This is expected from the new per-document open/closed status line.

Inspect the CI artifact/diff if useful, reproduce the visual-mobile document-list test in the repository-native
environment, and update ONLY the intended Linux mobile snapshot. Verify the new baseline visually or by precise
diff evidence; ensure no unexpected content/layout regression. Run the focused visual test and any quick relevant
sanity check. Commit and push to the existing branch/MR. Do not run final review-loop and do not merge. Return exact
head, changed snapshot path, commands/results, and whether a new pipeline started.
