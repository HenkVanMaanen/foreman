You are fixing a user-reported bug on the existing Consultatie issue #4 draft MR.

Repo/worktree: /home/dev/consultatie-wt/issue-4
Branch: feat/issue-4
MR: https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/47
User report (Henk msg 333051049): clicking “export reactions” does nothing.

Work only in this worktree and existing branch/MR. Preserve the existing untracked notes/ directory and all
unrelated user changes. Reproduce the browser/UI flow first, then diagnose the real cause. Fix the export click
and download path without weakening validation or silently swallowing errors. Add focused regression coverage
at the appropriate level, run relevant tests plus the proportionate full checks, commit, and push to the existing
branch. Verify the remote MR head. Do not create another MR, run review-loop, un-draft, merge, deploy, or modify
notes outside this worktree. Report the exact cause, changes, tests, commit SHA, and any residual risk.
