# Implement focused end-date UI polish on MR !50

Work only in `/home/dev/consultatie-end-date`, existing branch `feat/consultatie-end-date`, head
`75b4e7fc`, MR !50. Prior screenshot worker stalled after analysis and made no repo edits.

Read repo instructions, then inspect these actual before screenshots yourself:
- `/home/dev/foreman/state/consultatie-end-date-ui/before-admin-desktop.png`
- `/home/dev/foreman/state/consultatie-end-date-ui/before-admin-mobile.png`
- `/home/dev/foreman/state/consultatie-end-date-ui/before-closed-desktop.png`
- `/home/dev/foreman/state/consultatie-end-date-ui/before-closed-mobile.png`

The foreman independently confirmed:
1. Mobile `/beheer/documenten` table clips horizontally; deadline controls and share/export actions
   are inaccessible off-screen. This is the primary bug.
2. Desktop deadline status/form is cramped in a table cell and not very scannable.
3. Closed participant desktop shows two prominent blue closure notices (page-wide and sidebar),
   creating redundant visual weight. Keep the information and accessible semantics, reduce duplication.
4. Existing visual language already uses badges and copy such as `Open tot en met …` and
   `Gesloten sinds …`; reuse it.

Implement now—do not spend another long analysis cycle:
- Make document rows responsive. A mobile card/stacked layout is preferred if it keeps all actions
  reachable with clear labels; desktop may remain table-like or use a coherent grid. Do not merely add
  a horizontal scrollbar as the only fix.
- Group status, human-readable deadline, date input, and save/clear affordance into a clear consultation
  control. Use explicit Dutch copy and ≥44px tap targets where feasible.
- If no deadline: communicate `Open - geen einddatum` (or equally clear house-style copy).
- If future deadline: `Open` plus `Reageren kan tot en met DD-MM-YYYY`.
- If closed: `Gesloten` plus `Gesloten sinds DD-MM-YYYY`.
- Keep a date input usable for setting/changing; clearing must be obvious and safe. Avoid JS if standard
  form controls suffice.
- On participant view, retain one primary closed message and a compact sidebar status rather than two
  equally prominent alerts.
- Keep scope limited to end-date/status/document-row presentation.

Use the already-running app on `http://localhost:8096` if available; restart with mock OIDC if not.
Create a valid open screenshot using an actual title found on `/` (not `Afsprakenstelsel FDS`). Capture
final desktop/mobile admin, closed participant, and open participant screenshots to
`/home/dev/foreman/state/consultatie-end-date-ui/after-*.png`. Inspect every final image yourself.

Add focused tests, run formatting + relevant Go/lint/build, focused mock-OIDC Chromium consultation
flows, and focused visual checks. Update only intentional baselines. Commit/push the existing branch/MR.
Do not run review-loop and do not merge. Update the task note and write result JSON for id
`consultatie-end-date-ui-implement`.
