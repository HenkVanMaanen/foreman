# Task: final Codex-only gate and merge consultatie MR !55

Source authorization: Henk Telegram msg 333051137 explicitly says “ok merge 55 en 56”. This task covers MR !55
only. Work in `/home/dev/consultatie-organisation-exports` on branch `feat/organisation-pdf-csv-exports`.

Before acting, fetch and verify local HEAD, upstream branch, MR !55 SHA, and successful head pipeline all agree.
Expected starting SHA is `3221257128200dbb788faddb17c528d6014b9742`; stop and report if scope diverged unexpectedly.

Run the expensive final gate exactly once at this approved stage using only Codex phases:

`FOREMAN_REVIEW_ENGINE=codex FOREMAN_REVIEW_CROSSCHECK=off /home/dev/foreman/bin/review-loop --dir .`

Interpret verdict per policy. CLEAN means proceed. NEEDS-AI means make the in-scope fixes, run proportionate tests,
commit/push, wait for the exact pipeline, and rerun the Codex-only gate until CLEAN. NEEDS-DECISION means stop and
report the precise human choice. FAILED means rerun the gate; never treat silence as approval. Do not use Claude.

Once CLEAN, ensure every gate-created change is committed and pushed, verify the exact head pipeline succeeds,
mark MR !55 ready, merge it with the normal project merge method, and report merge SHA plus main pipeline URL/status.
If the main pipeline is still running, return its id/status for foreman monitoring. Do not touch MR !56 or deploy
manually. Preserve unrelated files and do not alter foreman notes.
