# Task: remove Henk's personal attribution from Standaard Radar README

Authority: Henk Telegram msg 333051219 says his name and Telegram handle appear in the Standaard Radar README and
asks for their removal.

Worktree `/home/dev/worktrees/standaard-radar-readme-pii`, branch `fix/remove-readme-personal-info`, current
Standaard Radar main. Inspect `AGENTS.md` first.

Scan the entire tracked current tree for Henk's real-name attribution and Telegram handle, without emitting the
sensitive strings in logs/notes/MR text. Remove every current occurrence minimally, focusing on README/docs. Use
git blame/log to determine which commit added it and whether it came from foreman-generated work, but never repeat
the values in your report. Do not rewrite history. Run relevant formatting/lint/docs tests. Commit, push, and open a
DRAFT MR whose description says only that unintended personal attribution/contact details were removed. No review
loop or merge. Report MR URL, exact files/lines removed, remaining current-tree matches count, origin commit, and
whether historical purge would require a separate destructive operation.
