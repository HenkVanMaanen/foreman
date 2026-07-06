# foreman — design

> A **lean** harness that turns Claude Code into a long-running, autonomous senior
> software engineer. It **pages a human** when it needs one, **manages its own context**,
> works in parallel, and **improves its own harness**. The harness itself does almost
> nothing — the agent does almost everything.

## 1. Philosophy: a thin harness, a capable agent

The agent already has Bash, file tools, subagents, and the ability to install CLIs and
write its own scripts. So the harness should provide only what the agent **physically
cannot do to itself**, and push everything else onto the agent — including scripts the
agent writes and maintains on first run.

**The harness's irreducible core is three things:**

1. **Supervise** — keep a `claude` process alive; relaunch it fresh on exit or on request.
2. **Recycle context** — watch token usage; force a checkpoint-and-restart before the
   window fills. *(The agent cannot restart itself with a clean context — this is the
   harness's most important job.)*
3. **Guard secrets** — inject credentials into subprocesses by name so their *values*
   never enter the model's context, notes, or logs.

Everything else is **agent-owned**:

| Concern | Owned by the agent as… |
|---|---|
| Human contact (Telegram/Mattermost) | `ask-human` / `wait-reply` scripts it writes that `curl` the chat APIs. |
| Parallelism | Spawning `claude -p` **worker** processes via Bash, each in its own `git worktree`. |
| Task sources & routing | Notes it writes ("issues live in gitlab acme/api"); it polls them itself. |
| Autonomy rules | Per-repo rules recorded in notes ("acme/api: PRs only"). |
| Notes & journaling | Plain markdown it reads/writes; `flock`/git for its own concurrency. |
| Config | Kept in its own notes, not harness files. |

A brand-new foreman with empty notes has one first move: **page a human** and ask what to
work on and where. From there it self-configures and writes itself notes, so the next boot
already knows.

## 2. Why TypeScript on Bun

The whole point is that **the agent improves its own harness**. Bun optimizes that inner
loop:

- `bun --watch` → the agent edits harness source and it **reloads instantly, no build step**.
- Excellent subprocess/glue ergonomics, single-file scripts, fast startup.

Safety of self-modification comes from two things, not the language:

- **A dumb outer keeper** (`keeper.sh`: `while true; do bun run src/foreman.ts; done`, or
  systemd/pm2) that **never changes**. If the agent breaks the inner harness, it bounces and
  the keeper respawns it.
- **Durable, externalized state** — the agent's memory is in `notes/`, and workers are
  **detached processes** that survive a harness bounce. So a reload/crash loses nothing.

Trade-off accepted: no single-binary deploy (needs the Bun runtime). Fine for a box you own.

## 3. Why drive the CLI over stdin/stdout (not the SDK, not raw API)

We run:

```
claude -p --input-format stream-json --output-format stream-json --verbose
```

as a long-lived subprocess the harness owns.

- **Billing.** The local `claude` binary uses your login. Logged in with a **Claude
  subscription (Max)** → headless runs draw on the subscription, *not* metered API. Setting
  `ANTHROPIC_API_KEY` would flip to metered API — we don't. Critical for hours/days of runtime.
- **Lifecycle control.** Owning the process is the point: kill/respawn to recycle context,
  re-seed on restart, snapshot/restore via `--resume`. The SDK hides exactly this.
- **Observability.** The stream-json event stream gives us per-turn usage (for the context
  watchdog) and a full log of tool calls.

The Agent SDK is just a typed wrapper over this identical protocol — we lose nothing but
some JSON parsing convenience, and we keep full control.

## 4. Architecture

```
  keeper.sh  (dumb, never-changing: respawns the harness on crash)
      │  spawns
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  foreman harness  (TypeScript on Bun, agent-editable)        │
  │                                                             │
  │   supervisor ── spawns ──► claude -p (stream-json)  ◄── the FOREMAN agent
  │      │  watches usage          │  (thin orchestrator)         │
  │      │  soft/hard marks        │                              │
  │      │  → checkpoint & recycle │  spawns via Bash:            │
  │      │                         ▼                              │
  │   secrets  ── inject by name ──► `foreman run --secret X -- <cmd>`
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
                                    │  the agent, on its own, runs:
                                    ├─ ask-human / wait-reply  (curl → Telegram/Mattermost)
                                    ├─ claude -p workers        (parallel, one per worktree)
                                    │     └─ workers recurse: their own claude -p children
                                    └─ notes/  (its durable memory + journal)
```

### Harness modules (`src/`)

| File | Responsibility |
|---|---|
| `foreman.ts` | Entrypoint + CLI dispatch (`supervise` \| `secret set` \| `run`). |
| `supervisor.ts` | Spawn the agent, stream events, run the **context watchdog** (checkpoint + recycle), watch the clear sentinel, relaunch fresh. |
| `session.ts` | Own one `claude -p` stream-json subprocess: spawn, send user turns, emit events. |
| `protocol.ts` | stream-json event/usage types. |
| `secrets.ts` | Encrypted store; `secret set` (stdin capture) + `run --secret` (env injection). |
| `config.ts` | Minimal config from env/flags (paths, marks, channel creds passthrough). |

Everything the *agent* needs at runtime lives outside `src/`: `prompts/bootstrap.md`
(its constitution), `agent-workspace-seed/` (starter notes), `examples/agent-bin/`
(reference scripts it can adopt).

## 5. Parallelism: `claude -p` recursion (agent-owned)

Claude Code's built-in Task subagents are **one level deep** (a subagent has no Task tool),
so nested fan-out needs a different primitive. The agent uses **`claude -p` via Bash**:

```sh
cd worktrees/task-482 && claude -p "Work issue #482. Notes at ../../notes. …" &
```

Each is a **full top-level Claude Code instance** with its own context window, Bash, and
Task tool — so it can recurse arbitrarily deep. Benefits:

- **Independent contexts** → a worker parked on a human-call blocks no one else.
- **Independent processes** → true parallel work, each in its own `git worktree`.
- **Survivability** → detached, so they outlive a harness reload.

The harness owns none of this. Coordination is via notes/files/exit-codes; the orchestrator
polls background jobs. For cheap read-only fan-out, workers still use their one-level Task
subagents; for heavyweight parallel work, they spawn `claude -p` children.

## 6. Context management (the harness's key job)

The orchestrator is deliberately **thin and disposable**: read state → decide → spawn/poll
workers → talk to humans → checkpoint. Heavy lifting is offloaded to workers, so its context
grows slowly. When it does fill:

- Every stream-json `result` frame reports token usage. The **watchdog** compares it to the
  window (`config.contextWindow`).
- **Soft mark (~60%)** → nudge: *"checkpoint at the next natural boundary."*
- **Hard mark (~80%)** → force: *"Write your journal note now (state, decisions, open
  threads, in-flight worker task-ids). Reply DONE."* → agent saves to `notes/` → harness
  **kills and relaunches fresh** → bootstrap makes it re-read `INDEX.md` + journal → it
  resumes with a near-empty context.

Claude Code's built-in auto-compaction is a first line *within* a turn; the harness recycle
is the guarantee. Workers, being short-lived, rarely need it; if one fills it checkpoints to
its task notes and can be re-spawned with `--resume`.

## 7. Secrets

- Encrypted store (libsodium/age; key from OS keyring or a passphrase at startup).
- **Capture without exposure:** the agent pipes a human's reply straight into the store —
  `wait-reply --raw | foreman secret set GITLAB_TOKEN` — so the value transits a pipe and
  only a confirmation ("stored") reaches the agent's context.
- **Use without exposure:** `foreman run --secret GITLAB_TOKEN -- glab issue list` decrypts,
  sets the env var **for that child process only**, and execs — the value never appears in
  the agent's stdout/transcript.
- The agent references secrets **by name**, never by value. Log scrubbing strips known
  values as defense-in-depth.

## 8. Cold start (worked example)

1. Operator runs `keeper.sh`; channel creds are in env; notes dir is empty.
2. Agent boots, reads empty `INDEX.md`, writes its own `ask-human`/`wait-reply` scripts,
   and pages a human: *"Fresh start. Where do my tasks come from, and what may I do?"*
3. Human (Telegram): *"GitLab issues in acme/api and acme/web. PRs only, never push main."*
4. Agent installs `glab`, pages for a token → `wait-reply --raw | foreman secret set
   GITLAB_TOKEN` → told the name.
5. Agent writes notes: task sources, token reference, per-repo autonomy = PRs-only.
6. Agent lists issues, spawns parallel `claude -p` workers (worktree each), opens MRs, pages
   the human only for merges / ambiguity / risk.
7. Context fills → watchdog forces a journal + fresh restart → agent resumes seamlessly.
8. Next boot: `INDEX.md` + scripts already exist — no re-onboarding.

## 9. MVP scope (v1)

**In:** the three-part harness (supervise / recycle-context / guard-secrets) in TS on Bun;
the keeper; the bootstrap prompt; a starter notes seed; reference `ask-human`/`wait-reply`
scripts for Telegram + Mattermost that the agent adopts.

**Later:** email + Signal reference scripts; a web dashboard; richer log scrubbing; metrics.

## 10. Open questions / risks

- **Does headless `-p` auto-compact?** We don't rely on it — the watchdog recycle is the
  guarantee — but worth confirming to tune the marks.
- **Broken self-edit** — the keeper covers crashes, but a subtly-wrong harness edit could
  misbehave without crashing. Mitigation: keep `src/` tiny and add a self-test the agent
  runs before adopting a harness change.
- **Reply routing** across two channels — enforce `#<question-id>` prefixes or thread replies.
- **Subscription rate limits** under many parallel `claude -p` workers — the agent must
  self-throttle (a concurrency cap recorded in its notes).
- **Worktree cleanup** — the agent must reap abandoned worktrees.
