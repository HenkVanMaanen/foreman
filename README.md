# foreman

A **lean** harness that turns **Claude Code** into a long-running, autonomous **senior
software engineer** — one that **pages a human** when it needs one, **manages its own
context**, works in parallel, and **improves its own harness**.

It **inverts the agent loop**: instead of a human steering every turn, the agent drives
continuously and pulls a human in on demand. The human is the interrupt handler, not the pilot.

## The one idea: thin harness, capable agent

The agent already has Bash, file tools, subagents, and can install CLIs and write its own
scripts. So the harness does **only what the agent can't do to itself** — everything else
is owned by the agent and bootstrapped at runtime.

**Harness (irreducible):**
1. **Supervise** — keep a `claude` process alive; relaunch fresh on exit/request.
2. **Recycle context** — watch token usage; force checkpoint-and-restart before the window fills.
3. **Guard secrets** — inject credentials into subprocesses by name; values never touch the transcript.

**Agent (everything else):** human contact (its own `curl` scripts to Telegram/Mattermost),
parallelism (`claude -p` workers in git worktrees), task sources, autonomy rules, notes,
journaling, config — all learned by asking a human and written to its own notes.

A fresh foreman with empty notes pages a human and asks *"what should I work on, and where?"*
— then self-configures.

## Why these choices

- **TypeScript on Bun** — so the agent can edit its own harness and `bun --watch` reloads it
  **instantly, no build step**. A dumb bash `keeper.sh` wraps it so a bad self-edit just bounces.
- **Drive `claude -p` over stdin/stdout** (not the SDK, not raw API) — keeps **subscription
  billing** (cheap for long runs) and full **process-lifecycle control** (needed to recycle context).
- **`claude -p` recursion for parallelism** — each worker is a full Claude Code instance with
  its own context window, so it can recurse *and* a worker parked on a human never blocks others.

See [`DESIGN.md`](./DESIGN.md) for the full architecture, context-recycling loop, secrets
model, and cold-start walkthrough.

## Status

**Runnable, harness verified.** The supervisor lifecycle — cold-start workspace seeding,
context-watchdog recycle, and agent-initiated recycle — is exercised end-to-end against a
mock `claude` by `npm test`. The stream-json frame shapes are validated against real
`claude` 2.1.201. Secrets capture/inject works end-to-end. The one leg not yet wired for a
*live* run is the real Telegram/Mattermost round-trip (needs your bot token). Human-contact
scripts are reference-quality; expect to refine them for your workspace.

## Quick start

```sh
bun install                  # dev deps (types)
npm test                     # verify the supervisor lifecycle (mock claude, no network)

claude login                 # subscription auth so headless runs don't hit metered API
cp .env.example .env         # Telegram/Mattermost creds, context marks, secrets passphrase
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
- **CI** — `.github/workflows/ci.yml` runs `bun run check` + `bun test` on every push/PR.
- **agent self-edits** — `harness-sync` runs `bun run check` before it will push a harness
  change to `main`, so foreman can't publish code that doesn't lint or type-check.

```sh
bun run check     # biome (lint+format, warn=error) + strict tsc
bun run format    # biome autofix (format + organize imports + safe lint fixes)
```

## Layout

```
keeper.sh                  dumb outer keeper (never changes); respawns the harness
src/foreman.ts             entrypoint + CLI (supervise | secret set | run)
src/supervisor.ts          agent lifecycle + context watchdog (checkpoint & recycle)
src/session.ts             owns one claude -p stream-json subprocess
src/protocol.ts            stream-json event/usage types
src/secrets.ts             encrypted store; capture-via-pipe + inject-by-env
src/config.ts              minimal env/flag config
prompts/bootstrap.md       the agent's constitution (re-seeded on every (re)launch)
agent-workspace-seed/      starter notes the agent extends and then owns
examples/agent-bin/        reference ask-human / wait-reply scripts the agent adopts
```

## Design decisions (locked)

- Substrate: `claude -p --input-format stream-json --output-format stream-json --verbose`, long-lived subprocess.
- Harness: **TypeScript on Bun**, wrapped by a dumb bash keeper for safe self-modification.
- Human channels (MVP): Telegram + Mattermost, via **agent-owned** curl scripts.
- Loop semantics: async — the agent parks on a human-call and keeps working other tasks.
- Parallelism: **agent-owned**, via detached `claude -p` workers, each in a git worktree.
- Notes: agent-owned markdown + an always-loaded `INDEX.md`.
- Secrets: harness-guarded — captured via pipe, injected by name; values never enter context.
- Context: harness watchdog forces checkpoint → fresh restart → rehydrate from notes.
