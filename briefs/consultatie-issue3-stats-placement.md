Refine the existing Consultatie issue #3 draft MR based on Henk msg 333051051.

Repo/worktree: /home/dev/consultatie-wt/issue-3
Branch: feat/issue-3
MR: https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie/-/merge_requests/46
Feedback: Can statistics be displayed somewhere else, perhaps inside the Werkbank when a document is opened?
Add more statistics, e.g. unique persons per organization and other useful metrics.

Foreman recommendation already sent: put detailed contextual statistics in the opened document Werkbank view,
keep only a compact response total in the document list, and add unique respondents overall/per organization,
response counts per organization, and organization coverage—only where the domain has a stable truthful identity
key. Inspect the actual UX and data model before editing. Implement the best coherent version of that direction;
do not invent identity semantics or expose personal data. Preserve accessibility/responsiveness and existing
design conventions. Add focused unit/render/browser coverage as appropriate, run proportionate relevant and full
checks, commit, push to the existing branch, and verify MR head. Preserve the existing untracked notes/ directory
and unrelated changes. Do not create another MR, run review-loop, un-draft, merge, or deploy. Report exact UX,
metric definitions/denominators, tests, commit SHA, and any identity limitation.
