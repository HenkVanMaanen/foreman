// Both supervisor and worker CLI publish through the same per-thread kernel lock.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, safeId, writeJson } from "./thread-store.ts";

interface Reply {
  id: string;
  text: string;
}
export interface OutboxEntry {
  file: string;
  item: {
    text: string;
    sent?: boolean;
    queuedAt?: number;
    chunks?: string[];
    sentChunks?: number;
  };
}

function outbox(state: string, key: string, reply: Reply | null): OutboxEntry[] {
  const dir = resolve(state, "thread-outbox", safeId(key));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = Bun.spawnSync(
    [
      "flock",
      "-x",
      "-w",
      "5",
      "-F",
      join(dir, ".lock"),
      process.execPath,
      "--no-env-file",
      import.meta.path,
      dir,
    ],
    {
      stdin: Buffer.from(JSON.stringify(reply)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error("thread outbox operation failed");
  return JSON.parse(result.stdout.toString()) as OutboxEntry[];
}

export function enqueueOutbox(state: string, key: string, text: string, id: string): void {
  outbox(state, key, { text, id: safeId(id) });
}

export function readOutbox(state: string, key: string): OutboxEntry[] {
  const dir = resolve(state, "thread-outbox", safeId(key));
  const order = readJson<string[] | null>(join(dir, ".order"), null);
  if (!order) return outbox(state, key, null);
  const known = new Set(order);
  if (readdirSync(dir).some((file) => file.endsWith(".json") && !known.has(file)))
    return outbox(state, key, null); // adopt legacy/interrupted publications under the writer lock
  // The atomic index is an append-only prefix of already published, immutable replies. A
  // concurrent append waits for the next drain; ordinary idle polling need not spawn a helper.
  return order.map((file) => ({
    file,
    item: readJson<OutboxEntry["item"]>(join(dir, file), { text: "" }),
  }));
}

if (import.meta.main) {
  // This process runs under flock: adoption and publication cannot interleave with other writers.
  const dir = process.argv[2];
  if (!dir) throw new Error("thread outbox directory required");
  const reply = JSON.parse(await Bun.stdin.text()) as Reply | null;
  const orderPath = join(dir, ".order");
  const order = readJson<string[]>(orderPath, []);
  const known = new Set(order);
  const entries = new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => [file, readJson<OutboxEntry["item"]>(join(dir, file), { text: "" })]),
  );
  // Adopt old queues in their existing timestamp/mtime order without renaming delivery IDs.
  // A crash after publishing a new file but before saving .order leaves one unknown file;
  // adopt it before any later enqueue. No sequence reservation can outlive its publication.
  const unlisted = [...entries]
    .filter(([file]) => !known.has(file))
    .map(([file, item]) => ({
      file,
      at: item?.queuedAt ?? statSync(join(dir, file)).mtimeMs,
    }))
    .sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  order.push(...unlisted.map(({ file }) => file));
  if (unlisted.length) writeJson(orderPath, order);
  if (reply) {
    const file = `${safeId(reply.id)}.json`;
    // A delivery ID names one immutable reply, including after it has been sent or replayed.
    // This also lets the supervisor mark sent without racing a worker payload replacement.
    if (!entries.has(file)) {
      writeJson(join(dir, file), { text: reply.text });
      order.push(file);
      writeJson(orderPath, order);
    }
    process.stdout.write("[]");
  } else {
    process.stdout.write(JSON.stringify(order.map((file) => ({ file, item: entries.get(file) }))));
  }
}
