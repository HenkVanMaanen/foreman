// The supervisor: the harness's core loop. It keeps the foreman agent alive, seeds it
// with the bootstrap prompt, watches token usage, and forces a checkpoint-and-recycle
// before the context window fills. On recycle it relaunches FRESH (empty context) — the
// agent rehydrates from its own notes, so nothing is lost.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { usageTotal } from "./protocol.ts";
import { Session } from "./session.ts";

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
  const hardTokens = Math.floor(cfg.contextWindow * cfg.hardMark);
  const softTokens = Math.floor(cfg.contextWindow * cfg.softMark);

  // Channel creds are passed through so the agent's own scripts can use them.
  const passthroughEnv = pickEnv([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "MATTERMOST_BASE_URL",
    "MATTERMOST_BOT_TOKEN",
    "MATTERMOST_CHANNEL_ID",
  ]);

  // Outer loop: each iteration is one fresh agent lifetime (until a recycle or exit).
  for (;;) {
    const session = new Session(cfg);
    session.start({ env: passthroughEnv });
    await session.send(bootstrap);
    console.log("[supervisor] agent launched; bootstrap sent");

    let awaitingCheckpoint = false;
    let nudgedSoft = false;
    let recycle = false;

    for await (const ev of session.events()) {
      if (ev.type !== "result") continue;
      const used = usageTotal(ev.usage);
      if (used) console.log(`[supervisor] turn complete; context ≈ ${used}/${cfg.contextWindow}`);

      if (awaitingCheckpoint) {
        console.log("[supervisor] checkpoint turn complete → recycling");
        recycle = true;
        break;
      }
      if (existsSync(clearSentinel)) {
        await rm(clearSentinel, { force: true });
        console.log("[supervisor] agent requested clear → recycling");
        recycle = true;
        break;
      }
      if (used >= hardTokens) {
        console.log("[supervisor] hard mark hit → asking agent to checkpoint");
        await session.send(HARD_MSG);
        awaitingCheckpoint = true;
        continue;
      }
      if (used >= softTokens && !nudgedSoft) {
        await session.send(SOFT_MSG);
        nudgedSoft = true;
        continue;
      }
      // Keep the work loop alive: prompt the next cycle. The agent's own scripts
      // (wait-reply / wait-for-work) block when there's nothing to do, so this does
      // not spin.
      await session.send(CONTINUE);
    }

    await session.stop();
    if (recycle) {
      console.log("[supervisor] relaunching fresh (context recycled)");
      continue;
    }
    // Process exited on its own (crash or clean stop). The keeper will respawn the
    // whole harness; exiting here lets it apply backoff.
    console.log("[supervisor] agent process ended; exiting for keeper to respawn");
    return;
  }
}

function pickEnv(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = process.env[n];
    if (v) out[n] = v;
  }
  return out;
}
