#!/usr/bin/env bun
// mock-claude — a fake `claude -p --*-format stream-json` for exercising the supervisor.
//
// It ignores the real CLI flags, reads user-message JSON lines from stdin, and emits
// stream-json frames on stdout. Usage grows each turn so the run crosses the soft then
// hard context marks; on the hard-checkpoint prompt it "saves a journal" and lets the
// supervisor recycle it. A cross-process lives-counter file lets the scenario end after
// one recycle so the test terminates.
//
// Env:
//   MOCK_LIVES_FILE  path to a counter file (defaults to state/mock-lives)
//   MOCK_STEP        usage increment per turn (default 300)

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// `auth status` / `auth login` — the re-login relay shells out to the SAME binary for these, so
// they must be answered before anything below (no lives counter, no stream-json init frame).
// Handled here rather than in a second mock so the relay is driven through exactly the binary
// the supervisor was configured with.
const authOkFile = process.env.MOCK_AUTH_OK ?? "state/mock-auth-ok";
if (process.argv[2] === "auth") {
  if (process.argv[3] === "status") {
    // Shape claudeAuthStatus() parses. Absent file → logged out.
    process.stdout.write(`${JSON.stringify({ loggedIn: existsSync(authOkFile) })}\n`);
    process.exit(0);
  }
  if (process.argv[3] === "login") {
    // A URL, then a trailing prompt: matchComplete() needs at least one byte AFTER the link to
    // prove it is not still arriving, which is exactly what the real CLI's prompt supplies.
    process.stdout.write("Browser did not open. Visit:\n");
    process.stdout.write("https://claude.ai/oauth/authorize?code=true&state=mock123\n");
    process.stdout.write("Paste code here: ");
    // Under `script -qec` stdin IS the pty, so the relayed code arrives here.
    for await (const chunk of Bun.stdin.stream()) {
      const code = new TextDecoder().decode(chunk).trim();
      if (!code) continue;
      // To DISK, not stderr: under `script -qec` our stderr is the pty, which the relay drains
      // and discards once it has the URL — so a stderr line here is unobservable to the test.
      writeFileSync(`${authOkFile}.code`, `${code}\n`);
      if (code !== (process.env.MOCK_AUTH_CODE ?? "GOODCODE")) {
        // Faithful to the real CLI: a wrong code RE-PROMPTS, it does not exit. The relay's
        // bounded awaitSliced + retry loop only exists because of that, so a mock that exited 0
        // here would make the whole bad-code path untestable.
        process.stdout.write("\nInvalid code. Paste code here: ");
        continue;
      }
      writeFileSync(authOkFile, "ok\n");
      process.stdout.write("\nLogin successful.\n");
      process.exit(0);
    }
    process.exit(1);
  }
  process.exit(2);
}

const livesFile = process.env.MOCK_LIVES_FILE ?? "state/mock-lives";
const step = Number(process.env.MOCK_STEP ?? "300");
// "usage" (default): grow usage to cross the context marks and force a recycle.
// "clear": request an agent-initiated recycle by dropping the clear sentinel.
const mode = process.env.MOCK_MODE ?? "usage";
const clearSentinel = process.env.MOCK_CLEAR_SENTINEL ?? "state/clear-request";

const life = (existsSync(livesFile) ? Number(readFileSync(livesFile, "utf8")) : 0) + 1;
writeFileSync(livesFile, String(life));

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

emit({ type: "system", subtype: "init", session_id: `mock-life-${life}` });
process.stderr.write(`[mock-claude] life ${life} started\n`);

let turn = 0;
const dec = new TextDecoder();
let buf = "";

for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;

    let content = "";
    try {
      content = JSON.parse(line)?.message?.content ?? "";
    } catch {
      continue;
    }
    turn++;
    process.stderr.write(`[mock-claude] life ${life} turn ${turn}: "${content.slice(0, 40)}…"\n`);

    // The harness asked us to checkpoint — simulate saving a journal and reply DONE.
    if (content.includes("checkpoint NOW")) {
      emit({ type: "assistant", session_id: `mock-life-${life}`, text: "journal saved. DONE" });
      emit({ type: "result", session_id: `mock-life-${life}`, usage: { output_tokens: 20 } });
      continue; // supervisor recycles on this result
    }

    // Second life (post-recycle): prove we resumed, then end on the next nudge so the
    // supervisor returns and the test finishes.
    if (life >= 2) {
      if (turn >= 2) {
        process.stderr.write(`[mock-claude] life ${life} exiting to end test\n`);
        process.exit(0);
      }
      emit({ type: "assistant", session_id: `mock-life-${life}`, text: "resumed from notes" });
      emit({ type: "result", session_id: `mock-life-${life}`, usage: { output_tokens: 50 } });
      continue;
    }

    // Clear-scenario: on the second turn, the agent decides to recycle itself by
    // writing the sentinel and stopping its turn normally.
    if (mode === "clear" && turn >= 2) {
      writeFileSync(clearSentinel, "requested by mock\n");
      process.stderr.write(`[mock-claude] life ${life} wrote clear sentinel\n`);
      emit({ type: "result", session_id: `mock-life-${life}`, usage: { output_tokens: 10 } });
      continue; // supervisor should detect the sentinel and recycle
    }

    // First life: escalating context usage to cross the soft then hard marks.
    const used = turn * step;
    emit({ type: "assistant", session_id: `mock-life-${life}`, text: `working (turn ${turn})` });
    emit({ type: "result", session_id: `mock-life-${life}`, usage: { input_tokens: used } });
  }
}
