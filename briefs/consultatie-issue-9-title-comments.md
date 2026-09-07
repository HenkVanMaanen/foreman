You are the implementation worker for consultatie GitLab issue #9.

Work only in `/home/dev/worktrees/consultatie-issue-9-title-comments` on branch `fix/issue-9-title-comments`, based on current `origin/main` at `b084ecb`.

Issue: https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/work_items/9
Dutch report: "in de consultatie app als beheerder ingelogt, in de werkbank zie ik geen commentaar wat op bijv. titels is gegeven." Henk wants this fixed.

Investigate the actual beheer/werkbank query and rendering path and reproduce why comments whose selected range includes or targets a title are not shown. Trace stored W3C selector/title ranges through backend mapping and UI. Implement the smallest correct fix with focused regression tests, including a title-only comment and, if relevant, title-to-body selection. Preserve authorization/privacy and existing ordering/grouping. Run focused tests and a reasonable quick full sanity check. Commit and push the branch, then open a DRAFT MR referencing issue #9. Do not run `/home/dev/foreman/bin/review-loop`; Henk must approve content first. Do not merge. Record progress/result in `/home/dev/foreman/notes/tasks/consultatie-issue-9-title-comments.md`, then run `/home/dev/foreman/bin/notes-sync` after meaningful note updates. Return the MR URL, commit, root cause, changed behavior, and test evidence.
