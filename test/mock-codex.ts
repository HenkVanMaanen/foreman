#!/usr/bin/env bun
// mock-codex — offline auth relay/verifier double. It never handles a real credential.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const authOkFile = process.env.MOCK_CODEX_AUTH_OK ?? "state/mock-codex-auth-ok";
const callsFile = process.env.MOCK_CODEX_CALLS ?? "state/mock-codex-calls.txt";
appendFileSync(callsFile, `${process.argv.slice(2).join(" ")}\n`);

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
