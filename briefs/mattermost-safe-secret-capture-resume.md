# Resume and finish existing secret-capture race fix

Work ONLY in the already-existing worktree `/home/dev/foreman/worktrees/telegram-secret-capture` on branch
`fix/telegram-secret-capture-race`. Do not create any worktree or branch. A previous Codex worker was interrupted
by a harness turn boundary after editing:

- `examples/agent-bin/ask-human.sh`
- `examples/agent-bin/wait-reply.sh`
- `src/inbox.ts`
- new `src/secret-replies.ts`
- new `test/secret-replies.test.ts`

Review those uncommitted changes carefully against the original brief
`/home/dev/foreman/briefs/mattermost-safe-secret-capture-race.md`. Finish the implementation and deterministic
tests. Never inspect or reproduce real token values; fabricated sentinels only. Ensure reserved secret replies
cannot reach model inbox prompts under simultaneous polls or restart, ordinary inbox behavior remains unchanged,
failure cleanup is safe, and stored artifacts contain metadata/ciphertext only. Run typecheck plus focused and full
relevant tests. Commit locally on the existing branch. Do not push, open a PR, run `harness-sync`, or touch main.
Write the requested handoff note/result, then stop.
