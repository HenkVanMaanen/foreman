# foreman tests

## Lifecycle test (no real Claude, no network)

```sh
bun install          # dev deps (types)
npm test             # or: bash test/run-lifecycle.sh
```

`run-lifecycle.sh` drives the **real supervisor** against `mock-claude.ts` — a fake
`claude -p` that speaks the stream-json protocol — from a fresh temp workspace. It verifies:

- **Cold-start workspace seeding** — `notes/` (from the seed), `notes/journal|tasks/`, and an
  executable `bin/` (`ask-human`, `wait-reply`, `foreman` shim) are created on first launch.
- **Context-watchdog recycle** — usage crosses the soft mark (nudge) then the hard mark
  (checkpoint request) → the agent "checkpoints" → the supervisor kills and **relaunches fresh**.
- **Agent-initiated recycle** — the agent drops a `state/clear-request` sentinel → the
  supervisor detects it and relaunches fresh.

`mock-claude.ts` modes: `MOCK_MODE=usage` (default, escalating tokens) and `MOCK_MODE=clear`
(writes the sentinel). A cross-process `mock-lives` counter ends the scenario after one recycle.

## Protocol note (validated against real claude)

Against `claude` 2.1.201, `result` frames carry `session_id` and a `usage` object with
`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` —
exactly what `src/protocol.ts:usageTotal` sums for the watchdog. Real claude also emits
`rate_limit_event` frames, which the supervisor currently ignores.

## Live cold-start (needs a Telegram bot)

The only leg the mock can't cover is the real human round-trip. To try it end-to-end:

1. Create a bot with **@BotFather** → get `TELEGRAM_BOT_TOKEN`; DM the bot once and get your
   `TELEGRAM_CHAT_ID` (e.g. via `https://api.telegram.org/bot<token>/getUpdates`).
2. `cp .env.example .env` and fill those in (plus `FOREMAN_SECRETS_PASSPHRASE`).
3. `./keeper.sh` — with empty notes, foreman will page you on Telegram asking what to work on.
