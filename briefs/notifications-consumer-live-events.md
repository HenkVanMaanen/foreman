# Task: fix notifications consumer UI live events

Work as an autonomous senior engineer in the Simulation repository worktree supplied as your current directory.

Authoritative request: Henk Telegram msg 333051196 says that when the notifications consumer Web UI is already
open and an event is created through the publisher, the consumer UI only shows it after a manual page refresh.
He suspects WebSockets but asks us to investigate and create an MR.

Requirements:

1. Start from the already-created branch `fix/notifications-consumer-live-events`, based on current origin/main.
2. Read repo instructions completely. Inspect and reproduce the actual publisher -> consumer storage -> browser
   live-update flow. Do not assume WebSockets are the fault; identify the root cause with evidence.
3. Implement the smallest robust fix so an already-open consumer UI displays newly received events without manual
   refresh. Preserve existing behaviour and avoid unrelated cleanup.
4. Add focused regression tests that would fail before the fix and exercise the relevant real boundary as closely
   as practical. Run proportionate package/full tests and lint/build sanity checks.
5. Commit and push the branch, then open a DRAFT GitLab MR against main. Use a concise description including root
   cause, fix, verification, and any deployment/runtime considerations. Do NOT run review-loop, undraft, merge, or
   mutate a live cluster.
6. Wait for the exact-head GitLab pipeline and address ordinary failures caused by your change. Confirm the MR head
   SHA equals the tested pipeline SHA.
7. Update `/home/dev/foreman/notes/tasks/notifications-consumer-live-events.md` with findings, branch/MR/SHA,
   commands/results, pipeline URL/status, and any remaining caveats. Write a result JSON through the worker harness.

Keep credentials and user data out of commits and logs. Do not modify unrelated existing worktrees.
