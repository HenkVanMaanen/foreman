// The supervisor: the harness's core loop. It keeps the foreman agent alive, seeds it
// with the bootstrap prompt, watches token usage, and forces a checkpoint-and-recycle
// before the context window fills. On recycle it relaunches FRESH (empty context) — the
// agent rehydrates from its own notes, so nothing is lost.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { recordEvent, type SupervisorState, writeStatus } from "./dashboard.ts";
import {
  formatInboxPrompt,
  InboxQueue,
  sendTelegramAck,
  startInboxPoller,
  waitForInboxMessages,
} from "./inbox.ts";
import { usageTotal } from "./protocol.ts";
import { makeAuthDetector, makeAuthRecovery } from "./relogin.ts";
import { Session } from "./session.ts";
import { startWatchdog } from "./watchdog.ts";
import { ensureWorkspace, syncNotes } from "./workspace.ts";

const CONTINUE = "continue";

const SOFT_MSG =
  "[harness] Your context is ~60% full. Checkpoint at the next natural boundary: " +
  "update your journal in notes/journal/ so a fresh restart could resume cleanly.";

const HARD_MSG =
  "[harness] Your context is ~80% full. STOP and checkpoint NOW: write/refresh your " +
  "journal in notes/journal/ capturing current state, decisions, open threads, and " +
  "in-flight worker task-ids. Then reply exactly DONE. I will restart you fresh.";

export async function supervise(cfg: Config): Promise<void> {
  const bootstrap = await readFile(cfg.bootstrapPromptPath, "utf8");
  const clearSentinel = join(cfg.stateDir, "clear-request");
  // Written by bin/park when the agent goes idle: the supervisor (not the model) then owns the
  // wait for the next human message. See the idle-aware keep-alive at the bottom of the loop.
  const idleSentinel = join(cfg.stateDir, "idle-wait");
  const hardTokens = Math.floor(cfg.contextWindow * cfg.hardMark);
  const softTokens = Math.floor(cfg.contextWindow * cfg.softMark);

  // Seed/verify the agent workspace (notes, bin/, state, worktrees) before launch.
  const workspaceEnv = await ensureWorkspace(cfg);

  // Env for the agent: workspace (PATH + FOREMAN_HOME) on top of the full inherited process
  // env. Session.start() already spreads ...process.env into the child, so every channel cred
  // (TELEGRAM_*, MATTERMOST_*, incl. MATTERMOST_TARGET_USER) reaches the agent's scripts by
  // inheritance — no explicit allowlist needed. (An allowlist here would only re-copy vars the
  // child already has, and previously omitted MATTERMOST_TARGET_USER while doing so.)
  const passthroughEnv = { ...workspaceEnv };

  // Track for the dashboard: which fresh lifetime we're on, and the last observed usage.
  let life = 0;
  let lastUsed = 0;
  const stat = (state: SupervisorState) =>
    writeStatus(cfg, {
      pid: process.pid,
      state,
      ctxUsed: lastUsed,
      ctxWindow: cfg.contextWindow,
      ctxPct: Math.round((lastUsed / cfg.contextWindow) * 100),
      life,
      softMark: cfg.softMark,
      hardMark: cfg.hardMark,
    });

  // Watchdog: if the supervisor makes no progress for watchdogTimeoutMs (no stream event,
  // send, or loop turn), force-exit so keeper respawns a fresh harness. touch() below marks
  // progress; the only legitimately quiet window is waiting for the next stream event, which
  // is bounded by the agent's longest single tool call (~600s), well under the default 20min.
  const watchdog = startWatchdog({
    timeoutMs: cfg.watchdogTimeoutMs,
    checkMs: cfg.watchdogCheckMs,
    onStall: (idleMs) => {
      const idleS = Math.round(idleMs / 1000);
      // stderr is inherited → this line lands in the supervisor log as the durable diagnostic.
      console.error(
        `[watchdog] no supervisor progress for ${idleS}s ` +
          `(timeout ${Math.round(cfg.watchdogTimeoutMs / 1000)}s) — exiting for keeper to respawn`,
      );
      // Surface the bounce on the dashboard too, but never let the write delay the exit — the
      // wedge itself may be I/O, so cap the flush at 1s then force-exit regardless.
      const trace = Promise.allSettled([
        recordEvent(cfg, { who: "supervisor", kind: "watchdog", detail: `idle ${idleS}s` }),
        stat("wedged"),
      ]);
      const cap = new Promise((r) => setTimeout(r, 1000));
      // keeper respawns with backoff; durable state is in notes/, so the bounce loses nothing.
      Promise.race([trace, cap]).finally(() => process.exit(70));
    },
  });

  // Always-on inbox. ONE poller drains Telegram for the whole harness lifetime (across every
  // agent life), so the agent never goes deaf during a long work turn the way the old parked-only
  // poll did. `io.phase` lets the poller distinguish "agent busy" (auto-ack + queue for the next
  // boundary) from "agent parked" (the parked wait below wakes it directly, no ack) and "relogin"
  // (the relay owns the queue and is itself mid-conversation with the human — an "I'm mid-task"
  // ack on top of "please send me the sign-in code" would be actively misleading). `io.acked`
  // throttles the auto-ack to once per busy stretch so a burst of messages isn't a burst of acks.
  const inbox = new InboxQueue();
  const io = { phase: "busy" as "busy" | "parked" | "relogin", acked: false };
  const poller = startInboxPoller(cfg, passthroughEnv, inbox, {
    isBusy: () => io.phase === "busy",
    onBusyMessage: async (lines) => {
      if (io.acked) return; // already acked this busy stretch — don't spam
      io.acked = true;
      await sendTelegramAck(
        "👀 Got it — I'm mid-task right now. I'll pick this up at my next checkpoint; " +
          "no need to resend.",
      );
      await recordEvent(cfg, {
        who: "supervisor",
        kind: "inbox-queued",
        detail: `${lines.length} line(s) while busy`,
      });
    },
    // Keep the dashboard state the poller stamps in step with the phase — in particular it must
    // not overwrite "auth-required" with a healthy-looking "working" at the one moment the human
    // reading the dashboard is the only thing that can unwedge the harness.
    refresh: () =>
      stat(io.phase === "parked" ? "idle" : io.phase === "relogin" ? "auth-required" : "working"),
  });

  // Re-login relay: an expired OAuth token makes every turn fail instantly with a synthetic
  // "Not logged in · Please run /login" frame, which the loop would otherwise `continue` into
  // forever with the model never running. Detect it, tear the session down, and hand off to the
  // Telegram-mediated re-auth below. ONE detector for the whole run: the FOREMAN_FAKE_AUTH_REQUIRED
  // test injection is one-shot per instance, so a per-life detector would re-inject every life.
  const authDetector = makeAuthDetector(cfg.fakeAuthRequired);
  // Owns the rest of the policy (enabled?, hot-loop breaker, which agent to re-auth) — see
  // makeAuthRecovery. Built once: the breaker's state has to span lives to spot a hot loop.
  const recoverAuth = makeAuthRecovery(cfg);

  // Outer loop: each iteration is one fresh agent lifetime (until a recycle or exit).
  for (;;) {
    watchdog.touch();
    const session = new Session(cfg);
    session.start({ env: passthroughEnv });
    await session.send(bootstrap);
    watchdog.touch();
    life++;
    lastUsed = 0;
    io.phase = "busy";
    io.acked = false;
    console.log("[supervisor] agent launched; bootstrap sent");
    await recordEvent(cfg, { who: "supervisor", kind: "launch", detail: `life #${life}` });
    await stat("working");

    let awaitingCheckpoint = false;
    let nudgedSoft = false;
    // Why this life ended, set at whichever `break` ends it (each also logs/records its own
    // detail — nothing downstream needs the text again). One variable rather than a flag per
    // outcome, so the outcomes are visibly exclusive and adding one can't silently overlap an
    // existing case. "process" is the default: the stream ended on its own (crash or clean stop).
    let ended: "process" | "recycle" | "auth" = "process";
    // The detector's verdict for this life, handed to recoverAuth so it can tell a REHEARSAL
    // (the FOREMAN_FAKE_AUTH_REQUIRED injection) from a real lockout without latching its own copy.
    let authDetail = "";
    // Did the model actually complete a turn this life? A life that worked before the token died
    // is a genuine expiry, not the hot loop the breaker above is guarding against.
    let sawHealthyTurn = false;

    for await (const ev of session.events()) {
      watchdog.touch(); // any frame (thinking, tool use, result) is a sign of life
      const authFrame = authDetector(ev);
      if (authFrame) {
        ended = "auth";
        authDetail = authFrame;
        console.log(`[supervisor] auth required (${authFrame}) → re-login relay`);
        await recordEvent(cfg, { who: "supervisor", kind: "auth-required", detail: authFrame });
        break;
      }
      if (ev.type !== "result") continue;
      // A turn that FAILED is not evidence the session was ever working, so it must not reset the
      // hot-loop breaker — otherwise a life that errors out and then hits the auth frame looks
      // healthy every time and the breaker never trips on the spin it exists to catch.
      if (ev.is_error !== true) sawHealthyTurn = true;
      const used = usageTotal(ev.usage);
      if (used) {
        console.log(`[supervisor] turn complete; context ≈ ${used}/${cfg.contextWindow}`);
        lastUsed = used;
        await recordEvent(cfg, { who: "supervisor", kind: "turn", ctx: used });
        await stat("working");
      }

      if (awaitingCheckpoint) {
        console.log("[supervisor] checkpoint turn complete → recycling");
        ended = "recycle";
        break;
      }
      if (existsSync(clearSentinel)) {
        await rm(clearSentinel, { force: true });
        console.log("[supervisor] agent requested clear → recycling");
        await recordEvent(cfg, { who: "supervisor", kind: "clear" });
        ended = "recycle";
        break;
      }
      if (used >= hardTokens) {
        console.log("[supervisor] hard mark hit → asking agent to checkpoint");
        await recordEvent(cfg, { who: "supervisor", kind: "hard-mark", ctx: used });
        // Same EPIPE guard as the keep-alive send below: if the child died right as we mark, the
        // write throws — treat that as "process ended" and take the tidy keeper-respawn path.
        try {
          await session.send(HARD_MSG);
        } catch (e) {
          console.log(`[supervisor] hard-mark send failed (${e}); child gone → exiting for keeper`);
          break;
        }
        awaitingCheckpoint = true;
        continue;
      }
      if (used >= softTokens && !nudgedSoft) {
        await recordEvent(cfg, { who: "supervisor", kind: "soft-mark", ctx: used });
        try {
          await session.send(SOFT_MSG);
        } catch (e) {
          console.log(`[supervisor] soft-mark send failed (${e}); child gone → exiting for keeper`);
          break;
        }
        nudgedSoft = true;
        continue;
      }
      // Turn-boundary prompt. The always-on poller (above) feeds `inbox`; here — at the only safe
      // point to hand the agent new input — we decide what to send next:
      //   • Parked (bin/park wrote the idle sentinel and ended the turn): the SUPERVISOR owns the
      //     wait, blocking on the queue and re-invoking the agent only when the human writes. This
      //     keeps the model asleep while idle instead of burning a ~92K-token turn on every poll.
      //   • Busy but messages queued while the agent worked: deliver them NOW instead of a bare
      //     "continue", so a message that arrived mid-turn is handled the instant the turn ends
      //     (rather than waiting for the agent to happen to park).
      //   • Otherwise: a plain "continue" to prompt the next work cycle.
      // Any failure degrades to CONTINUE so a bug here can never wedge or crash-loop the loop.
      let nextPrompt = CONTINUE;
      if (existsSync(idleSentinel)) {
        await rm(idleSentinel, { force: true });
        io.phase = "parked";
        await stat("idle");
        try {
          nextPrompt = await waitForInboxMessages(inbox, watchdog, () => stat("idle"));
        } catch (e) {
          console.log(`[supervisor] idle-wait failed (${e}); falling back to continue`);
          nextPrompt = CONTINUE;
        }
        io.phase = "busy";
        io.acked = false;
      } else {
        // Not parked: drain anything the poller queued while this turn ran, and deliver it.
        const queued = inbox.drain();
        if (queued.length) {
          nextPrompt = formatInboxPrompt(queued);
          io.acked = false;
          await recordEvent(cfg, {
            who: "supervisor",
            kind: "inbox-deliver",
            detail: `${queued.length} line(s) at boundary`,
          });
        }
      }
      // If the child died right after the last result, the write can throw EPIPE; treat that as
      // "process ended" and fall through to the tidy keeper-respawn path rather than surfacing
      // an uncaught error. (Same handling as before — only the prompt is now idle-aware.)
      try {
        await session.send(nextPrompt);
      } catch (e) {
        console.log(`[supervisor] continue send failed (${e}); child gone → exiting for keeper`);
        break;
      }
    }

    await session.stop();
    if (ended === "auth") {
      // The model is down, so the SUPERVISOR asks the human: it sends the sign-in URL over the
      // existing channel, blocks on the same inbox watermark the idle-wait uses until the code
      // arrives, and pastes it in. On success we relaunch fresh; on anything else we exit so the
      // keeper respawns with backoff (the relay blocks on the human, so this can't spam them).
      await stat("auth-required");
      // Same safety net the recycle path takes, for the same reason: whatever happens next —
      // relaunch fresh, or exit for the keeper — this life's context is gone, so anything the
      // agent wrote to notes/ since its last push has to reach foreman-state now or not at all.
      syncNotes(cfg, "checkpoint before re-login");
      // Hold back whatever the poller queued BEFORE the lockout. Those are ordinary messages for
      // the agent, sent before the human was ever asked for a code — hand them to the relay and
      // the LAST of them would be read as the sign-in code (and pasted into the login prompt).
      // They are not dropped: the queue is restored below on the way back into the loop, and
      // echoed to the human on the way out. The relay only ever sees lines that arrive after the
      // sign-in URL was sent.
      const heldBack = inbox.drain();
      // The relay is now the queue's only reader (the parked wait cannot run — the session is
      // stopped), which is what keeps InboxQueue's one-waiter rule satisfied.
      io.phase = "relogin";
      // Re-stamp the status between inbox waits: the relay can block on the human for the better
      // part of an hour, and a status that old reads as "quiet"/wedged on the dashboard.
      const outcome = await recoverAuth(
        watchdog,
        inbox,
        passthroughEnv,
        sawHealthyTurn,
        authDetail,
        () => stat("auth-required"),
      );
      io.phase = "busy";
      io.acked = false;
      await recordEvent(cfg, { who: "supervisor", kind: "relogin", detail: outcome });
      if (outcome === "recovered") {
        // Put the pre-lockout messages back at the FRONT of the agent's next boundary delivery —
        // push() no-ops on an empty list, and nothing is waiting on the queue right now.
        inbox.push(heldBack);
        continue;
      }
      console.log(`[supervisor] re-login ${outcome} → exiting for keeper to respawn`);
      // We are about to exit, so this in-memory copy is the last one: the watermark moved past
      // these lines when the poller read them, and no future life will ever see them. The relay
      // hands back its own consumed-but-unused lines the same way; these are the ones it never
      // saw, so handing them back is on us.
      if (heldBack.length) {
        await sendTelegramAck(
          "[harness] I went down for re-authentication before I could handle these, and could " +
            "not recover — please re-send anything that still needs an answer:\n" +
            heldBack.join("\n"),
        );
      }
      watchdog.stop();
      poller.stop();
      return;
    }
    if (ended === "recycle") {
      await recordEvent(cfg, { who: "supervisor", kind: "recycle", detail: `life #${life}` });
      await stat("recycling");
      // Safety net: persist notes to foreman-state before we drop the context, even if the
      // agent didn't push during its checkpoint turn.
      syncNotes(cfg, "checkpoint before context recycle");
      console.log("[supervisor] relaunching fresh (context recycled)");
      continue;
    }
    // Process exited on its own (crash or clean stop). The keeper will respawn the
    // whole harness; exiting here lets it apply backoff. Stop the watchdog and the poller on this
    // clean return so neither's async work outlives the loop (belt-and-suspenders alongside the
    // process.exit path — the timer is unref()ed, but tidy shutdown shouldn't rely on that).
    watchdog.stop();
    poller.stop();
    console.log("[supervisor] agent process ended; exiting for keeper to respawn");
    await recordEvent(cfg, { who: "supervisor", kind: "exit", detail: `life #${life}` });
    return;
  }
}
