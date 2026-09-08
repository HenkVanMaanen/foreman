# Fix Telegram raw secret-capture race

Work in `/home/dev/foreman`. Diagnose why a reply to a `bin/ask-human` routing id is consumed by the resident
supervisor inbox and delivered to the model before/during `bin/wait-reply <id> --raw`, as happened for routing id
`q178886667123077`. The user cannot access the box, so a secure chat-to-encrypted-store capture must work.

Requirements:

- Read applicable repo instructions and the existing Mattermost adapter task notes/journal.
- Never read, reproduce, log, grep for, or store any user-supplied token values. Use only fabricated sentinel values
  in tests.
- Establish the precise ownership/race between supervisor polling, watermarks, question routing, and wait-reply.
- Implement the smallest robust mechanism ensuring replies to an active secret-capture routing id are reserved for
  the raw waiter and never included in model inbox prompts, including restarts/turn boundaries and failure cleanup.
- Add deterministic regression tests for simultaneous supervisor/waiter polling and restart behavior. Avoid a
  second competing poller if a single-owner routing design is safer.
- Preserve ordinary inbox/thread behavior. Do not touch `keeper.sh`.
- Run typecheck and focused/full relevant tests.
- Commit locally but do not push main or run `harness-sync`; this requires human approval. If appropriate, push a
  feature branch and open a draft GitHub PR only if existing repo autonomy allows it; otherwise stop with local commit.
- Write a concise result under `notes/tasks/` describing root cause, files changed, tests, commit and exact safe
  operator flow. Do not run a real capture until Foreman verifies the change.
