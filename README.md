# foreman

A **lean** harness that turns **Claude Code or Codex CLI** into a long-running, autonomous
**senior software engineer** — one that **pages a human** when it needs one, **manages its
own context**, works in parallel, and **improves its own harness**.

It **inverts the agent loop**: instead of a human steering every turn, the agent drives
continuously and pulls a human in on demand. The human is the interrupt handler, not the pilot.

## The one idea: thin harness, capable agent

The agent already has Bash, file tools, subagents, and can install CLIs and write its own
scripts. So the harness does **only what the agent can't do to itself** — everything else
is owned by the agent and bootstrapped at runtime.

**Harness (irreducible):**
1. **Supervise** — keep a Claude stream or resumed Codex thread alive; relaunch fresh on request.
2. **Recycle context** — watch token usage; force checkpoint-and-restart before the window fills.
3. **Guard secrets** — inject credentials into subprocesses by name; values never touch the transcript.

**Agent (everything else):** human contact (its own `curl` scripts to Telegram/Mattermost),
parallelism (Claude/Codex workers in git worktrees), task sources, autonomy rules, notes,
journaling, config — all learned by asking a human and written to its own notes.

A fresh foreman with empty notes pages a human and asks *"what should I work on, and where?"*
— then self-configures.

## Why these choices

- **TypeScript on Bun** — so the agent can edit its own harness and `bun --watch` reloads it
  **instantly, no build step**. A dumb bash `keeper.sh` wraps it so a bad self-edit just bounces.
- **Drive the installed CLI** (not a raw API) — keeps subscription auth and full
  **process-lifecycle control**. Claude uses one stream-json process; Codex uses `exec --json` and
  `exec resume <thread-id>` turns.
- **CLI workers for parallelism** — each worker is a full agent instance with its own context
  window, so a worker parked on a human never blocks others.

See [`DESIGN.md`](./DESIGN.md) for the full architecture, context-recycling loop, secrets
model, and cold-start walkthrough.

## Status

**Runnable, harness verified.** The supervisor lifecycle — cold-start workspace seeding,
context-watchdog recycle, and agent-initiated recycle — is exercised end-to-end against mock
Claude and Codex CLIs by `npm test`. Both event adapters are covered, including Codex thread
resume. Secrets capture/inject works end-to-end. The one leg not yet wired for a
*live* run is the real Telegram/Mattermost round-trip (needs your bot token). Human-contact
scripts are reference-quality; expect to refine them for your workspace.

## Quick start

```sh
bun install                  # dev deps (types)
npm test                     # unit tests + supervisor lifecycle (mock claude, no network)

claude login                 # when FOREMAN_SESSION_ENGINE=claude
codex login                  # when FOREMAN_SESSION_ENGINE=codex
cp .env.example .env         # Telegram/Mattermost creds, context marks, age secrets identity
./keeper.sh                  # dumb keeper → runs the harness → spawns the foreman agent
```

On first boot with empty notes, foreman seeds its workspace (`notes/`, `bin/`) and pages you
on Telegram/Mattermost asking what to work on. Answer, and it self-configures. See
[`test/README.md`](./test/README.md) for the live cold-start walkthrough.

## Quality gate (strict, fast, auto-run)

One command — `bun run check` — is the whole gate: **Biome** (Rust-based lint + format, warnings
treated as errors) followed by a **maximally strict `tsc`** (`strict` + `noUnchecked*`,
`exactOptionalPropertyTypes`, `noUnused*`, `noImplicitReturns`, …). Minimal config: one
`biome.json`, the flags in `tsconfig.json`.

It auto-runs everywhere it matters:
- **pre-commit** — `.githooks/pre-commit` runs `bun run check` (hook path is set by the
  `prepare` script on `bun install`). A commit that doesn't pass is blocked.
- **CI** — `.github/workflows/ci.yml` runs `bun run check` + `bun run test` on every push/PR.
- **agent self-edits** — `harness-sync` runs `bun run check` before it will push a harness
  change to `main`, so foreman can't publish code that doesn't lint or type-check.

```sh
bun run check     # biome (lint+format, warn=error) + strict tsc
bun run format    # biome autofix (format + organize imports + safe lint fixes)
```

## Layout

```
keeper.sh                  dumb outer keeper (never changes); respawns the harness
src/foreman.ts             entrypoint + CLI (supervise | dashboard | secret set | run | relogin)
src/supervisor.ts          agent lifecycle + context watchdog (checkpoint & recycle)
src/session.ts             engine-neutral resident-session facade + Claude stream adapter
src/codex-session.ts       Codex exec/resume JSONL adapter
src/relogin.ts             engine-selected Telegram re-auth when Claude/Codex OAuth dies
src/protocol.ts            stream-json event/usage types
src/secrets.ts             encrypted store; capture-via-pipe + inject-by-env
src/dashboard.ts           read-only observability dashboard (serves /api/state)
src/config.ts              minimal env/flag config
prompts/bootstrap.md       the agent's constitution (re-seeded on every (re)launch)
agent-workspace-seed/      starter notes the agent extends and then owns
examples/agent-bin/        reference ask-human / wait-reply scripts the agent adopts
```

## Design decisions (locked)

- Substrate: selectable Claude stream-json process or resumed Codex exec JSONL turns.
- Harness: **TypeScript on Bun**, wrapped by a dumb bash keeper for safe self-modification.
- Human channels (MVP): Telegram + Mattermost, via **agent-owned** curl scripts.
- Loop semantics: async — the agent parks on a human-call and keeps working other tasks.
- Parallelism: **agent-owned**, via detached Claude/Codex workers, each in a git worktree.
- Notes: agent-owned markdown + an always-loaded `INDEX.md`.
- Secrets: harness-guarded — captured via pipe, injected by name; values never enter context.
- Context: harness watchdog forces checkpoint → fresh restart → rehydrate from notes.
