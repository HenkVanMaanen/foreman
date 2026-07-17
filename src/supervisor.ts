// The supervisor: the harness's core loop. It keeps the foreman agent alive, seeds it
// with the bootstrap prompt, watches token usage, and forces a checkpoint-and-recycle
// before the context window fills. On recycle it relaunches FRESH (empty context) — the
// agent rehydrates from its own notes, so nothing is lost.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { recordEvent, writeStatus } from "./dashboard.ts";
import { waitForInboxMessages } from "./inbox.ts";
import { usageTotal } from "./protocol.ts";
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
  const home = resolve(import.meta.dir, "..");
  const workspaceEnv = await ensureWorkspace(cfg, home);

  // Env for the agent: workspace (PATH + FOREMAN_HOME) on top of the full inherited process
  // env. Session.start() already spreads ...process.env into the child, so every channel cred
  // (TELEGRAM_*, MATTERMOST_*, incl. MATTERMOST_TARGET_USER) reaches the agent's scripts by
  // inheritance — no explicit allowlist needed. (An allowlist here would only re-copy vars the
  // child already has, and previously omitted MATTERMOST_TARGET_USER while doing so.)
  const passthroughEnv = { ...workspaceEnv };

  // Track for the dashboard: which fresh lifetime we're on, and the last observed usage.
  let life = 0;
  let lastUsed = 0;
  const stat = (state: string) =>
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

  // Outer loop: each iteration is one fresh agent lifetime (until a recycle or exit).
  for (;;) {
    watchdog.touch();
    const session = new Session(cfg);
    session.start({ env: passthroughEnv });
    await session.send(bootstrap);
    watchdog.touch();
    life++;
    lastUsed = 0;
    console.log("[supervisor] agent launched; bootstrap sent");
    await recordEvent(cfg, { who: "supervisor", kind: "launch", detail: `life #${life}` });
    await stat("working");

    let awaitingCheckpoint = false;
    let nudgedSoft = false;
    let recycle = false;

    for await (const ev of session.events()) {
      watchdog.touch(); // any frame (thinking, tool use, result) is a sign of life
      if (ev.type !== "result") continue;
      const used = usageTotal(ev.usage);
      if (used) {
        console.log(`[supervisor] turn complete; context ≈ ${used}/${cfg.contextWindow}`);
        lastUsed = used;
        await recordEvent(cfg, { who: "supervisor", kind: "turn", ctx: used });
        await stat("working");
      }

      if (awaitingCheckpoint) {
        console.log("[supervisor] checkpoint turn complete → recycling");
        recycle = true;
        break;
      }
      if (existsSync(clearSentinel)) {
        await rm(clearSentinel, { force: true });
        console.log("[supervisor] agent requested clear → recycling");
        await recordEvent(cfg, { who: "supervisor", kind: "clear" });
        recycle = true;
        break;
      }
      if (used >= hardTokens) {
        console.log("[supervisor] hard mark hit → asking agent to checkpoint");
        await recordEvent(cfg, { who: "supervisor", kind: "hard-mark", ctx: used });
        await session.send(HARD_MSG);
        awaitingCheckpoint = true;
        continue;
      }
      if (used >= softTokens && !nudgedSoft) {
        await recordEvent(cfg, { who: "supervisor", kind: "soft-mark", ctx: used });
        await session.send(SOFT_MSG);
        nudgedSoft = true;
        continue;
      }
      // Idle-aware keep-alive. Default to a plain "continue" to prompt the next work cycle.
      // But if the agent parked (bin/park wrote the idle sentinel and ended its turn), the
      // SUPERVISOR — not the model — owns the wait: block cheaply on wait-reply --inbox and
      // re-invoke the agent only when the human writes, delivering the message text in the next
      // prompt. This stops burning a full ~92K-token turn on every ~600s idle poll (~32% of
      // spend). Any failure in this path degrades to CONTINUE (the pre-existing behavior) so a
      // bug here can never wedge or crash-loop the loop — the keeper only catches crashes/exits.
      let nextPrompt = CONTINUE;
      if (existsSync(idleSentinel)) {
        await rm(idleSentinel, { force: true });
        await stat("idle");
        try {
          nextPrompt = await waitForInboxMessages(
            cfg,
            watchdog,
            () => stat("idle"),
            passthroughEnv,
          );
        } catch (e) {
          console.log(`[supervisor] idle-wait failed (${e}); falling back to continue`);
          nextPrompt = CONTINUE;
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
    if (recycle) {
      await recordEvent(cfg, { who: "supervisor", kind: "recycle", detail: `life #${life}` });
      await stat("recycling");
      // Safety net: persist notes to foreman-state before we drop the context, even if the
      // agent didn't push during its checkpoint turn.
      try {
        syncNotes(cfg, "checkpoint before context recycle");
      } catch (e) {
        console.log(`[supervisor] notes sync on recycle failed: ${e}`);
      }
      console.log("[supervisor] relaunching fresh (context recycled)");
      continue;
    }
    // Process exited on its own (crash or clean stop). The keeper will respawn the
    // whole harness; exiting here lets it apply backoff. Stop the watchdog on this clean
    // return so its interval doesn't outlive the loop (belt-and-suspenders alongside the
    // process.exit path — the timer is unref()ed, but tidy shutdown shouldn't rely on that).
    watchdog.stop();
    console.log("[supervisor] agent process ended; exiting for keeper to respawn");
    await recordEvent(cfg, { who: "supervisor", kind: "exit", detail: `life #${life}` });
    return;
  }
}
