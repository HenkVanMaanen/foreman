# Codex 5% quota heads-up (opt-in)

When any main Codex allowance window reaches **5% remaining or less**, the existing
supervisor queues a short Mattermost reply in the configured bound thread. The
message includes each newly low window's remaining percentage and UTC reset time
(or explicitly says the reset time is unavailable). A weekly window is identified
by its duration; primary does not imply a five-hour window. Both primary and
secondary are checked. Spark, reserve and all other buckets are excluded.

The existing thread-router tick schedules a read about every 60 seconds, including
while the resident is parked or busy. Each read starts a finite
`FOREMAN_CODEX_BIN app-server --listen stdio://` subprocess in an empty temporary
working directory. It sends only `initialize`, `initialized`, and
`account/rateLimits/read`, following the [official OpenAI app-server protocol](https://learn.chatgpt.com/docs/app-server).
Codex uses its existing authentication internally. No model session/turn, auth-file
or transcript inspection, login flow, reset redemption or additional inbox poller is
involved. The query has a 15-second deadline and 1 MiB output cap; EOF and up to one
second of bounded child cleanup follow. Only that owned child can be signalled.
No overlapping checks run. Model CLI extra arguments are not passed to app-server.

`rateLimitsByLimitId.codex` takes precedence. When the multi-bucket view is absent,
only a legacy `rateLimits` explicitly identified as `codex` is accepted. Missing,
malformed, expired or failed quota readings do not become zero allowance or rearm
an alert. They are recorded as unknown when no usable main window remains.

## Deduplication and delivery tradeoff

`FOREMAN_STATE_DIR/codex-quota/monitor.json` records only quota metadata and episode/
pending-alert bookkeeping. Each duration is rearmed by a reading above 5% remaining
or a forward change in its reset timestamp. Missing windows and backwards reset
timestamps preserve suppression. The pending alert is committed before publication
and replays with the same immutable outbox ID across a process crash. Windows first
observed below the threshold also trigger a warning.

The existing thread outbox determines the destination from its registry. Quota
alerts set `sendOnce`; the supervisor persists `attemptedAt` **before** sending.
An attempted alert is never retried, including after an ambiguous HTTP outcome or
restart. This prevents duplicate warnings but **can miss an alert** if sending fails,
or if the supervisor crashes between recording the attempt and sending it. An entry
with `attemptedAt` and without `sent: true` means delivery is unconfirmed. Later
ordinary replies and future rearmed episodes still proceed. Ordinary replies retain
their existing retry behavior. There is no claim of exactly-once delivery.

Keep the same durable state directory across restarts; deleting the monitor/outbox
state removes suppression. Atomic files cover process crashes, as with the existing
outbox; power-loss durability is not added. A quota crossing and recovery entirely
between polls can be missed. Warnings require the supervisor and Mattermost delivery
to be available; they do not redeem a reset automatically.

## Activation handoff (resident/operator only)

This branch does not enable the alert or change the live runtime. Content approval,
review/merge and operational activation remain separate authorized steps. The
resident owns the existing activation procedure and its separate host repair; do
not launch this worktree's supervisor alongside the running one.

After content approval and the required verified grants:

1. Complete the approved review/merge workflow, then install the approved revision
   through the existing activation procedure. The active runtime must include the
   thread router and this quota module. Complete the separate activation-host repair
   first if that procedure still requires it.
2. In the existing **supervisor configuration** (not a worker shell), retain the
   existing Mattermost settings, authentication, Codex binary and durable state path.
   Set the following values for this request:

   ```dotenv
   FOREMAN_THREAD_AGENTS=1
   FOREMAN_CHANNEL_MODE=mattermost
   FOREMAN_CODEX_QUOTA_THREAD=mm:jn364kfs6i845dp1r465u3ojso:rz48jcsgipg7mnbd69ne3ka9tr
   FOREMAN_CODEX_QUOTA_POLL_MS=60000
   ```

   `FOREMAN_CODEX_QUOTA_THREAD` defaults to empty (disabled). The interval defaults
   to 60000 ms and accepts integers from 10000 through 3600000 ms. The threshold
   is fixed at 5%. No new credentials, daemon, service or keeper change is needed.
3. Verify the existing registry binding for that channel/root is retained. The
   monitor does not create a binding, synthesize a receipt or launch a thread agent.
   With no matching binding, thread agents disabled, or Telegram emergency mode,
   it does not query quota.
4. Have the resident perform the authorized replacement/restart of the **sole**
   supervisor through the existing lifecycle procedure. No process signalling or
   service changes are authorized by this document alone.
5. Within roughly one interval plus the query deadline, inspect only
   `FOREMAN_STATE_DIR/codex-quota/monitor.json`: `checkedAt` should advance, `status`
   should be `ok`, and `observed` should contain the main windows. `unknown` means no
   usable quota was available. If already at or below 5%, the first check queues a
   real heads-up. For delivery confirmation, inspect the quota entry's `sent` marker
   in the bound thread's existing outbox; do not send a synthetic production alert.

To pause monitoring, clear `FOREMAN_CODEX_QUOTA_THREAD` in the same supervisor
configuration and perform an authorized restart. Keep the state files. Already
queued replies still belong to the existing outbox and may be delivered.

## Focused local validation

```sh
bun --no-env-file test test/codex-quota.test.ts
bun --no-env-file test test/thread-agents.test.ts --test-name-pattern 'outbox'
bun run check
```

Quota tests use isolated files, injected transport and harmless subprocess stubs.
They cover threshold, both windows, main-bucket selection, recovery/reset, unknown
quota, crash replay, restart suppression, cadence/overlap, router integration,
ambiguous delivery, protocol ordering, output/timeout bounds and cleanup. Full
lifecycle/reaper tests and live transport validation are intentionally not part of
this live-host draft check.
