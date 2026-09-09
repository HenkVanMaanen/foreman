// Credential-free agent helpers. Mutations travel to the resident-owned control endpoint.
import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import {
  checkApproval,
  enqueueApproval,
  finishApproval,
  reviewApproval,
} from "./thread-approval.ts";
import { enqueueOutbox } from "./thread-outbox.ts";
import { safeId } from "./thread-store.ts";
import { repoPolicy } from "./threads.ts";

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "outbox") {
    const key = safeId(process.env["FOREMAN_THREAD_KEY"] || "");
    const state = process.env["FOREMAN_STATE_DIR"];
    if (!state) throw new Error("thread state directory required");
    const text = await Bun.stdin.text();
    if (!text.trim()) throw new Error("reply text required on stdin");
    enqueueOutbox(state, key, text, `${Date.now()}-${randomUUID()}`);
  } else if (
    command === "approval-request" ||
    command === "approval-review" ||
    command === "approval-check" ||
    command === "approval-finish"
  ) {
    const key = safeId(process.env["FOREMAN_THREAD_KEY"] || "");
    const state = process.env["FOREMAN_STATE_DIR"];
    if (!state) throw new Error("thread state directory required");
    if (command === "approval-request") {
      const [source, target, head, actions] = args;
      if (args.length !== 4)
        throw new Error("approval-request needs source, PR URL, head, JSON actions");
      console.log(
        enqueueApproval(state, key, { source, target, head, actions: JSON.parse(actions || "") }),
      );
    } else if (command === "approval-review") {
      const [id = ""] = args;
      if (args.length !== 1) throw new Error("approval-review needs a handoff id");
      console.log(await reviewApproval(state, key, id, process.cwd()));
    } else if (command === "approval-check") {
      const [id = "", target = "", head = "", action = ""] = args;
      if (args.length !== 4) throw new Error("approval-check needs id, PR URL, head, action");
      console.log(
        JSON.stringify(checkApproval(state, key, id, process.cwd(), target, head, action)),
      );
    } else {
      const [id = "", head = "", note = ""] = args;
      if (args.length !== 3)
        throw new Error("approval-finish needs id, reviewed head, result note");
      finishApproval(state, key, id, process.cwd(), head, note);
    }
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
