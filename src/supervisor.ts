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
  classifyUrgency,
  formatInboxPrompt,
  formatWorkerWakePrompt,
  freshAfterInjection,
  InboxQueue,
  sendTelegramAck,
  startInboxPoller,
  waitForWakeup,
} from "./inbox.ts";
import { promptTokens, usageTotal } from "./protocol.ts";
import { handBackLines, makeAuthDetector, makeAuthRecovery } from "./relogin.ts";
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

/**
 * Parse the wait-on sentinel: newline-separated worker names the parked agent is blocking on.
 * Missing file or any read error → [] (the agent then parks human-only). Names are charset-
 * validated to match spawn-worker's guard, so the derived `state/<name>.done` path is always safe.
 */
async function readWaitOn(path: string): Promise<string[]> {
  try {
    const body = await readFile(path, "utf8");
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z0-9_-]+$/.test(l));
  } catch {
    return [];
  }
}

export async function supervise(cfg: Config): Promise<void> {
  const bootstrap = await readFile(cfg.bootstrapPromptPath, "utf8");
  const clearSentinel = join(cfg.stateDir, "clear-request");
  // Written by bin/park when the agent goes idle: the supervisor (not the model) then owns the
  // wait for the next human message. See the idle-aware keep-alive at the bottom of the loop.
  const idleSentinel = join(cfg.stateDir, "idle-wait");
  // Written by bin/wait-on alongside idle-wait: newline-separated worker names the agent is
  // blocking on. While parked the supervisor also wakes on any of their done-markers, not only on
  // a human message — so the agent no longer re-arms a 10-min bash waiter across an hours-long run.
  const waitOnSentinel = join(cfg.stateDir, "wait-on");
  // A parked-on worker has finished iff spawn-worker's wrapper has touched its done-marker.
  const workerDone = (name: string) => existsSync(join(cfg.stateDir, `${name}.done`));
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
  // When the current model turn began (null between turns / while parked), surfaced on the status
  // so a viewer can see how long the agent has been heads-down.
  let turnStartedAt: string | null = null;
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
      queued: inbox.size(),
      turnStartedAt,
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
  // `awaitingCheckpoint` mirrors the per-life local so the poller's urgent-interrupt hook (created
  // once, before the loop) can see it: never interrupt a turn that is already checkpointing to
  // recycle. `currentSession` is the live session the hook interrupts; reset each life.
  const io = {
    phase: "busy" as "busy" | "parked" | "relogin",
    acked: false,
    awaitingCheckpoint: false,
    // Streamed-injection bookkeeping (only used when cfg.streamInject). `injectedThisTurn` is the
    // set of lines already streamed into the current turn, so the boundary does not re-deliver
    // them; `interrupted` records that the turn was preempted, in which case injected-but-maybe-
    // unconsumed lines MUST be re-delivered (the interrupt can cancel the CLI's queued input).
    injectedThisTurn: new Set<string>(),
    interrupted: false,
  };
  let currentSession: Session | undefined;
  // The dashboard state each phase shows, as a table rather than restated at every flip. In
  // particular the relogin phase must never be stamped with a healthy-looking "working" at the one
  // moment the human reading the dashboard is the only thing that can unwedge the harness.
  const PHASE_STATE = {
    busy: "working",
    parked: "idle",
    relogin: "auth-required",
  } as const satisfies Record<typeof io.phase, SupervisorState>;
  // Re-stamp the status for whatever phase we are in now. Handed to the poller (so an empty poll
  // keeps the dashboard fresh) and to the re-login relay, which can block on the human for the
  // better part of an hour — a status that old reads as "quiet"/wedged.
  const refresh = () => stat(PHASE_STATE[io.phase]);
  const poller = startInboxPoller(cfg, passthroughEnv, inbox, {
    isBusy: () => io.phase === "busy",
    onBusyMessage: async (lines) => {
      // Urgent (an explicit !/​/now token, or a follow-up after we already acked once): preempt the
      // in-flight turn so the human is answered in seconds instead of after the whole (maybe
      // hour-long) turn. The interrupt ends the current turn with an error result; the turn-boundary
      // path below then drains and delivers these very lines. Never interrupt a turn that is already
      // checkpointing to recycle, or one that isn't actually running (parked/relogin).
      if (
        cfg.urgentInterrupt &&
        io.phase === "busy" &&
        !io.awaitingCheckpoint &&
        classifyUrgency(lines, io.acked)
      ) {
        try {
          await currentSession?.interrupt();
          io.interrupted = true; // the boundary must re-deliver any injected-but-cancelled lines
          await recordEvent(cfg, {
            who: "supervisor",
            kind: "inbox-interrupt",
            detail: `${lines.length} urgent line(s) — preempting turn`,
          });
          return;
        } catch (e) {
          // interrupt failed (child gone / protocol refused) — fall through to the ordinary ack so
          // the human is not met with silence, and let the normal boundary path deliver the lines.
          console.log(`[supervisor] urgent interrupt failed (${e}); falling back to ack`);
        }
      }
      // Non-urgent, and streamed injection is enabled: push the lines into the running turn now (the
      // CLI queues them) so they are picked up sooner than the turn boundary. The lines STAY in the
      // inbox queue — they are only marked injected so the boundary de-dupes them (freshAfterInjection);
      // an interrupt later this turn clears that via io.interrupted so nothing is lost. Marked before
      // the await so a boundary landing mid-send still sees them as injected. Best-effort: on a failed
      // send we un-mark them and let the ordinary boundary path deliver.
      if (cfg.streamInject && io.phase === "busy" && !io.awaitingCheckpoint) {
        for (const l of lines) io.injectedThisTurn.add(l);
        try {
          await currentSession?.send(formatInboxPrompt(lines));
          await recordEvent(cfg, {
            who: "supervisor",
            kind: "inbox-inject",
            detail: `${lines.length} line(s) streamed mid-turn`,
          });
        } catch (e) {
          for (const l of lines) io.injectedThisTurn.delete(l);
          console.log(`[supervisor] stream-inject failed (${e}); leaving for boundary delivery`);
        }
      }
      if (io.acked) return; // already acked this busy stretch — don't spam
      io.acked = true;
      await sendTelegramAck(
        "👀 Got it — I'm mid-task right now. I'll pick this up at my next checkpoint (or send " +
          "'!' / '/now' to interrupt me). No need to resend.",
      );
      await recordEvent(cfg, {
        who: "supervisor",
        kind: "inbox-queued",
        detail: `${lines.length} line(s) while busy`,
      });
    },
    refresh,
  });

  // Re-login relay: a dead OAuth token makes every turn fail instantly, which the loop would
  // otherwise continue into forever with the model never running. The engine selector chooses the
  // CLI-specific, tightly-pinned signal and the matching recovery flow together. ONE detector for
  // the whole run: FOREMAN_FAKE_AUTH_REQUIRED is one-shot per instance, so a per-life detector
  // would re-inject every life.
  const authDetector = makeAuthDetector(cfg.fakeAuthRequired, cfg.reloginEngine);
  // Owns the rest of the policy (enabled?, hot-loop breaker, which agent to re-auth) — see
  // makeAuthRecovery. Built once: the breaker's state has to span lives to spot a hot loop.
  const recoverAuth = makeAuthRecovery(cfg);

  // Outer loop: each iteration is one fresh agent lifetime (until a recycle or exit).
  for (;;) {
    watchdog.touch();
    const session = new Session(cfg);
    currentSession = session; // the poller's urgent-interrupt hook targets this
    session.start({ env: passthroughEnv });
    await session.send(bootstrap);
    watchdog.touch();
    life++;
    lastUsed = 0;
    io.phase = "busy";
    io.acked = false;
    io.awaitingCheckpoint = false;
    turnStartedAt = new Date().toISOString();
    console.log(`[supervisor] agent launched; bootstrap sent (engine=${cfg.sessionEngine})`);
    await recordEvent(cfg, {
      who: "supervisor",
      kind: "launch",
      detail: `life #${life}; engine ${cfg.sessionEngine}`,
    });
    await refresh();

    let awaitingCheckpoint = false;
    let nudgedSoft = false;
    // Did any assistant frame this turn carry usage? If so it is the authoritative occupancy and
    // the result frame's (cumulative) total is ignored; if not, we fall back to the clamped result.
    let sawUsageThisTurn = false;
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
      if (ev.type === "assistant") {
        // Per-turn occupancy: an assistant frame's message.usage is the actual prompt size (input +
        // cached prefix) = current window fill. Clamp — a reading above the window is a counting
        // artifact, never real occupancy, so ignore it rather than trip a spurious recycle.
        const occ = promptTokens(ev.message?.usage);
        if (occ > 0 && occ <= cfg.contextWindow) {
          lastUsed = occ;
          sawUsageThisTurn = true;
        }
        continue;
      }
      if (ev.type !== "result") continue;
      // A turn that FAILED is not evidence the session was ever working, so it must not reset the
      // hot-loop breaker — otherwise a life that errors out and then hits the auth frame looks
      // healthy every time and the breaker never trips on the spin it exists to catch.
      if (ev.is_error !== true) sawHealthyTurn = true;
      // Occupancy came from this turn's assistant frames (above). If none carried usage (an older
      // CLI, or the mock), fall back to the result frame's total, clamped — a result total above
      // the window is the known cumulative-usage artifact and must never drive recycling.
      if (!sawUsageThisTurn) {
        const rt = usageTotal(ev.usage);
        if (rt > 0 && rt <= cfg.contextWindow) lastUsed = rt;
      }
      sawUsageThisTurn = false;
      const used = lastUsed;
      if (used) {
        console.log(`[supervisor] turn complete; context ≈ ${used}/${cfg.contextWindow}`);
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
        io.awaitingCheckpoint = true; // the poller must not interrupt a checkpoint-in-progress turn
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
        // bin/wait-on may also have listed detached workers to block on; consume that sentinel too
        // and wake on EITHER a human message or any of those workers finishing.
        const workers = await readWaitOn(waitOnSentinel);
        await rm(waitOnSentinel, { force: true });
        io.phase = "parked";
        turnStartedAt = null; // no model turn runs while parked
        await refresh();
        try {
          const wake = await waitForWakeup(inbox, watchdog, refresh, workerDone, workers);
          if (wake.kind === "worker") {
            nextPrompt = formatWorkerWakePrompt(wake.done);
            await recordEvent(cfg, {
              who: "supervisor",
              kind: "worker-wake",
              detail: wake.done.join(", "),
            });
          } else {
            nextPrompt = formatInboxPrompt(wake.lines);
          }
        } catch (e) {
          console.log(`[supervisor] parked wait failed (${e}); falling back to continue`);
          nextPrompt = CONTINUE;
        }
        io.phase = "busy";
        io.acked = false;
      } else {
        // Not parked: drain anything the poller queued while this turn ran. Under streamed
        // injection, lines already streamed into this turn were delivered mid-flight, so drop them
        // here UNLESS the turn was interrupted (then the CLI may have cancelled its queued input, so
        // re-deliver). With injection off, injectedThisTurn is empty ⇒ this is exactly the old drain.
        const queued = inbox.drain();
        const deliver = io.interrupted ? queued : freshAfterInjection(queued, io.injectedThisTurn);
        if (deliver.length) {
          nextPrompt = formatInboxPrompt(deliver);
          io.acked = false;
          await recordEvent(cfg, {
            who: "supervisor",
            kind: "inbox-deliver",
            detail: `${deliver.length} line(s) at boundary`,
          });
        }
      }
      // If the child died right after the last result, the write can throw EPIPE; treat that as
      // "process ended" and fall through to the tidy keeper-respawn path rather than surfacing
      // an uncaught error. (Same handling as before — only the prompt is now idle-aware.)
      // A fresh turn begins with this prompt: reset the per-turn injection bookkeeping and stamp
      // the start time.
      io.injectedThisTurn.clear();
      io.interrupted = false;
      turnStartedAt = new Date().toISOString();
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
      // Flip the phase FIRST, before anything that yields: `isBusy()` still reads "busy" until
      // this lands, so a message the poller picks up during the awaits below would draw the
      // "I'm mid-task" auto-ack — the one reply this path must never send.
      io.phase = "relogin";
      await refresh();
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
      // The relay is now the queue's only reader (the parked wait cannot run — the session is
      // stopped), which is what keeps InboxQueue's one-waiter rule satisfied.
      const heldBack = inbox.drain();
      const outcome = await recoverAuth(
        watchdog,
        inbox,
        passthroughEnv,
        sawHealthyTurn,
        authDetail,
        refresh,
      );
      await recordEvent(cfg, { who: "supervisor", kind: "relogin", detail: outcome });
      if (outcome === "recovered") {
        io.phase = "busy";
        io.acked = false;
        // Put the pre-lockout messages back at the FRONT of the agent's next boundary delivery.
        // push() appends, so re-queue them AHEAD of anything the poller delivered during the
        // re-login and the relay left behind — otherwise the older messages arrive last. push()
        // no-ops on an empty list, and nothing is waiting on the queue right now.
        inbox.push([...heldBack, ...inbox.drain()]);
        continue;
      }
      // Phase stays "relogin" on the way out: flipping back to "busy" here would let the poller
      // answer a message arriving during the notify below with the "I'm mid-task, I'll pick this
      // up at my next checkpoint" auto-ack — a promise the harness is seconds from breaking.
      console.log(`[supervisor] re-login ${outcome} → exiting for keeper to respawn`);
      // Stop the poller BEFORE the final drain: it is still filling the queue, and anything it
      // pushes after the drain has nothing left to read it — the process exits and the watermark
      // has already moved past those lines (invariant 3).
      watchdog.stop();
      await poller.stop();
      // We are about to exit, so this in-memory copy is the last one: the watermark moved past
      // these lines when the poller read them, and no future life will ever see them. The relay
      // hands back its own consumed-but-unused lines the same way; these are the ones it never
      // saw, so handing them back is on us.
      await handBackLines(
        cfg,
        passthroughEnv,
        "[harness] I went down for re-authentication before I could handle these, and could " +
          "not recover — please re-send anything that still needs an answer:",
        [...heldBack, ...inbox.drain()],
      );
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
    await poller.stop();
    console.log("[supervisor] agent process ended; exiting for keeper to respawn");
    await recordEvent(cfg, { who: "supervisor", kind: "exit", detail: `life #${life}` });
    return;
  }
}
