// Credential-free agent helpers. Mutations travel to the resident-owned control endpoint.
import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { safeId, writeJson } from "./thread-store.ts";
import { repoPolicy } from "./threads.ts";

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "outbox") {
    const key = safeId(process.env["FOREMAN_THREAD_KEY"] || "");
    const state = process.env["FOREMAN_STATE_DIR"];
    if (!state) throw new Error("thread state directory required");
    const text = await Bun.stdin.text();
    if (!text.trim()) throw new Error("reply text required on stdin");
    writeJson(join(state, "thread-outbox", key, `${Date.now()}-${randomUUID()}.json`), {
      text,
      queuedAt: performance.timeOrigin + performance.now(),
    });
  } else if (command === "policy-get") {
    console.log(
      JSON.stringify(repoPolicy(process.env["FOREMAN_NOTES_DIR"] || "notes", args[0] || "")),
    );
  } else {
    const token = process.env["FOREMAN_ROUTER_TOKEN"];
    const socket = process.env["FOREMAN_ROUTER_SOCKET"];
    if (!token || !socket || process.env["FOREMAN_THREAD_KEY"])
      throw new Error("resident control capability required");
    const message = args[args[1] === "--dry-run" ? 2 : 1];
    const readStdin =
      (command === "ask-human" && args[0] === "-") ||
      (command === "reply" &&
        (message === undefined || (message === "-" && fstatSync(0).isFIFO())));
    const text = readStdin ? await Bun.stdin.text() : "";
    const response = await fetch("http://localhost/control", {
      unix: socket,
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ args: [command, ...args], text }),
    });
    const output = await response.text();
    if (!response.ok) throw new Error(output);
    process.stdout.write(output);
  }
} catch (error) {
  console.error(`thread-control: ${error instanceof Error ? error.message : "request failed"}`);
  process.exit(1);
}
