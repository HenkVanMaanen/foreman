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

Each CLI holds a per-thread kernel lock. Surviving CLI locks count against the cap after restart. Interrupted batches replay with their saved session ID and an explicit warning to inspect existing side effects. A failed start/turn, missing session ID, nonzero exit or mismatched session retains messages and marks the thread failed. Other threads continue. After inspection, the resident can run `thread-control retry mm:<channel>:<post>`. Failures never trigger endless automatic fresh sessions. Thread scheduling does not reuse detached-worker accounting or review-loop admission logic.

Thread agents use `thread-reply` on PATH, with text on stdin, for progress/questions. Assistant output is posted after a successful turn. A question ends that turn; a new human message resumes it. Agents launched with the feature enabled have no inherited Mattermost/Telegram environment credentials; thread agents also lack the resident control capability. Detached spawn-worker launches strip bot tokens and the resident capability in either mode. Resident reply/ask-human calls proxy through an authenticated local supervisor endpoint, which retains credentials. Worker outboxes carry text only; the supervisor resolves channel/root from its registry and ignores destination fields in payloads. Failed sends remain queued. Final responses have stable per-batch outbox names.

Supervisor and worker replies share a per-thread outbox lock and durable `.order` list. Delivery follows publication order regardless of filenames or clocks; retrying a delivery ID retains its original reply and position, including its sent marker. Existing JSON files retain their names and payloads and are adopted in their recorded timestamp/mtime order. A crash between publishing a reply and recording its position is recovered before later replies can be queued or drained.

Repo policy defaults allow branch, branch push and draft PR. Merge, main pushes/edits, undraft, deploy, harness-sync and keeper edits default false. Each thread reads current policy before every turn. `thread-control policy-get owner/repo` is a public read. Only the resident endpoint accepts updates, for example:

```bash
thread-control policy-set mm:<channel>:<human-post> owner/repo '{"merge":true}' --repo-wide
```

The resident must verify an explicit **repository-wide** human grant; a worker's interpretation/request is insufficient. Widening a policy requires `--repo-wide` in addition to the resident capability and authorized receipt. The flag declares scope, not proof of consent: the resident still reads the actual source. Revocations do not require the flag. Atomic `FOREMAN_NOTES_DIR/policy/autonomy.json` contains repo policies and old/new/source-message audit. It lives in the foreman-state notes checkout and participates in normal persistence; this command does not run notes-sync or push. Changes reach active agents at their next turn. Policy is agent guidance, not a git/API enforcement proxy.

## Approval and agent-owned review/merge for one PR

When a bound human says “merge it”, the worker requests verification using the original receipt, exact PR/MR URL, starting head and requested actions:

```bash
thread-control approval-request mm:<channel>:<human-post> https://github.com/owner/repo/pull/123 <full-head-hash> '["merge","undraft"]'
```

The worker reports the handoff and ends that turn. It must not ask the human to repeat an existing approval or wait for repo policy to change. The credential-free helper publishes an immutable request under `state/thread-approvals/<thread-key>/`. Identical requests return the same ID on replay. The existing supervisor tick adopts requests into `state/threads/registry.json`, deriving repo/worktree from the binding and reading the original authorized receipt itself. Invented or cross-binding receipts cannot be adopted; worker payloads cannot supply grants, authenticated source text or authority.

Once the active worker turn ends, unresolved requests notify the resident through its existing inbox and pause subsequent worker turns in that binding. Original receipts and later human messages remain available through `thread-control approval-list`, including revocations. Failed notifications retry and unresolved work replays after supervisor restart; the resident also checks the list on startup and before parking to cover resident-only recycles. Other bindings continue normally. No additional inbox reader or approval keyword classifier is introduced.

The resident verifies **actual content approval** for the exact repo, PR and starting head, using the authenticated original source and subsequent messages. Quoted text and worker requests are never grants. When `approval-list` reports `workerBusy=false` (including surviving CLI locks after restart), the resident applies that approval:

```bash
thread-control approval-grant <handoff-id> mm:<channel>:<original-approval-post> '<receipts JSON array from approval-list>'
```

The resident capability, an authorized receipt from the same binding, and the exact `receipts` snapshot returned alongside the messages by `approval-list` are required. If that snapshot has changed, the grant is rejected; the resident must read the new messages before retrying. This atomically records an audited grant and queues the saved worker session, even if its previous turn completed and there is no new human message. **The bound agent then owns review and merge.** This is a task exception to draft-only worker guidance; it does not change repository policy. The grant permits the required review and in-scope review fixes descended from the approved starting head, followed only by the requested actions on the named PR. Material content changes still require human approval. Independent tasks and other PRs acquire no authority.

The agent runs the following workflow after the verified content approval:

```bash
thread-control approval-review <handoff-id>
# Verify the live PR and required CI match the committed head reviewed to CLEAN.
thread-control approval-check <handoff-id> <PR-URL> <reviewed-head> undraft
# Perform undraft, if requested.
thread-control approval-check <handoff-id> <PR-URL> <reviewed-head> merge
# Merge this PR using the forge's expected-head guard.
thread-control approval-finish <handoff-id> <reviewed-head> 'Merged as <commit>; final review CLEAN.'
```

`approval-review` invokes the existing `review-loop --dir <bound-worktree>` only with a current resident grant. It records a fresh gate attempt and requires both exit 0 and the terminal CLEAN verdict, then records the resulting committed head. Failed, interrupted or non-CLEAN attempts cannot unlock merge. A matching CLEAN result can be reused on crash replay. A separate review lock keeps surviving gate processes from overlapping new turns or grants after restart. The checker rejects another thread/worktree, another PR/action, a changed or dirty tracked head, a missing/stale gate, and a resolved or suspended grant. Only the review-loop's built-in reviewers are allowed under the grant; unrelated agent launches remain prohibited.

Any later human receipt suspends the grant immediately, including before the supervisor's next tick. The resident reads the new messages and either regrants using the still-applicable original approval or declines/revokes; the human does not need to repeat an approval that still covers the work. Regranting records another grant generation and requires a fresh final review. Scope checks must run immediately before each forge action; the agent verifies live head/CI and uses the forge's expected-head merge guard. These helpers are a cooperative check, not a Git/API enforcement proxy or a hostile-worker security boundary.

`approval-finish` publishes an action result. The supervisor checks its grant and CLEAN gate, then durably consumes that task authority. Results cannot mint or widen grants. On replay, the agent first inspects the live PR; an already-completed merge is recorded without merging again. Failed worker turns retain their batch and need resident inspection and `retry`; a successful CLI exit without completing a still-current granted workflow is also a failed turn, rather than silently parking with unused authority.

The resident can decline or revoke with `thread-control approval-resolve <id> declined '<reason>'`, or record an independently verified, already-completed action with `completed` during recovery. Resolution and any required worker wakeup are one durable checkpoint. Consumed or declined requests cannot be regranted by replaying them. Original receipts, grant history, result records and batch membership survive restarts without synthetic human messages.

Shared filesystem and process identity are **not a strong hostile-worker isolation boundary**. A hostile process could read other processes/shared credentials or tamper with policy, registry and outboxes. Environment scrubbing and the local capability prevent normal accidental routing and unverified worker API updates; they do not provide OS isolation. Atomic writes cover process crashes, not power-loss durability. Turn side effects and outbound delivery are at-least-once: ambiguous HTTP success can produce a duplicate reply after retry, always in the registered thread. No retention/compaction, wall-clock job timeout or live Mattermost integration validation is included.

Quick checks: `bun run check`, `bun test test/unit.test.ts test/thread-agents.test.ts test/task-grants.test.ts test/secret-replies.test.ts`, and `bash -n` on changed scripts. Tests use mock transports/CLI and temporary HOME/state; they do not launch real agents or supervisor lifecycle tests. Do not run review-loop before human approval of the draft.

The task review invokes `review-loop --pr <approved URL>`. The gate resolves that
exact open PR/MR through its forge CLI, verifies the returned URL and commit IDs,
and checks that the local head contains the current PR head. It uses that PR's
base for every review phase, including the report pass. Missing or mismatched
metadata stops the gate; another PR sharing the source branch cannot substitute.
