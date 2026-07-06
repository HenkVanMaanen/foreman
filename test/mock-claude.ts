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
