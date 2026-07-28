# foreman tests

## Tests (no real Claude, no network)

```sh
bun install          # dev deps (types)
npm test             # unit tests (bun test) + lifecycle (bash test/run-lifecycle.sh)
```

`npm test` runs four layers: `unit.test.ts` (pure helpers — `bun test` auto-discovers
`*.test.ts`), the lifecycle suite below, then `wait-reply-inbox.sh` and
`review-loop-verdict.sh`.

## review-loop verdict + codex-sandbox test

`review-loop-verdict.sh` extracts two units verbatim from `examples/agent-bin/review-loop.sh` —
`compute_verdict` and `run_codex` — and drives them with fabricated phase results and a PATH-shim
`codex` (no agents, no network, no repo work; a real review-loop run takes hours). It locks the
verdict rule: correctness signals (a RISKY finding from any phase, ANY security finding, a phase
ERROR) decide the outcome, while convergence signals (a phase stopping at its round cap, Codex not
running at all) are informational and can neither flip the verdict nor appear in the `WHY:` line;
`FAILED` (exit 5) outranks `NEEDS-HUMAN` (3) outranks `CLEAN` (0). It also locks the Codex sandbox
handling: a bubblewrap startup failure is detected even though `codex exec` exits 0, the same error
text merely *quoted* by a healthy review is not, an unconfirmed detection does not block later
rounds, and a confirmed one stops further Codex calls.

## wait-reply inbox test

`wait-reply-inbox.sh` drives `examples/agent-bin/wait-reply.sh` in **inbox mode** against a
PATH-shim `curl` that returns canned Mattermost JSON (no network). It locks the inbox contract:
the first-ever call seeds the channel watermark to "now" and blocks (→ exit 3 on timeout); a
canned new human post prints as one `MSG <id> <root> <text>` line, advances the watermark, and is
👀-reacted; two queued posts both print chronologically; a bot post is filtered out and message
newlines collapse to spaces; nothing new → exit 3 with the watermark unmoved.

## Lifecycle test

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
2. `cp .env.example .env` and fill those in. (Secrets use `age`; the harness auto-generates an
   identity at `FOREMAN_AGE_IDENTITY` on first boot — nothing to set by hand.)
3. `./keeper.sh` — with empty notes, foreman will page you on Telegram asking what to work on.
