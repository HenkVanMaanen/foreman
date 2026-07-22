// Supervisor-owned messaging. An ALWAYS-ON inbox poller (startInboxPoller) is the single
// Telegram consumer for the harness's whole lifetime — it runs while the agent works, not only
// while it's parked. New human messages land in an InboxQueue; the supervisor delivers them to
// the agent at the next turn boundary (or wakes it immediately if parked), and fires a cheap
// supervisor-side auto-ack (sendTelegramAck) when a message arrives mid-task so the human is
// never met with silence. This is what stops the agent going deaf during a long work turn: the
// old design only polled inside the parked branch, so a life that never parked never listened.
//
// Two invariants the poller must preserve:
//   1) It never touch()es the watchdog. A wedged agent produces no stream frames; if the poller
//      kept the watchdog alive, that wedge would go undetected. Only the agent's own frames and
//      the parked-wait keep-alive touch it (see supervisor.ts).
//   2) It is the ONLY caller of `wait-reply --inbox`. Every other reader — the parked path, and
//      the re-login relay waiting for a sign-in code (src/relogin.ts) — consumes from the shared
//      queue rather than spawning its own poll, so Telegram getUpdates has exactly one consumer.
//      (ask-human's single-thread wait-reply is serialized against it by a sentinel in the
//      script — see wait-reply.sh.)
//   3) A line taken off the queue is GONE from it: the watermark moved when the poller read it,
//      so the in-memory copy is the only one left. Whoever takes a line therefore owns it, and
//      must either use it, deliver it to the agent, or hand it back — via InboxQueue.push (which
//      returns lines to the queue) or by echoing it to the human. Never drop one on the floor,
//      and never let two readers claim the same line. InboxQueue supports ONE waiter at a time,
//      which is what keeps "two readers" from arising in the first place: the supervisor hands
//      the queue to the relay only while its own parked wait is not running.
//
// Any error or unexpected condition degrades to a plain "continue" (see supervisor.ts), so a bug
// in this path can never wedge or crash-loop the agent's life-support loop.

import type { Config } from "./config.ts";
import type { Heartbeat } from "./watchdog.ts";
import { binPath, harnessChildEnv } from "./workspace.ts";

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
  | { kind: "messages"; lines: string[] } // exit 0: the raw MSG/ACK lines
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
    const lines = extractInboxLines(stdout);
    // exit 0 with no MSG/ACK lines is unexpected: treat as an error → fall back to CONTINUE rather
    // than waking the agent with an empty inbox prompt.
    if (lines.length === 0) return { kind: "error", reason: "exit 0 but no MSG/ACK lines" };
    return { kind: "messages", lines };
  }
  if (exitCode === 3) return { kind: "keep-polling" };
  return { kind: "error", reason: `wait-reply exited ${exitCode}` };
}

/** The recognized MSG/ACK lines from a `wait-reply --inbox` stdout, trailing whitespace trimmed. */
export function extractInboxLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith("MSG ") || l.startsWith("ACK "));
}

/**
 * Wrap the raw MSG/ACK lines (verbatim, so nothing the agent needs is lost — wait-reply already
 * advanced the watermarks and reacted eyes, so the agent will NOT see these again via its own
 * poll) in the prompt the agent receives on wake.
 */
export function formatInboxPrompt(msgLines: string[]): string {
  return (
    "[inbox] New message(s) from the human since you parked:\n" +
    `${msgLines.join("\n")}\n\n` +
    "Handle them (reply in the correct thread; a leading '-' in the 2nd field means a new root). " +
    "An `ACK <post_id> <root_or_-> +1` line means the human approved that post with a 👍 (no reply " +
    "text) — treat it as their go-ahead on that post."
  );
}

/**
 * A single-consumer buffer of unread MSG/ACK lines. The always-on poller pushes new lines; the
 * supervisor drains them — either non-blocking at a turn boundary (`drain`) or blocking while the
 * agent is parked (`take`). Only ONE waiter is supported at a time, which is all the single main
 * loop ever needs.
 */
export class InboxQueue {
  private buf: string[] = [];
  private waiter: ((lines: string[]) => void) | null = null;

  /** Append newly-seen lines (from one wait-reply batch) and hand them to a blocked waiter, if any. */
  push(lines: string[]): void {
    if (lines.length === 0) return;
    this.buf.push(...lines);
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(this.drain());
    }
  }

  /** How many lines are buffered right now. */
  size(): number {
    return this.buf.length;
  }

  /** Take everything buffered right now, clearing the buffer. Never blocks. */
  drain(): string[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }

  /**
   * Block up to `timeoutMs` for at least one line, then return the drained lines. Returns [] on
   * timeout (so the caller can touch the watchdog and re-block — legitimate idle is not a wedge).
   */
  take(timeoutMs: number): Promise<string[]> {
    if (this.buf.length) return Promise.resolve(this.drain());
    // ONE waiter, enforced rather than merely documented. Two readers now exist (the parked
    // idle-wait and the re-login relay), and they are kept apart by control flow alone. Were that
    // ever to slip, a second take() would overwrite the first's resolver: the loser would hang to
    // its own timeout while the winner took its lines — and since a line off this queue is gone
    // from the shared watermark (invariant 3), those lines have no other copy. Every caller
    // already degrades a throw to a safe fallback, so failing loudly here is strictly better than
    // losing the human's messages silently.
    if (this.waiter) return Promise.reject(new Error("InboxQueue: a reader is already waiting"));
    return new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve([]);
      }, timeoutMs);
      this.waiter = (lines) => {
        clearTimeout(timer);
        resolve(lines);
      };
    });
  }
}

export interface InboxPoller {
  /**
   * Stop polling and resolve once the loop has actually exited. Awaitable, and it kills the
   * in-flight `wait-reply`, because a bare flag is not enough to satisfy invariant 3: that child
   * has already advanced the watermark for whatever it is about to print, so a caller that drains
   * the queue and exits while it is still running loses that batch for good. Killing it collapses
   * the window to the child's own read-then-advance, and awaiting the loop guarantees anything it
   * did manage to return is in the queue before the caller's final drain.
   */
  stop(): Promise<void>;
}

export interface PollerHooks {
  /** True while the agent is mid-turn (not parked) — the poller auto-acks in that case. */
  isBusy: () => boolean;
  /** Called with each fresh batch that arrived while busy, so the supervisor can auto-ack once. */
  onBusyMessage: (lines: string[]) => void | Promise<void>;
  /** Called after every empty poll so the dashboard's idle state stays fresh. */
  refresh?: () => void | Promise<void>;
}

/**
 * Start the ONE always-on inbox poller. Loops `wait-reply --inbox` for the harness's lifetime,
 * pushing new lines into `queue` and auto-acking (via `onBusyMessage`) when the agent is busy.
 *
 * Deliberately never touches the watchdog (see the file header): keeping it alive here would mask
 * a wedged agent. Never throws out of the loop — any error just backs off and retries, because a
 * transient channel failure must not take the poller down for the rest of the harness's life.
 */
export function startInboxPoller(
  cfg: Config,
  env: Record<string, string>,
  queue: InboxQueue,
  hooks: PollerHooks,
): InboxPoller {
  const waitReply = binPath("wait-reply");
  // harnessChildEnv pins FOREMAN_STATE_DIR from config so wait-reply reads/advances the SAME inbox
  // watermark the agent's own bin/ used; otherwise a $HOME/.foreman fallback would drain a
  // different watermark.
  const childEnv = harnessChildEnv(cfg, env, {
    FOREMAN_WAIT_TIMEOUT: String(WAIT_TIMEOUT_S),
  });

  let stopped = false;
  // The `wait-reply` currently running, so stop() can end it rather than wait out its ~250s poll.
  let inflight: { kill: () => void } | undefined;
  const loop = (async () => {
    let fastEmpties = 0;
    while (!stopped) {
      const started = Date.now();
      let stdout = "";
      let exitCode = 1;
      try {
        const proc = Bun.spawn([waitReply, "--inbox"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
          env: childEnv,
        });
        inflight = proc;
        if (stopped) proc.kill(); // stop() landed between the flag check and the spawn
        stdout = await new Response(proc.stdout).text();
        exitCode = await proc.exited;
        inflight = undefined;
      } catch {
        // spawn failed (missing bin, fork limit): treat as a fast empty and back off below.
        exitCode = 1;
      }
      const action = classifyInbox(exitCode, stdout);
      if (action.kind === "messages") {
        fastEmpties = 0;
        // Push BEFORE honouring stop(): this batch's watermark was already advanced by the
        // wait-reply that just returned, so a batch dropped here is gone for good (invariant 3).
        // Whoever stopped us drains the queue afterwards and hands the leftovers back.
        queue.push(action.lines);
        if (stopped) break;
        if (hooks.isBusy()) {
          try {
            await hooks.onBusyMessage(action.lines);
          } catch {
            // an ack failure must never disturb polling
          }
        }
        continue;
      }
      if (stopped) break;

      // keep-polling (exit 3) or error: guard against a hot spin (wait-reply returning far faster
      // than its ~250s timeout ⇒ misconfig/API error), then refresh idle state and loop. Unlike the
      // old parked-only wait, we never throw — the poller must survive transient channel failures.
      if (Date.now() - started < FAST_TIMEOUT_MS) {
        if (++fastEmpties >= MAX_FAST_EMPTIES) {
          await Bun.sleep(2_000);
          fastEmpties = 0;
        }
      } else {
        fastEmpties = 0;
      }
      if (hooks.refresh) {
        try {
          await hooks.refresh();
        } catch {
          // refresh is best-effort dashboard sugar
        }
      }
    }
    // A kill mid-poll leaves the child un-reaped if we bailed out before awaiting it.
    inflight = undefined;
    // Never rejects in practice (every await inside is guarded), but stop() awaits this and must
    // not turn a poller bug into an unhandled rejection on the caller's shutdown path.
  })().catch((e) => console.error(`[inbox] poller loop ended abnormally: ${e}`));

  return {
    async stop() {
      stopped = true;
      inflight?.kill();
      await loop;
    },
  };
}

/**
 * The text of a `MSG <id> <root_or_-> <text…>` line — everything after the third space — or "" for
 * a line that carries none (an `ACK` reaction-ack, a blank-texted `MSG`).
 *
 * Exported because takeAnswer() is not the only caller that has to reason about a line's text: the
 * re-login relay filters the sign-in code it already pasted out of the lines it hands back, and
 * that filter has to match on exactly what takeAnswer() selected by. One rule, one place.
 */
export function inboxMsgText(line: string): string {
  return line.startsWith("MSG ") ? line.split(" ").slice(3).join(" ").trim() : "";
}

/**
 * Split inbox lines into the human's answer and everything else.
 *
 * `text` is the text of the last `MSG <id> <root> <text>` line that CARRIES text — later messages
 * supersede earlier ones, so a typo'd first attempt followed by a correction does the right thing.
 * `ACK` (👍) lines carry no text and are never the answer, and neither is a blank-texted `MSG`.
 * Used by the re-login relay (src/relogin.ts) to read the sign-in code the human relayed back.
 *
 * `rest` is every line NOT consumed as the answer, in order. Returned together with `text` rather
 * than left for the caller to re-derive: a line taken off the queue is gone from it, so the relay
 * has to hand the unused ones back and this is their only remaining copy — and identifying them
 * any other way means restating the selection rule. An equality filter, for instance, would drop
 * BOTH of two identical lines when only one of them was read as the answer. One function, so the
 * rule lives in one place.
 */
export function takeAnswer(lines: string[]): { text: string | undefined; rest: string[] } {
  // A blank-texted MSG line is NOT an answer, so it is skipped here and stays in `rest` like any
  // other spare. Skipped rather than merely rejected after the fact: a blank line arriving in the
  // SAME batch after a real one (the human sends the code, then a whitespace-only follow-up) must
  // not hide the code — the batch still carries an answer, and dropping it would burn an attempt
  // and echo the live code back to the human instead of pasting it in.
  const i = lines.findLastIndex((l) => inboxMsgText(l) !== "");
  const text = i === -1 ? undefined : inboxMsgText(lines[i] as string);
  return { text, rest: text === undefined ? [...lines] : lines.filter((_, n) => n !== i) };
}

/**
 * Block (cheaply, off the model) until the always-on poller delivers a human message, then RETURN
 * the raw `MSG`/`ACK` lines. Consumes from the shared queue rather than polling itself, so
 * Telegram getUpdates keeps exactly one consumer (invariant 2 in the file header). Touches the
 * heartbeat on every wake — including the empty timeout wakes — so a legitimately long wait is
 * never mistaken for a wedge, and calls `refresh` between them to keep the dashboard status fresh.
 *
 * The idle-wait wraps the result in formatInboxPrompt(); the re-login relay reads the human's
 * literal text off it with takeAnswer(). Both come off the SAME queue — and so the same watermark
 * — which is what makes double-consumption impossible. The flip side is that a line handed to one
 * of them is gone for the other, so whatever a caller does not use it must hand back (relay) or
 * deliver (supervisor); see InboxQueue.push, which takes lines back.
 *
 * `deadlineMs` (epoch ms) bounds the wait, clamping each individual `take` to whatever is left of
 * it and THROWING once it passes. Omitted, the wait is indefinite, which is what the idle-wait
 * wants (a parked agent may legitimately wait days). The re-login relay passes one because its
 * sign-in URL EXPIRES: without a bound, a human who never answers leaves the relay blocked forever
 * on a link that is already dead, instead of failing the attempt and sending a fresh one.
 */
export async function waitForInboxLines(
  queue: InboxQueue,
  watchdog: Heartbeat,
  refresh: () => void | Promise<void>,
  deadlineMs?: number,
): Promise<string[]> {
  for (;;) {
    // Check the deadline BEFORE blocking, not after: a full-length take started just under the
    // wire would overshoot it by up to WAIT_TIMEOUT_S, and the relay's deadline is the life of a
    // sign-in link that has already expired by then.
    const waitMs =
      deadlineMs === undefined
        ? WAIT_TIMEOUT_S * 1_000
        : Math.min(WAIT_TIMEOUT_S * 1_000, deadlineMs - Date.now());
    if (waitMs <= 0) throw new Error("no message from the human before the deadline");
    const lines = await queue.take(waitMs);
    watchdog.touch(); // legitimate waiting is not a wedge — keep the heartbeat alive
    if (lines.length) return lines;
    // The refresh is cosmetic (a dashboard status re-stamp), so a failing one must never abort
    // the wait: for the re-login relay this wait IS a login in progress, and throwing out of it
    // kills the login child mid-sign-in. Same guard, same reason, as awaitSliced()'s onTick in
    // relogin.ts.
    try {
      await refresh();
    } catch (e) {
      console.error(`[inbox] status refresh failed: ${e}`);
    }
  }
}

/**
 * Supervisor-side instant acknowledgement, sent DIRECTLY (no model turn) so a human who writes
 * while the agent is heads-down gets an immediate reply instead of silence. Telegram-only and
 * best-effort: a no-op if the creds are unset, and swallows all errors so it can never disturb the
 * supervisor loop. The token lives only in the in-process URL (never argv), so it isn't exposed via
 * ps/procfs the way a spawned curl would be.
 */
export async function sendTelegramAck(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort: an ack that fails to send must never wedge or crash the loop
  }
}
