You are the fresh-context implementation/release worker for consultatie MR !56. Work only in
/home/dev/consultatie-pdf-rasterless on branch perf/pdf-contentstream-geometry. Henk explicitly approved merging
MR !56 in Telegram msg 333051137. MR !55 has already merged to main as
5e0d20cbc615c690b9c5de6c3d65e6b3483f1845. You are authorized to reconcile, commit, push, mark ready, and merge
!56, but only after every gate below is satisfied.

Required sequence:
0. Important known provenance: a first worker launched for this same approved task already performed the clean
   merge and created local commit `9571b3353b56819d6614ef95613960f796edefb6`, whose parents are exact remote
   feature head `39f7060f6a7bd9a84b2cf8607d8be2643b262e4f` and exact origin/main
   `5e0d20cbc615c690b9c5de6c3d65e6b3483f1845`. Foreman observed that action live and independently verified the
   reflog, parents, clean worktree, and unchanged remote. You are explicitly authorized to accept `9571b335` as
   the reconciliation baseline. Do not stop merely because it is ahead of the remote; that ahead state is the
   intended result of step 1. Re-fetch and verify those identities, then continue with inspection/testing.
1. Confirm the worktree is initially clean and remote-equal. Fetch origin/main and merge current origin/main into
   the feature branch without rewriting history. For this resumed worker, the provenance check in step 0 replaces
   the pre-merge remote-equality check because the authorized merge already exists locally. Resolve any actual
   conflicts by preserving both !55 organization exports and !56 rasterless geometry/visible annotation behavior.
   Do not rebase or force-push.
2. Inspect the resulting diff and run proportionate focused checks plus full Go tests, vet, golangci-lint,
   nilaway, build, and the Poppler-visible annotation regression. Fix real integration regressions, commit them.
3. Run the expensive final gate exactly once the reconciled content is settled, Codex only:
   FOREMAN_REVIEW_ENGINE=codex FOREMAN_REVIEW_CROSSCHECK=off /home/dev/foreman/bin/review-loop --dir .
   Handle NEEDS-AI findings yourself and rerun to CLEAN. NEEDS-DECISION is the only human escalation. Never use
   Claude review. Commit any gate fixes and ensure the final reviewed tree is clean.
4. Push the exact reviewed head normally. Wait for the exact-head GitLab pipeline to finish fully green,
   including preview publication/render. If code changes after review, rerun the Codex-only gate before pushing.
5. Immediately before merge verify MR !56 still points to the exact reviewed green SHA, has no conflicts, and all
   discussions are resolved. Mark ready, then merge with the supported glab command using --sha and -y. Do not
   delete the source branch unless normal project practice clearly does so.
6. Verify the merged MR state, merge commit SHA, and resulting main pipeline. Poll the main pipeline through all
   validation/build/publish jobs to success. Report exact SHAs and pipeline URLs.

Keep polling intervals short and do not touch unrelated work. If GitLab runner capacity delays jobs, continue
waiting. The independent !55 main pipeline may still be running; that is not a review-loop overlap and does not
block this reconciliation because its merge commit is already origin/main. Write a concise final result to your
normal worker output and exit only after completion or a genuine blocker.
