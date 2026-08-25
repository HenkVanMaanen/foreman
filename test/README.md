# foreman tests

## Tests (no real agents, no network)

```sh
bun install          # dev deps (types)
npm test             # unit tests (bun test) + lifecycle (bash test/run-lifecycle.sh)
```

`npm test` runs five layers: `unit.test.ts` (pure helpers — `bun test` auto-discovers
`*.test.ts`), the lifecycle suite below, then `wait-reply-inbox.sh`,
`review-loop-verdict.sh` and `spawn-worker-engine.sh`.

## spawn-worker engine test

`spawn-worker-engine.sh` covers `FOREMAN_WORKER_ENGINE` (`claude`, the default, vs `codex`). It
extracts `worker_run_cmd` and `codex_did_not_run` verbatim from
`examples/agent-bin/spawn-worker.sh`, then drives the real spawn-worker against PATH-shim
`claude`/`codex` binaries in a throwaway `FOREMAN_STATE_DIR` (no agent, no network, no token spend).

It locks: `claude` stays the default and its command line stays byte-identical; the `codex` line
passes the brief on **stdin** (never as an argv string) and always carries `-s danger-full-access`
(bubblewrap cannot start in this container); an unknown engine is refused before anything spawns;
and — the one that matters — a **bubblewrap startup failure is reported as a FAILURE**
(`WORKER_EXIT=86`, `result.json` status `blocked`) even though `codex exec` exits 0 and the model
still claims the work is done, while the same error text merely *quoted* by a worker that really ran
does not false-trigger. Both engines are asserted against the identical log / `WORKER_EXIT` /
`<name>.done` / `<name>.result.json` / `workers.jsonl` contract that `worker-status` reads.

## review-loop verdict + codex-sandbox test

`review-loop-verdict.sh` extracts the units under test verbatim from
`examples/agent-bin/review-loop.sh` — `compute_verdict`, `run_escalation_phase` (with its helpers and
prompt builder) and `run_codex` — and drives them with fabricated phase results, a stubbed agent pass
and a PATH-shim `codex` (no agents, no network, no repo work; a real review-loop run takes hours).

It locks the verdict rule: correctness signals (a RISKY finding from any phase, ANY security finding,
a phase ERROR) decide the outcome, while convergence signals (a phase stopping at its round cap,
Codex not running at all) are informational and can neither flip the verdict nor appear in the `WHY:`
line; `FAILED` (exit 5) > `NEEDS-AI` (3) > `NEEDS-DECISION` (6) > `CLEAN` (0). What a RISKY finding
MEANS is the escalation pass's answer — fixed/refuted ⇒ CLEAN, "needs a product / stored-data /
ownership decision" ⇒ NEEDS-DECISION, anything else ⇒ NEEDS-AI — and no phase status can reach
NEEDS-DECISION on its own.

It locks the escalation pass itself: it is bounded by `--escalation-attempts` (an attempt that
changes nothing ends the phase), each finding is handed over at most once, a pass that emits no
verdict line counts as UNRESOLVED rather than silently resolved, an echoed-back output template is
not a verdict, and an ERRORing pass reports ERROR. It also locks the Codex sandbox
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

`run-lifecycle.sh` drives the **real supervisor** against `mock-claude.ts` and `mock-codex.ts`
from a fresh temp workspace. It verifies:

- **Cold-start workspace seeding** — `notes/` (from the seed), `notes/journal|tasks/`, and an
  executable `bin/` (`ask-human`, `wait-reply`, `foreman` shim) are created on first launch.
- **Context-watchdog recycle** — usage crosses the soft mark (nudge) then the hard mark
  (checkpoint request) → the agent "checkpoints" → the supervisor kills and **relaunches fresh**.
- **Agent-initiated recycle** — the agent drops a `state/clear-request` sentinel → the
  supervisor detects it and relaunches fresh.
- **Codex resident lifecycle** — the first prompt uses `codex exec --json`, later prompts resume
  the emitted thread id, Codex usage maps to context occupancy without double-counting cached or
  output tokens, and the same checkpoint/recycle contract launches a new thread.
- **Engine-specific auth recovery** — both relay paths are rehearsed, including the Codex device
  flow's post-login real-call verification and fail-closed behavior when verification fails.

`mock-claude.ts` modes: `MOCK_MODE=usage` (default, escalating tokens) and `MOCK_MODE=clear`
(writes the sentinel). A cross-process `mock-lives` counter ends the scenario after one recycle.

## Protocol note

Against `claude` 2.1.201, `result` frames carry `session_id` and a `usage` object with
`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` —
exactly what `src/protocol.ts:usageTotal` sums for the watchdog. Real claude also emits
`rate_limit_event` frames, which the supervisor currently ignores.

Codex `exec --json` emits a `thread.started` id and terminal `turn.completed`/`turn.failed`
events. `input_tokens` already includes its cached subset, so the adapter maps only that total to
the common result usage; subsequent supervisor turns use `codex exec resume <thread-id>`.

## Live cold-start (needs a Telegram bot)

The only leg the mock can't cover is the real human round-trip. To try it end-to-end:

1. Create a bot with **@BotFather** → get `TELEGRAM_BOT_TOKEN`; DM the bot once and get your
   `TELEGRAM_CHAT_ID` (e.g. via `https://api.telegram.org/bot<token>/getUpdates`).
2. `cp .env.example .env` and fill those in. (Secrets use `age`; the harness auto-generates an
   identity at `FOREMAN_AGE_IDENTITY` on first boot — nothing to set by hand.)
3. `./keeper.sh` — with empty notes, foreman will page you on Telegram asking what to work on.
