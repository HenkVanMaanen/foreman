// Supervisor-owned idle wait. When the agent parks (bin/park writes the idle-wait sentinel and
// the agent ends its turn), the SUPERVISOR — not the model — blocks on `wait-reply --inbox` and
// re-invokes the agent ONLY when the human sends a message. This keeps the model asleep while
// idle instead of burning a full ~92K-token turn on every ~600s foreground park (measured at
// ~32% of total spend). Any error or unexpected condition here degrades to a plain "continue"
// (see supervisor.ts), so a bug in this path can never wedge or crash-loop the agent's
// life-support loop — the keeper only protects against crashes/exits.

import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { Watchdog } from "./watchdog.ts";

// Seconds per blocking `wait-reply --inbox` call. Bounded well under the watchdog timeout
// (default 20 min) so we touch() the watchdog between calls; on a timeout we simply loop and
// poll again — the model is not invoked.
const WAIT_TIMEOUT_S = 250;

// Spin guard: an exit-3 "timeout" that returns faster than a real ~250s wait is a sign wait-reply
// is failing fast in a loop (misconfig, transient API error). Bail after a few in a row so we
// degrade to CONTINUE instead of hot-looping. Legitimate long waits reset the counter, so genuine
// idle polling stays indefinite.
const FAST_TIMEOUT_MS = 2_000;
const MAX_FAST_EMPTIES = 5;

export type InboxAction =
  | { kind: "messages"; prompt: string } // exit 0: hand the raw MSG/ACK lines to the agent
  | { kind: "keep-polling" } // exit 3: nothing new, block again (model stays asleep)
  | { kind: "error"; reason: string }; // exit 2/other: caller falls back to CONTINUE

/**
 * Pure classifier for a single `wait-reply --inbox` result → the action the idle loop takes.
 * Factored out so the exit-code contract is unit-testable without a live Mattermost:
 *   exit 0 → messages (stdout carries MSG lines for posts and/or ACK lines for +1 reactions;
 *            empty/no recognized lines is unexpected → error)
 *   exit 3 → keep-polling (timeout, nothing new)
 *   other  → error (caller degrades to CONTINUE)
 *
 * An `ACK <post_id> <root_or_-> +1` line means the human 👍'd one of the agent's own posts while
 * it was parked — a reaction-ack, no reply text. It wakes the agent just like a MSG line.
 */
export function classifyInbox(exitCode: number, stdout: string): InboxAction {
  if (exitCode === 0) {
    const lines = stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith("MSG ") || l.startsWith("ACK "));
    // exit 0 with no MSG/ACK lines is unexpected: treat as an error → fall back to CONTINUE rather
    // than waking the agent with an empty inbox prompt.
    if (lines.length === 0) return { kind: "error", reason: "exit 0 but no MSG/ACK lines" };
    return { kind: "messages", prompt: formatInboxPrompt(lines.join("\n")) };
  }
  if (exitCode === 3) return { kind: "keep-polling" };
  return { kind: "error", reason: `wait-reply exited ${exitCode}` };
}

/**
 * Wrap the raw MSG/ACK lines (verbatim, so nothing the agent needs is lost — wait-reply already
 * advanced the watermarks and reacted eyes, so the agent will NOT see these again via its own
 * poll) in the prompt the agent receives on wake.
 */
export function formatInboxPrompt(msgLines: string): string {
  return (
    "[inbox] New message(s) from the human since you parked:\n" +
    `${msgLines}\n\n` +
    "Handle them (reply in the correct thread; a leading '-' in the 2nd field means a new root). " +
    "An `ACK <post_id> <root_or_-> +1` line means the human approved that post with a 👍 (no reply " +
    "text) — treat it as their go-ahead on that post."
  );
}

/**
 * Block (cheaply, off the model) until the human sends a message, then RETURN a non-empty prompt
 * carrying the new MSG lines. Loops calling `wait-reply --inbox` with a bounded per-call timeout,
 * touching the watchdog after each call so legitimate idle is never mistaken for a wedge.
 *
 * THROWS on any error/unexpected condition (non-{0,3} exit, spawn failure, spin) so the caller in
 * supervisor.ts degrades to CONTINUE. `refresh` is invoked between polls to keep the dashboard's
 * "idle" state fresh; `env` is the agent workspace env so FOREMAN_STATE_DIR (shared watermark) and
 * the channel creds reach wait-reply.
 */
export async function waitForInboxMessages(
  cfg: Config,
  watchdog: Watchdog,
  refresh: () => void | Promise<void>,
  env: Record<string, string>,
): Promise<string> {
  // Resolve bin/ the same way ensureWorkspace() seeds it (relative to the harness cwd). An
  // absolute path avoids depending on the child env's PATH resolution; a missing file makes
  // Bun.spawn throw → caught by the caller → CONTINUE.
  const waitReply = join(resolve("bin"), "wait-reply");
  // Pin FOREMAN_STATE_DIR from config so wait-reply reads/advances the SAME inbox watermark the
  // agent used (its bin/ ran with this dir). If it fell back to $HOME/.foreman the supervisor
  // would drain a different watermark and the agent could miss or re-see messages.
  const childEnv = {
    ...process.env,
    ...env,
    FOREMAN_STATE_DIR: resolve(cfg.stateDir),
    FOREMAN_WAIT_TIMEOUT: String(WAIT_TIMEOUT_S),
  };

  let fastEmpties = 0;
  for (;;) {
    const started = Date.now();
    const proc = Bun.spawn([waitReply, "--inbox"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: childEnv,
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    watchdog.touch(); // legitimate waiting is not a wedge — keep the watchdog alive

    const action = classifyInbox(exitCode, stdout);
    if (action.kind === "messages") return action.prompt;
    if (action.kind === "error") throw new Error(action.reason);

    // keep-polling: guard against a tight spin (wait-reply returning empty far too fast), then
    // refresh the idle status and loop. The model stays asleep across every iteration.
    if (Date.now() - started < FAST_TIMEOUT_MS) {
      if (++fastEmpties >= MAX_FAST_EMPTIES) {
        throw new Error(`wait-reply returned empty ${fastEmpties}× rapidly — treating as a spin`);
      }
    } else {
      fastEmpties = 0;
    }
    await refresh();
  }
}
