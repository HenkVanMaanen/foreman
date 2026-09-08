# Mattermost thread agents — opt-in draft

Defaults: `FOREMAN_THREAD_AGENTS=0`, `FOREMAN_CHANNEL_MODE=auto`, `FOREMAN_MAX_THREAD_AGENTS=2`. No live configuration or deployment is included. After human review, the intended configuration is:

```dotenv
FOREMAN_THREAD_AGENTS=1
FOREMAN_CHANNEL_MODE=mattermost
FOREMAN_MAX_THREAD_AGENTS=50
MATTERMOST_TEAM=calabytes
MATTERMOST_CHANNELS=general,foreman-improvements
MATTERMOST_ALLOWED_USERS=<authorized usernames, comma separated>
```

Supply the existing base URL and bot token through the existing configuration/secret mechanism. Names resolve to IDs at runtime; no live IDs are shipped. `MATTERMOST_CHANNEL_ID` can replace team/channel names. `MATTERMOST_TARGET_USER` is the username fallback. Missing/unresolved humans fail closed, including in the legacy Mattermost reader (which previously accepted any non-bot user).

Modes apply to ingress, replies, ask-human and acknowledgements. `mattermost` never falls through to Telegram. `telegram` is emergency mode: resident ingress/replies only, with existing Mattermost jobs/outbox paused. `auto` preserves legacy selection and ask-human broadcast behavior. Reserved Telegram secret routes and raw capture retain their existing implementation; secret questions require Telegram enabled. This does not add Mattermost secret capture.

The existing single `wait-reply --inbox` caller owns ingress. A kernel lock prevents concurrent inbox consumers for one state directory. In feature mode, the poller persists authorized text posts to `state/thread-inbox/` before advancing each channel's cursor. Timestamp overlap and retained receipt IDs deduplicate replay and equal-timestamp posts. The supervisor scans receipts, recovering a crash between cursor advancement and stdout delivery. First activation starts at the current time; history, reactions, edits and attachment fetching are outside this draft.

Ordinary roots go to resident triage. Its bootstrap instructs it to interpret work requests and bind them automatically, after creating an isolated worktree:

```bash
thread-control bind mm:<channel>:<post> owner/repo /absolute/isolated/worktree
```

The command requires an authorized receipt and binds its channel and root, including accumulated replies. One worktree cannot belong to two bindings. Casual chat stays with the resident; after replying, it runs `thread-control dismiss mm:<channel>:<post>`. Undismissed casual receipts replay to the resident after restart. There is no keyword classifier or spawn-for-every-root rule. Bound follow-ups bypass resident triage.

`state/threads/registry.json` records bindings, pending/completed post IDs, status and explicit Codex session IDs. Each thread has one active turn; `FOREMAN_MAX_THREAD_AGENTS` caps concurrent agents at any positive JavaScript safe integer (up to `Number.MAX_SAFE_INTEGER`), default 2. The intended deployment sets 50, matching the existing detached-worker limit. Total conversation thread bindings are unlimited. Completed turns move to the back of the scheduling order. The existing adapter captures `thread.started.thread_id` immediately and uses that exact ID for resume, never `--last`. Local compatibility evidence: installed `codex-cli 0.153.4`, its exec/resume help, the existing JSONL parser, and mock CLI tests. Configured Codex extra arguments are retained, including defaults `--model gpt-6-astra -c model_reasoning_effort=xhigh` and overrides.

Each CLI holds a per-thread kernel lock. Surviving CLI locks count against the cap after restart. Interrupted batches replay with their saved session ID and an explicit warning to inspect existing side effects. A failed start/turn, missing session ID, nonzero exit or mismatched session retains messages and marks the thread failed. Other threads continue. After inspection, the resident can run `thread-control retry mm:<channel>:<post>`. Failures never trigger endless automatic fresh sessions. Detached-worker accounting and review-loop behavior are not reused.

Thread agents use `thread-reply` on PATH, with text on stdin, for progress/questions. Assistant output is posted after a successful turn. A question ends that turn; a new human message resumes it. Agents launched with the feature enabled have no inherited Mattermost/Telegram environment credentials; thread agents also lack the resident control capability. Detached spawn-worker launches strip bot tokens and the resident capability in either mode. Resident reply/ask-human calls proxy through an authenticated local supervisor endpoint, which retains credentials. Worker outboxes carry text only; the supervisor resolves channel/root from its registry and ignores destination fields in payloads. Failed sends remain queued. Final responses have stable per-batch outbox names.

Supervisor and worker replies share a per-thread outbox lock and durable `.order` list. Delivery follows publication order regardless of filenames or clocks; retrying a delivery ID retains its original reply and position, including its sent marker. Existing JSON files retain their names and payloads and are adopted in their recorded timestamp/mtime order. A crash between publishing a reply and recording its position is recovered before later replies can be queued or drained.

Repo policy defaults allow branch, branch push and draft PR. Merge, main pushes/edits, undraft, deploy, harness-sync and keeper edits default false. Each thread reads current policy before every turn. `thread-control policy-get owner/repo` is a public read. Only the resident endpoint accepts updates, for example:

```bash
thread-control policy-set mm:<channel>:<human-post> owner/repo '{"merge":true}'
```

The resident must verify the actual human grant for that repo; a worker's interpretation/request is insufficient. Both resident capability and authorized receipt are required. Atomic `FOREMAN_NOTES_DIR/policy/autonomy.json` contains repo policies and old/new/source-message audit. It lives in the foreman-state notes checkout and participates in normal persistence; this command does not run notes-sync or push. Changes reach active agents at their next turn. Policy is agent guidance, not a git/API enforcement proxy.

Shared filesystem and process identity are **not a strong hostile-worker isolation boundary**. A hostile process could read other processes/shared credentials or tamper with policy, registry and outboxes. Environment scrubbing and the local capability prevent normal accidental routing and unverified worker API updates; they do not provide OS isolation. Atomic writes cover process crashes, not power-loss durability. Turn side effects and outbound delivery are at-least-once: ambiguous HTTP success can produce a duplicate reply after retry, always in the registered thread. No retention/compaction, wall-clock job timeout or live Mattermost integration validation is included.

Quick checks: `bun run check`, `bun test test/unit.test.ts test/thread-agents.test.ts test/secret-replies.test.ts`, and `bash -n` on changed scripts. Tests use mock transports/CLI and temporary HOME/state; they do not launch real agents or supervisor lifecycle tests. Do not run review-loop before human approval of the draft.
