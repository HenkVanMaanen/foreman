#!/usr/bin/env bun
// foreman — entrypoint and CLI.
//
//   foreman supervise                         run the agent supervisor (default)
//   foreman dashboard                          serve the read-only observability dashboard
//   foreman secret set NAME                    read a value from stdin, store it encrypted
//   foreman run --secret NAME[,NAME] -- cmd…   run cmd with the named secret(s) injected as env
//   foreman relogin [claude|codex] [--force]   drive the Telegram-mediated re-auth by hand
//
// Designed to be spawned by keeper.sh, which restarts it on exit.

import { type Config, loadConfig } from "./config.ts";
import { runDashboard, supervisorIsRunning } from "./dashboard.ts";
import { InboxQueue, startInboxPoller } from "./inbox.ts";
import { handBackLines, RELOGIN_AGENTS } from "./relogin.ts";
import { runWithSecrets, secretSetFromStdin } from "./secrets.ts";
import { supervise } from "./supervisor.ts";
import { NO_HEARTBEAT } from "./watchdog.ts";
import { ensureWorkspace } from "./workspace.ts";

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const [cmd, ...rest] = argv;

  switch (cmd ?? "supervise") {
    case "supervise":
      await supervise(cfg);
      return 0;

    case "dashboard":
      await runDashboard(cfg); // blocks until killed
      return 0;

    case "secret": {
      if (rest[0] !== "set" || !rest[1]) {
        console.error("usage: foreman secret set NAME   (value is read from stdin)");
        return 2;
      }
      await secretSetFromStdin(cfg, rest[1]);
      return 0;
    }

    // Drive the Telegram-mediated re-auth by hand — the same code path the supervisor triggers
    // automatically, so a real lockout can be recovered (or rehearsed) without the loop running.
    case "relogin":
      return await runRelogin(cfg, rest);

    case "run": {
      const { names, command } = parseRun(rest);
      if (names.length === 0 || command.length === 0) {
        console.error("usage: foreman run --secret NAME[,NAME] -- cmd [args…]");
        return 2;
      }
      return await runWithSecrets(cfg, names, command);
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.error(
        "commands: supervise | dashboard | secret set NAME | run --secret NAME -- cmd | " +
          "relogin [claude|codex] [--force]",
      );
      return 2;
  }
}

/**
 * `foreman relogin [claude|codex] [--force]` — the manual arm of the re-login relay. A function
 * rather than an inline `case` body: it owns a poller and a finally that has to hand consumed
 * inbox lines back, which is a lifecycle of its own and not something to read past on the way
 * through the CLI's dispatch table.
 */
async function runRelogin(cfg: Config, rest: string[]): Promise<number> {
  // --force starts the flow even when the session still looks live — that is what makes this
  // a rehearsal rather than a no-op. Off by default: for codex it would clear a WORKING
  // ~/.codex/auth.json the moment device-auth starts.
  const force = rest.includes("--force");
  // Every argument is accounted for. A typo'd flag must not be silently ignored: `relogin claude
  // --forse` would otherwise run WITHOUT force, hit the "already logged in?" guard, and exit 0
  // having done nothing — which reads as "the rehearsal passed". Anything left after --force is
  // removed must be the one agent name, so a stray token and a typo'd flag fail the same way.
  const [which = "claude", ...extra] = rest.filter((a) => a !== "--force");
  // A Map, so an inherited member name (`foreman relogin constructor`) is simply a miss
  // rather than something that resolves off Object.prototype and gets called as a flow.
  const flow = extra.length ? undefined : RELOGIN_AGENTS.get(which);
  if (!flow) {
    console.error(`usage: foreman relogin [${[...RELOGIN_AGENTS.keys()].join("|")}] [--force]`);
    return 2;
  }
  // Refuse to run alongside a live supervisor. This command starts its own inbox poller, and
  // `wait-reply --inbox` must have exactly ONE consumer (inbox.ts invariant 2): a second one
  // races the supervisor's for the same Telegram watermark, and every message it wins is
  // consumed off the agent's inbox for good. The loop already recovers auth by itself, so
  // there is nothing this command adds while it is up.
  if (await supervisorIsRunning(cfg)) {
    console.error(
      "foreman relogin: a supervisor loop is already running — it recovers auth on its own, " +
        "and a second inbox poller would steal the agent's messages. Stop it first.",
    );
    return 2;
  }
  // Seed the workspace exactly as supervise() does before it calls the same relay: the flow
  // shells out to bin/reply, bin/ask-human and bin/wait-reply, which only exist — and only
  // see PATH/FOREMAN_* — once ensureWorkspace() has run. Without this the manual recovery
  // path dies with ENOENT on the very box where the loop is not running.
  const env = await ensureWorkspace(cfg);
  // The relay reads the human's reply off an InboxQueue rather than polling itself, so this
  // path has to supply the poller the supervisor would normally own. Safe precisely because
  // the loop is NOT running here: `wait-reply --inbox` still has exactly one consumer, which
  // is the invariant that keeps a message from being consumed twice. Stopped in a finally so
  // the poll does not keep the CLI alive after the flow returns.
  //
  // Started ONLY for a flow that reads the queue (see ReloginFlow.readsInbox). A poller is
  // not a passive listener: every line it reads is consumed off the shared watermark, so
  // running one through codex's self-polling device-auth wait — which never reads the queue
  // — would swallow up to 16 minutes of the human's messages just to echo them back below.
  const inbox = new InboxQueue();
  const poller = flow.readsInbox
    ? startInboxPoller(cfg, env, inbox, {
        // Nothing to auto-ack for: the relay is itself the thing talking to the human, and a
        // "I'm mid-task" ack on top of "please send me the sign-in code" is just noise.
        isBusy: () => false,
        onBusyMessage: () => {},
      })
    : undefined;
  try {
    // No stall detection here: a human-paced re-login is legitimately slow, and nothing is
    // running that a force-exit could rescue.
    return (await flow.run(cfg, NO_HEARTBEAT, inbox, env, force)) ? 0 : 1;
  } finally {
    // AWAITED, so the poll that is in flight right now is killed and its batch (if any) lands in
    // the queue before the drain below — a bare flag would let it push after we had already
    // decided there was nothing left to hand back.
    await poller?.stop();
    // The poller ADVANCED the shared watermark for every line it read, so whatever is still
    // buffered here is the last copy in existence (inbox.ts invariant 3): the claude flow
    // leaves behind anything that landed after its last wait, so exiting without this
    // silently eats every message the human sent while they were re-authenticating. Hand
    // them back. (No-op for a flow that never started a poller — nothing was consumed.)
    await handBackLines(
      cfg,
      env,
      "[harness] I consumed these off the inbox while re-authenticating and never " +
        "delivered them — please re-send anything that still needs an answer:",
      inbox.drain(),
    );
  }
}

export function parseRun(args: string[]): { names: string[]; command: string[] } {
  const names: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    const next = args[i + 1];
    if (a === "--secret" && next) {
      i++;
      names.push(
        ...next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      // unknown token before `--`: treat as malformed
      return { names, command: [] };
    }
  }
  return { names, command: args.slice(i) };
}

// Only run the CLI when executed directly (`bun src/foreman.ts …`), not when imported by a
// test that pulls in a pure helper like parseRun.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
