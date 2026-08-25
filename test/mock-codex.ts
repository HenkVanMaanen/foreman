#!/usr/bin/env bun
// mock-codex — offline auth relay/verifier double. It never handles a real credential.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const authOkFile = process.env.MOCK_CODEX_AUTH_OK ?? "state/mock-codex-auth-ok";
const callsFile = process.env.MOCK_CODEX_CALLS ?? "state/mock-codex-calls.txt";
appendFileSync(callsFile, `${process.argv.slice(2).join(" ")}\n`);

async function runResidentSession(): Promise<never> {
  const args = process.argv.slice(2);
  const resumed = args[1] === "resume";
  const livesFile = process.env.MOCK_CODEX_LIVES_FILE ?? "state/mock-codex-session-lives";
  let life: number;
  let threadId: string;
  if (resumed) {
    threadId = args.find((arg) => /^mock-codex-life-[0-9]+$/.test(arg)) ?? "";
    if (!threadId) throw new Error(`mock-codex: resume missing thread id: ${args.join(" ")}`);
    life = Number(threadId.slice("mock-codex-life-".length));
  } else {
    life = (existsSync(livesFile) ? Number(readFileSync(livesFile, "utf8")) : 0) + 1;
    writeFileSync(livesFile, String(life));
    threadId = `mock-codex-life-${life}`;
  }

  const turnsFile = `state/mock-codex-life-${life}-turns`;
  const turn = (existsSync(turnsFile) ? Number(readFileSync(turnsFile, "utf8")) : 0) + 1;
  writeFileSync(turnsFile, String(turn));
  const prompt = await Bun.stdin.text();
  appendFileSync(
    "state/mock-codex-prompts.txt",
    `life=${life} turn=${turn} ${prompt.replaceAll("\n", " ").slice(0, 100)}\n`,
  );
  process.stderr.write(
    `[mock-codex-session] life ${life} turn ${turn}: "${prompt.slice(0, 40)}…"\n`,
  );

  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  // A later process that exits before a terminal event models a CLI/session crash. The adapter
  // must end the life so the outer keeper can respawn, rather than inventing an endless turn loop.
  if (life >= 2 && turn >= 2) process.exit(0);

  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  if (prompt.includes("checkpoint NOW")) {
    emit({ type: "item.completed", item: { type: "agent_message", text: "DONE" } });
    emit({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 1 } });
    process.exit(0);
  }
  if (life >= 2) {
    emit({ type: "item.completed", item: { type: "agent_message", text: "resumed from notes" } });
    emit({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 3 } });
    process.exit(0);
  }

  const used = turn * Number(process.env.MOCK_STEP ?? "300");
  emit({ type: "item.completed", item: { type: "agent_message", text: `working ${turn}` } });
  emit({
    type: "turn.completed",
    usage: { input_tokens: used, cached_input_tokens: Math.max(0, used - 50), output_tokens: 999 },
  });
  process.exit(0);
}

if (process.argv[2] === "exec" && process.argv.includes("--json")) {
  await runResidentSession();
}

if (process.argv[2] === "exec") {
  const mode = process.env.MOCK_CODEX_VERIFY ?? "state";
  const live = mode === "healthy" || (mode === "state" && existsSync(authOkFile));
  if (live) {
    process.stdout.write("PONG\n");
    process.exit(0);
  }
  process.stderr.write(
    "ERROR: Your access token could not be refreshed because your refresh token was revoked. " +
      "Please log out and sign in again.\n",
  );
  process.exit(1);
}

if (process.argv[2] === "login" && process.argv[3] === "--device-auth") {
  process.stdout.write("https://auth.openai.com/codex/device\n");
  process.stdout.write("Enter this one-time code\n    TEST-CODEX\n");
  // Leave the process alive after the banner so the relay forwards the phone instructions before
  // the self-polling login completes, matching the ordering of a human authorizing in a browser.
  await Bun.sleep(Number(process.env.MOCK_CODEX_LOGIN_DELAY_MS ?? "200"));
  if ((process.env.MOCK_CODEX_LOGIN_RESULT ?? "success") === "success") {
    writeFileSync(authOkFile, "ok\n");
  }
  process.exit(0);
}

// Deliberately lie like the real local-only command did during the July incident. The relay must
// never invoke this branch; lifecycle assertions pin that down from callsFile.
if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

process.stderr.write(`mock-codex: unsupported argv: ${process.argv.slice(2).join(" ")}\n`);
process.exit(2);
