# Task: download current MR !56 preview PDF for Henk

Source: Henk Telegram message 333051136 explicitly asks us to download the PDF and send it to him for checking.

Work read-only in `/home/dev/consultatie-pdf-rasterless`. Do not edit, commit, push, review, merge, or un-draft.
The preview is `https://consultatie-perf-pdf-contentstream-geometry.simulatie.datastelsel.nl` and the deployed
GitOps image/chart is exact commit `39f7060f`. Use the real browser/mock-IdP flow as `PDF Testgebruiker`, open the
seeded document with 1,000 reactions, trigger the current “PDF met mijn opmerkingen” download, and save the
result outside the repo at `/tmp/consultatie-39f7060-1000-reacties.pdf`. Verify it is a nonempty valid PDF, report
its size/page count and exact path, and do not inspect or expose any secrets. This preview contains seeded test
data only. Stop after returning the artifact path; the foreman will send it to Telegram.
