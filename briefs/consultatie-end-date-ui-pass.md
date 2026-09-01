# Consultation end-date UI screenshot and polish pass on MR !50

Work only in `/home/dev/consultatie-end-date` on existing branch `feat/consultatie-end-date`, head
`75b4e7fc`, draft MR https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/50.
Henk requested in msg 333051100: "maak screenshots van de einddatum etc en check of het nog wat
mooier vormgegeven kan worden". This is human iteration on the existing draft, not approval to merge.

Mandatory workflow:
- Read repo instructions. Do not run review-loop and do not merge.
- Preserve all existing functionality and the central deadline-store design.
- Use the actual running app with mock OIDC and realistic consultation rows; do not fabricate static
  HTML screenshots.
- Capture clear screenshots before changing UI and after the final UI at desktop and mobile widths.
- Store shareable final PNGs under `/home/dev/foreman/state/consultatie-end-date-ui/` with concise names.
  Keep scratch/before images there too, not in the repo. Do not commit screenshot artefacts unless an
  existing visual-test baseline intentionally needs updating.

Inspect at minimum:
1. `/beheer/documenten`: existing Git consultation with an editable deadline, one closed status and
   preferably one open/no-deadline row. Capture desktop and mobile.
2. Participant document view while open and while closed, showing how the end-date/status message and
   disabled/hidden interaction controls read. Capture desktop and mobile where useful.
3. Date form semantics: label, help text, save/clear affordances, current status, date formatting,
   spacing, hierarchy, responsive wrapping, keyboard focus, and screen-reader text.

Polish only where the screenshots demonstrate a real problem. Prefer small, coherent improvements:
- make the deadline/status a scannable grouped control rather than loose text;
- clearly distinguish Open / Sluit op DATE / Gesloten since DATE without color alone;
- make setting/changing and clearing the date obvious but not visually noisy;
- improve narrow-screen wrapping and tap targets;
- retain the app's existing design language and Dutch copy.
Avoid a broad admin redesign.

Validation:
- Update/add focused template or web tests for changed behavior/copy.
- Run formatting, relevant Go tests/lint/build, focused Chromium admin/closed consultation flows, and
  focused visual tests. Update only intentional baselines and explain them.
- Inspect final screenshots yourself and compare before/after.
- Commit and push the existing branch/MR only when the pass is coherent and checks are green.
- Update `/home/dev/foreman/notes/tasks/consultatie-end-date.md` with head, UI changes, validation, and
  screenshot paths. Write standard result JSON for id `consultatie-end-date-ui-pass`.
- Do not run review-loop, do not merge, and do not ask Henk to approve until foreman has sent him the
  final screenshots.
