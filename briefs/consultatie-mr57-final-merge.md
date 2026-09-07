You are a fresh-context final-review-and-merge worker for consultatie MR !57. Work only in
`/home/dev/consultatie-pdf-title-body` on branch `fix/pdf-title-body-annotation`.

Authoritative human approval: Telegram msg `333051141`: "ja dat werkt nice, mergen maar". The human tested the
live preview and explicitly approved merge. MR: https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/57
Expected exact feature head is `a7b9a7494a6890e8879aa6f56b25f3354f5a1fa3`; its pipeline `2813293307` was
fully green including preview publication/render, and preview health returned 200 ok.

First verify clean tree, exact local/remote/MR identity, current target main, conflicts/discussions, and whether
main advanced. If main advanced, merge current origin/main normally (never rewrite history), run proportionate
tests, and treat the new merged tree as requiring the final gate below.

Run the mandatory final gate exactly once using Codex only:
`FOREMAN_REVIEW_ENGINE=codex FOREMAN_REVIEW_CROSSCHECK=off /home/dev/foreman/bin/review-loop --dir .`
Never use Claude. CLEAN is required. If NEEDS-AI, address all findings yourself and rerun until CLEAN. Only
NEEDS-DECISION is a human escalation; FAILED means rerun the gate. Commit any gate changes, run focused/full
proportionate tests, and push normally.

Wait for the exact reviewed feature-head GitLab pipeline to be fully green, including preview image/chart and
render. Mark the MR ready, recheck exact SHA/no conflict/no unresolved discussion, then merge with SHA protection.
Verify merged state and exact merge commit. Monitor the resulting exact main pipeline until every required job,
including production image/chart publication, is green. Do not delete branches explicitly, force-push, or touch
unrelated work. Report exact reviewed SHA, gate verdict/findings, feature pipeline, merge commit, and main pipeline.
