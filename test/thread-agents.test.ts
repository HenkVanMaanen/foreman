// Unit and end-to-end mock checks. No real CLI, credentials, transport, poller reaper or supervisor.
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Config, loadConfig, parseChannelMode, parseThreadCap } from "../src/config.ts";
import { formatInboxPrompt } from "../src/inbox.ts";
import { authorizedPosts, type HumanPost, Mattermost, receiptPath } from "../src/mattermost.ts";
import { enqueueApproval } from "../src/thread-approval.ts";
import { enqueueOutbox, readOutbox } from "../src/thread-outbox.ts";
import { readJson, writeJson } from "../src/thread-store.ts";
import { type RunTurn, repoPolicy, ThreadRouter, type TurnResult } from "../src/threads.ts";
import { agentEnv } from "../src/workspace.ts";

const dirs: string[] = [];
const routers: ThreadRouter[] = [];
afterEach(async () => {
  for (const router of routers.splice(0)) await router.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fm-thread-"));
  dirs.push(dir);
  const cfg: Config = {
    ...loadConfig(),
    threadAgents: true,
    channelMode: "mattermost",
    maxThreadAgents: 2,
    stateDir: join(dir, "state"),
    notesDir: join(dir, "notes"),
    codexBin: "/nonexistent-codex-must-never-run",
  };
  const resident: string[] = [];
  const sent: { root: string; channel: string; text: string }[] = [];
  const router = (run?: RunTurn) => {
    const r = new ThreadRouter(
      cfg,
      { HOME: dir },
      (lines) => resident.push(...lines),
      run,
      async (t, text) => {
        sent.push({ root: t.root, channel: t.channel, text });
      },
    );
    routers.push(r);
    return r;
  };
  const post = (id: string, root = id, channel = "channel1", text = `work ${id}`) => {
    const value: HumanPost = { id, root, channel, sender: "henk", text, at: Date.now() };
    writeJson(receiptPath(cfg.stateDir, channel, id), value);
    return `mm:${channel}:${id}`;
  };
  const bind = (r: ThreadRouter, ref: string, suffix = ref) => {
    const cwd = join(dir, suffix.replaceAll(":", "-"));
    mkdirSync(cwd, { recursive: true });
    return r.command(r.token, ["bind", ref, "owner/repo", cwd]);
  };
  return { dir, cfg, router, post, bind, resident, sent };
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("mock barrier timed out");
    await Bun.sleep(5);
  }
}
function heldTurns() {
  const calls: { key: string; prompt: string; resume?: string; end: (r: TurnResult) => void }[] =
    [];
  const run: RunTurn = (t, prompt, session) => {
    const resume = t.sessionId;
    session(resume ?? `session-${t.key}`);
    return new Promise<TurnResult>((end) => {
      calls.push({ key: t.key, prompt, ...(resume ? { resume } : {}), end });
    });
  };
  return { calls, run };
}

test("roots stay with resident until explicitly bound; independent threads queue, cap, dedupe and resume", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const a = f.post("a");
  const b = f.post("b");
  const c = f.post("c");
  r.collect();
  await r.tick();
  expect(h.calls).toHaveLength(0);
  expect(f.resident).toHaveLength(3);
  f.bind(r, a);
  f.bind(r, b);
  f.bind(r, c);
  await r.tick();
  expect(h.calls).toHaveLength(2);
  f.post("a2", "a");
  r.collect();
  r.collect();
  await r.tick();
  expect(h.calls).toHaveLength(2);
  expect(r.snapshot().threads[0]?.pending).toEqual(["a", "a2"]);
  h.calls[0]?.end({ ok: true, text: "result a" });
  h.calls[1]?.end({ ok: true });
  await until(() => r.snapshot().threads.every((t) => t.status !== "running"));
  await r.tick();
  expect(h.calls).toHaveLength(4);
  const resumed = h.calls.find((call) => call.resume);
  expect(resumed?.resume).toBe(`session-${r.snapshot().threads.find((t) => t.root === "a")?.key}`);
  expect(resumed?.prompt).toContain('"id":"a2"');
  expect(resumed?.prompt).not.toContain('"id":"a",');
  for (const call of h.calls.slice(2)) call.end({ ok: true });
  await until(() => r.snapshot().threads.every((t) => t.status === "idle"));
  await r.drain();
  expect(f.sent.find((s) => s.text === "result a")).toEqual({
    channel: "channel1",
    root: "a",
    text: "result a",
  });
  r.collect();
  await r.tick();
  expect(h.calls).toHaveLength(4);
});

test("crashed handoff is recovered from receipts and completed sessions survive supervisor restart", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root");
  f.bind(r, ref);
  await r.tick();
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  await r.stop();
  f.post("later", "root"); // saved by poller; no stdout delivery
  const resumed = heldTurns();
  const next = f.router(resumed.run);
  await next.tick();
  expect(resumed.calls[0]?.resume).toBe(r.snapshot().threads[0]?.sessionId);
  expect(resumed.calls[0]?.prompt).toContain('"id":"later"');
  resumed.calls[0]?.end({ ok: true });
  await until(() => next.snapshot().threads[0]?.status === "idle");
});

test.each([
  "receipt read",
  "registry save",
])("routing survives %s failure and the scheduled tick recovers without another message", async (fault) => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  r.start();
  f.bind(r, f.post("root"));
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const followup = f.post("followup", "root");
  const triage = f.post("triage");
  const obstruction =
    fault === "receipt read"
      ? join(f.cfg.stateDir, "thread-inbox/broken.json")
      : `${path}.${process.pid}.tmp`;
  if (fault === "receipt read") writeFileSync(obstruction, "{");
  else mkdirSync(obstruction); // Force an atomic-write failure without changing the saved registry.

  const ordinary = ["MSG 123 - emergency message", "ACK 124 - +1"];
  expect(
    r.route([
      `MSG ${followup} root work followup`,
      `MSG ${triage} triage work triage`,
      ...ordinary,
    ]),
  ).toEqual(ordinary);
  expect(r.route(["MSG 125 - still listening"])).toEqual(["MSG 125 - still listening"]);
  await expect(r.tick()).rejects.toThrow();
  expect(f.resident).toEqual([]);
  expect(h.calls).toHaveLength(0);
  expect(readJson(path, null)).toEqual(persisted);

  rmSync(obstruction, { recursive: true });
  // No new poller batch: the existing timer must replay the receipts, including unseen triage.
  await until(() => h.calls.length === 1);
  expect(f.resident).toEqual([`MSG ${triage} triage work triage`]);
  expect(h.calls[0]?.prompt).toContain('"id":"followup"');
  expect(h.calls[0]?.prompt).not.toContain('"id":"triage"');
  expect(r.snapshot().threads[0]?.pending).toEqual(["root", "followup"]);
  expect(readJson(path, null)).toEqual(r.snapshot());
  r.collect();
  expect(f.resident).toHaveLength(1);
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  await r.tick();
  expect(h.calls).toHaveLength(1);
  expect(r.snapshot().threads[0]?.done).toEqual(["root", "followup"]);
});

test("prelaunch registry save failure releases the slot and retries the queued thread", async () => {
  const f = fixture();
  f.cfg.maxThreadAgents = 1;
  const h = heldTurns();
  const r = f.router(h.run);
  f.bind(r, f.post("root"));
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const obstruction = `${path}.${process.pid}.tmp`;
  const collect = r.collect.bind(r);
  const collection = spyOn(r, "collect").mockImplementationOnce(() => {
    collect();
    // Let collection persist, then fail only the checkpoint immediately before launch.
    mkdirSync(obstruction);
  });
  try {
    await expect(r.tick()).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    expect(r.snapshot().threads[0]?.status).toBe("queued");
    expect(r.snapshot().threads[0]?.pending).toEqual(["root"]);
    expect(readJson(path, null)).toEqual(persisted);
  } finally {
    collection.mockRestore();
    rmSync(obstruction, { recursive: true, force: true });
  }

  // Retry on the same router with a one-slot cap, without another incoming message.
  await r.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.prompt).toContain('"id":"root"');
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  expect(r.snapshot().threads[0]?.done).toEqual(["root"]);
});

test.each([
  true,
  false,
])("completion registry write failure is retained for retry (ok=%j)", async (ok) => {
  const f = fixture();
  f.cfg.maxThreadAgents = 1;
  const h = heldTurns();
  const r = f.router(h.run);
  r.start();
  f.bind(r, f.post("root"));
  f.bind(r, f.post("next"));
  await r.tick();
  expect(h.calls).toHaveLength(1);
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const obstruction = `${path}.${process.pid}.tmp`;
  mkdirSync(obstruction); // Fail the completion checkpoint after the turn has already run.
  try {
    h.calls[0]?.end({ ok, text: "completed reply" });
    await until(() => r.snapshot().threads.find((t) => t.root === "root")?.status !== "running");
    const completed = r.snapshot().threads.find((t) => t.root === "root");
    expect(completed?.status).toBe(ok ? "idle" : "failed");
    expect(completed?.done).toEqual(ok ? ["root"] : []);
    expect(completed?.pending).toEqual(ok ? [] : ["root"]);
    expect(completed?.inFlight).toEqual(ok ? undefined : ["root"]);
    expect(readJson(path, null)).toEqual(persisted);
    expect(f.resident).toEqual([]);
    await expect(r.tick()).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  } finally {
    rmSync(obstruction, { recursive: true, force: true });
  }

  // The scheduled tick retries persistence without new input and can reuse the released slot.
  await until(() => h.calls.length === 2);
  expect(h.calls[1]?.prompt).toContain('"id":"next"');
  expect(readJson(path, null)).toEqual(r.snapshot());
  expect(f.resident).toHaveLength(ok ? 0 : 1);
  h.calls[1]?.end({ ok: true });
  await until(() => r.snapshot().threads.find((t) => t.root === "next")?.status === "idle");
  await r.tick();
  expect(h.calls).toHaveLength(2);
  expect(readJson(path, null)).toEqual(r.snapshot());
  expect(f.sent.filter((reply) => reply.root === "root").map((reply) => reply.text)).toEqual([
    "Bound to a dedicated agent; queued for the next available slot.",
    ok
      ? "completed reply"
      : "Turn failed; messages retained. Resident must inspect and use thread-control retry.",
  ]);
});

test("shutdown during a routing failure leaves receipts recoverable by the next router", async () => {
  const f = fixture();
  const r = f.router();
  r.start();
  f.bind(r, f.post("root"));
  const followup = f.post("followup", "root");
  const triage = f.post("triage");
  const obstruction = join(f.cfg.stateDir, `threads/registry.json.${process.pid}.tmp`);
  mkdirSync(obstruction);
  await r.stop();
  // A poll already in flight can return its last batch after shutdown has begun.
  expect(
    r.route([
      `MSG ${followup} root work followup`,
      `MSG ${triage} triage work triage`,
      "MSG 123 - hand back on shutdown",
    ]),
  ).toEqual(["MSG 123 - hand back on shutdown"]);
  await r.stop();
  expect(f.resident).toEqual([]);

  rmSync(obstruction, { recursive: true });
  const h = heldTurns();
  const restarted = f.router(h.run);
  await restarted.tick();
  expect(f.resident).toEqual([`MSG ${triage} triage work triage`]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.prompt).toContain('"id":"followup"');
  h.calls[0]?.end({ ok: true });
  await until(() => restarted.snapshot().threads[0]?.status === "idle");
  expect(restarted.snapshot().threads[0]?.done).toEqual(["root", "followup"]);
});

test("resident delivery failure leaves triage eligible for retry after the registry was saved", () => {
  const f = fixture();
  let unavailable = true;
  const r = new ThreadRouter(f.cfg, {}, (lines) => {
    if (unavailable) throw new Error("resident unavailable");
    f.resident.push(...lines);
  });
  routers.push(r);
  const triage = f.post("triage");
  expect(r.route([`MSG ${triage} triage work triage`])).toEqual([]);
  expect(f.resident).toEqual([]);
  unavailable = false;
  r.collect();
  r.collect();
  expect(f.resident).toEqual([`MSG ${triage} triage work triage`]);
});

test("binding in Telegram emergency mode survives restart and resumes when Mattermost returns", async () => {
  const f = fixture();
  f.cfg.channelMode = "telegram";
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root");
  f.bind(r, ref);
  const bound = r.snapshot();
  expect(bound.threads).toHaveLength(1);
  expect(readJson(join(f.cfg.stateDir, "threads/registry.json"), null)).toEqual(bound);
  await r.stop();

  const paused = f.router(h.run);
  expect(paused.snapshot()).toEqual(bound);
  expect(f.bind(paused, ref)).toEqual(bound.threads[0]);
  f.post("followup", "root");
  await paused.tick();
  expect(h.calls).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  expect(f.resident).toHaveLength(0);
  await paused.stop();

  f.cfg.channelMode = "mattermost";
  const resumed = f.router(h.run);
  await resumed.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.key).toBe(bound.threads[0]?.key);
  expect(h.calls[0]?.prompt).toContain('"id":"root"');
  expect(h.calls[0]?.prompt).toContain('"id":"followup"');
  expect(f.sent).toEqual([
    {
      channel: "channel1",
      root: "root",
      text: "Bound to a dedicated agent; queued for the next available slot.",
    },
  ]);
  h.calls[0]?.end({ ok: true });
  await until(() => resumed.snapshot().threads[0]?.status === "idle");
  expect(resumed.snapshot().threads[0]?.done).toEqual(["root", "followup"]);
});

test("interrupted running batch replays with saved session and explicit at-least-once prompt", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  f.bind(r, f.post("root"));
  await r.tick();
  const persisted = r.snapshot();
  await r.stop();
  // Resolve the mock old process, then restore its last durable running checkpoint as a crash fixture.
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  writeJson(join(f.cfg.stateDir, "threads/registry.json"), persisted);
  const next = heldTurns();
  const restarted = f.router(next.run);
  await restarted.tick();
  expect(next.calls[0]?.resume).toBe(persisted.threads[0]?.sessionId);
  expect(next.calls[0]?.prompt).toContain("may be replayed after a crash");
  next.calls[0]?.end({ ok: true });
  await until(() => restarted.snapshot().threads[0]?.status === "idle");
});

test.each([
  false,
  true,
])("crash after final enqueue keeps follow-ups separate (sent=%j)", async (sent) => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root");
  f.post("root2", "root");
  f.bind(r, ref);
  await r.tick();
  f.post("followup1", "root");
  r.collect();
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, r.snapshot());
  h.calls[0]?.end({ ok: true, text: "original final" });
  await until(() => r.snapshot().threads[0]?.status === "queued");
  if (sent) await r.drain();
  await r.stop();
  // Keep the published final, but restore the registry from before batch acknowledgement.
  writeJson(path, persisted);
  f.post("followup2", "root");
  const replay = heldTurns();
  const restarted = f.router(replay.run);
  await restarted.tick();
  expect(replay.calls[0]?.resume).toBe(persisted.threads[0]?.sessionId);
  expect(replay.calls[0]?.prompt).toContain('"id":"root"');
  expect(replay.calls[0]?.prompt).toContain('"id":"root2"');
  expect(replay.calls[0]?.prompt).not.toContain('"id":"followup1"');
  expect(replay.calls[0]?.prompt).not.toContain('"id":"followup2"');
  replay.calls[0]?.end({ ok: true, text: "replayed final" });
  await until(() => restarted.snapshot().threads[0]?.status === "queued");
  expect(restarted.snapshot().threads[0]?.done).toEqual(["root", "root2"]);
  expect(restarted.snapshot().threads[0]?.pending).toEqual(["followup1", "followup2"]);
  await restarted.tick();
  expect(replay.calls).toHaveLength(2);
  expect(replay.calls[1]?.prompt).toContain('"id":"followup1"');
  expect(replay.calls[1]?.prompt).toContain('"id":"followup2"');
  expect(replay.calls[1]?.prompt).not.toContain('"id":"root"');
  expect(replay.calls[1]?.prompt).not.toContain('"id":"root2"');
  replay.calls[1]?.end({ ok: true, text: "follow-up final" });
  await until(() => restarted.snapshot().threads[0]?.status === "idle");
  await restarted.drain();
  await restarted.drain();
  expect(restarted.snapshot().threads[0]?.done).toEqual([
    "root",
    "root2",
    "followup1",
    "followup2",
  ]);
  expect(restarted.snapshot().threads[0]?.pending).toEqual([]);
  expect(f.sent.filter(({ text }) => text.endsWith("final"))).toEqual([
    { channel: "channel1", root: "root", text: "original final" },
    { channel: "channel1", root: "root", text: "follow-up final" },
  ]);
  expect(
    readOutbox(f.cfg.stateDir, persisted.threads[0]?.key ?? "missing")
      .filter(({ file }) => file.startsWith("final-"))
      .map(({ file }) => file),
  ).toEqual(["final-root.json", "final-followup1.json"]);
});

test("failed start retains queue, does not hot-loop, requires resident retry and does not invent a session", async () => {
  const f = fixture();
  let count = 0;
  const r = f.router(async () => {
    count++;
    throw new Error("spawn failed");
  });
  const ref = f.post("root");
  f.bind(r, ref);
  await r.tick();
  await until(() => r.snapshot().threads[0]?.status === "failed");
  await r.tick();
  await r.tick();
  expect(count).toBe(1);
  expect(f.resident).toHaveLength(1);
  expect(r.snapshot().threads[0]?.pending).toEqual(["root"]);
  expect(r.snapshot().threads[0]?.sessionId).toBeUndefined();
  expect(() => r.command("worker", ["retry", ref])).toThrow("resident authorization");
  r.command(r.token, ["retry", ref]);
  await r.tick();
  await until(() => r.snapshot().threads[0]?.status === "failed");
  expect(count).toBe(2);
  expect(f.resident).toHaveLength(2);
});

test("failed threads replay resident notifications after restart and recover queued follow-ups on retry", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  f.bind(r, f.post("root"));
  await r.tick();
  h.calls[0]?.end({ ok: false });
  await until(() => r.snapshot().threads[0]?.status === "failed");
  const failed = r.snapshot().threads[0];
  expect(f.resident).toHaveLength(1);
  await r.stop();
  f.resident.length = 0; // A supervisor crash loses the in-memory resident inbox.

  const resumed = heldTurns();
  const next = f.router(resumed.run);
  next.start();
  expect(f.resident).toEqual([`MSG mm:channel1:root root [harness] ${failed?.error}`]);
  await next.tick();
  await next.tick();
  expect(f.resident).toHaveLength(1);
  expect(resumed.calls).toHaveLength(0);
  expect(next.snapshot().threads[0]?.status).toBe("failed");

  const followup = f.post("followup", "root");
  next.collect();
  await next.tick();
  expect(f.resident).toEqual([
    `MSG mm:channel1:root root [harness] ${failed?.error}`,
    `MSG mm:channel1:followup root [harness] ${failed?.error}`,
  ]);
  expect(next.snapshot().threads[0]?.pending).toEqual(["root", "followup"]);
  expect(resumed.calls).toHaveLength(0);

  next.command(next.token, ["retry", followup]);
  await next.tick();
  expect(resumed.calls[0]?.resume).toBe(failed?.sessionId);
  expect(resumed.calls[0]?.prompt).toContain('"id":"root"');
  expect(resumed.calls[0]?.prompt).not.toContain('"id":"followup"');
  resumed.calls[0]?.end({ ok: true });
  await until(() => next.snapshot().threads[0]?.status === "queued");
  await next.tick();
  expect(resumed.calls[1]?.resume).toBe(failed?.sessionId);
  expect(resumed.calls[1]?.prompt).toContain('"id":"followup"');
  expect(resumed.calls[1]?.prompt).not.toContain('"id":"root"');
  resumed.calls[1]?.end({ ok: true });
  await until(() => next.snapshot().threads[0]?.status === "idle");
  expect(next.snapshot().threads[0]?.pending).toEqual([]);
  expect(next.snapshot().threads[0]?.done).toEqual(["root", "followup"]);
  expect(next.snapshot().threads[0]?.error).toBeUndefined();
  await next.stop();
  f.resident.length = 0;
  f.router().start();
  expect(f.resident).toHaveLength(0);
});

test("empty success without thread.started fails; busy orphan lock retains queue without failure", async () => {
  const f = fixture();
  const r = f.router(async () => ({ ok: true }));
  f.bind(r, f.post("root"));
  await r.tick();
  await until(() => r.snapshot().threads[0]?.status === "failed");
  const other = fixture();
  const r2 = other.router(async () => ({ ok: false, busy: true }));
  other.bind(r2, other.post("root"));
  await r2.tick();
  await until(() => r2.snapshot().threads[0]?.status === "queued");
  expect(r2.snapshot().threads[0]?.pending).toEqual(["root"]);
});

test("outbox destination comes only from binding, transport failure retains delivery across restart", async () => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root", "root", "channel2"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  const path = join(f.cfg.stateDir, "thread-outbox", t.key, "malicious.json");
  writeJson(path, { text: "hello", channel: "intruder", root: "other", destination: "elsewhere" });
  const failing = new ThreadRouter(
    f.cfg,
    {},
    () => {},
    async () => ({ ok: false }),
    async () => {
      throw new Error("offline");
    },
  );
  routers.push(failing);
  await failing.drain();
  expect(readJson<{ sent?: boolean }>(path, {}).sent).toBeUndefined();
  await r.drain();
  await r.drain();
  expect(f.sent.filter((s) => s.text === "hello")).toEqual([
    { text: "hello", root: "root", channel: "channel2" },
  ]);
});

test.each([
  { name: "ASCII", chunks: ["a".repeat(16383), "b".repeat(16383), "last chunk"] },
  { name: "Unicode", chunks: [`${"a".repeat(16382)}😀`, "🧵".repeat(16383), "\nlast chunk"] },
])("oversized $name replies resume durable chunks before later replies after restart", async ({
  chunks,
}) => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root", "root", "channel2"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  await r.drain();
  const text = chunks.join("");
  r.enqueueReply(t, text, "final-root");
  enqueueOutbox(f.cfg.stateDir, t.key, "later reply", "aaaa");
  await r.stop();

  const path = join(f.cfg.stateDir, "thread-outbox", t.key, "final-root.json");
  const orderPath = join(f.cfg.stateDir, "thread-outbox", t.key, ".order");
  const order = readJson<string[]>(orderPath, []);
  // Existing oversized entries also need recovery; they contain only the original text.
  expect(readJson(path, {})).toEqual({ text });
  const attempts: { text: string; id: string }[] = [];
  const sent: { text: string; id: string; channel: string; root: string }[] = [];
  let offline = true;
  const restart = () => {
    const next = new ThreadRouter(
      f.cfg,
      {},
      () => {},
      async () => ({ ok: false }),
      async (thread, part, id) => {
        attempts.push({ text: part, id });
        if (Array.from(part).length > 16383 || Buffer.byteLength(part) > 65535 || !part.trim())
          throw new Error("server rejected message size");
        if (offline && sent.length === 1) throw new Error("offline after first chunk");
        sent.push({ text: part, id, channel: thread.channel, root: thread.root });
      },
    );
    routers.push(next);
    return next;
  };
  const failing = restart();
  await failing.drain();
  expect(attempts.map((item) => item.text)).toEqual(chunks.slice(0, 2));
  expect(sent.map((item) => item.text)).toEqual(chunks.slice(0, 1));
  expect(readJson(path, {})).toEqual({ text, chunks, sentChunks: 1 });
  await failing.stop();

  offline = false;
  const next = restart();
  next.enqueueReply(t, "replayed final must not replace the chunk plan", "final-root");
  await next.drain();
  await next.drain();
  expect(sent.map((item) => item.text)).toEqual([...chunks, "later reply"]);
  expect(
    sent
      .slice(0, -1)
      .map((item) => item.text)
      .join(""),
  ).toBe(text);
  expect(sent.every((item) => item.channel === "channel2" && item.root === "root")).toBe(true);
  expect(new Set(sent.map((item) => item.id)).size).toBe(sent.length);
  expect(attempts[1]?.id).toBe(attempts[2]?.id);
  expect(readJson(path, {})).toEqual({ text, chunks, sentChunks: chunks.length, sent: true });
  expect(readJson<string[]>(orderPath, [])).toEqual(order);
});

test("whitespace-only reply chunks do not block later content or subsequent replies", async () => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  await r.drain();
  f.sent.length = 0;
  r.enqueueReply(t, `${"a".repeat(16383)}${" ".repeat(16383)}last chunk`, "long");
  r.enqueueReply(t, "later reply", "later");
  await r.drain();
  await r.drain();
  expect(f.sent.map((item) => item.text)).toEqual(["a".repeat(16383), "last chunk", "later reply"]);
  expect(readOutbox(f.cfg.stateDir, t.key).every(({ item }) => item.sent)).toBe(true);
});

test("failed outbox drains progress and finals in enqueue order across turns and restart", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = new ThreadRouter(
    f.cfg,
    {},
    () => {},
    h.run,
    async () => {
      throw new Error("offline");
    },
  );
  routers.push(r);
  f.bind(r, f.post("z"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  await r.tick();
  r.enqueueReply(t, "first progress", "zzzz");
  const skew = join(f.dir, "skew.ts");
  writeFileSync(
    skew,
    `Object.defineProperty(globalThis, "performance", {
      value: { timeOrigin: ${performance.timeOrigin + performance.now() + 60_000}, now: () => 0 },
    });`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      skew,
      resolve(import.meta.dir, "../src/thread-cli.ts"),
      "outbox",
    ],
    {
      cwd: f.dir,
      env: {
        HOME: f.dir,
        PATH: "/usr/bin:/bin",
        FOREMAN_STATE_DIR: f.cfg.stateDir,
        FOREMAN_THREAD_KEY: t.key,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write("worker progress");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  h.calls[0]?.end({ ok: true, text: "first final" });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  f.post("a", "z");
  await r.tick();
  r.enqueueReply(t, "second progress", "0000");
  h.calls[1]?.end({ ok: true, text: "second final" });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  await r.stop();
  const path = join(f.cfg.stateDir, "thread-outbox", t.key, "final-z.json");
  const orderPath = join(f.cfg.stateDir, "thread-outbox", t.key, ".order");
  const order = readJson<string[]>(orderPath, []);
  const sent: { text: string; id: string }[] = [];
  const next = new ThreadRouter(
    f.cfg,
    {},
    () => {},
    h.run,
    async (_thread, text, id) => {
      sent.push({ text, id });
    },
  );
  routers.push(next);
  // Replaying an enqueue must retain its original place, independent of the final post ID.
  next.enqueueReply(t, "first final", "final-z");
  await next.drain();
  await next.drain();
  expect(sent.map((item) => item.text)).toEqual([
    "Bound to a dedicated agent; queued for the next available slot.",
    "first progress",
    "worker progress",
    "first final",
    "second progress",
    "second final",
  ]);
  expect(sent[3]?.id).toBe("final-z");
  expect(sent[5]?.id).toBe("final-a");
  expect(readJson<string[]>(orderPath, [])).toEqual(order);
  // A replay cannot resurrect an earlier delivery behind replies already sent after it.
  next.enqueueReply(t, "replayed first final", "final-z");
  await next.drain();
  expect(sent).toHaveLength(6);
  expect(readJson(path, {})).toEqual({ text: "first final", sent: true });
});

test("tied enqueue clocks cannot put filename order ahead of publication order", async () => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  await r.drain();
  f.sent.length = 0;
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    r.enqueueReply(t, "first", "zzzz");
    r.enqueueReply(t, "second", "aaaa");
  } finally {
    clock.mockRestore();
  }
  await r.stop();
  await f.router().drain();
  expect(f.sent.map((item) => item.text)).toEqual(["first", "second"]);
});

test("outbox adopts legacy files and recovers publication before order checkpoint without changing IDs", () => {
  const f = fixture();
  const dir = join(f.cfg.stateDir, "thread-outbox", "legacy");
  writeJson(join(dir, "sent.json"), { text: "sent", queuedAt: 1, sent: true });
  writeJson(join(dir, "zz-first.json"), { text: "first", queuedAt: 2 });
  writeJson(join(dir, "aa-second.json"), { text: "second", queuedAt: 3 });
  const legacy = join(dir, "legacy.json");
  writeJson(legacy, { text: "no timestamp" });
  utimesSync(legacy, 0.004, 0.004);
  expect(readOutbox(f.cfg.stateDir, "legacy").map(({ file }) => file)).toEqual([
    "sent.json",
    "zz-first.json",
    "aa-second.json",
    "legacy.json",
  ]);
  expect(readJson(join(dir, "sent.json"), {})).toEqual({ text: "sent", queuedAt: 1, sent: true });
  expect(readJson(legacy, {})).toEqual({ text: "no timestamp" });
  // Simulate death after the atomic payload rename but before the .order rename. Also leave
  // a pre-publication temp file: it must never be delivered or reserve a queue position.
  writeJson(join(dir, "zz-orphan.json"), { text: "published before crash" });
  writeFileSync(join(dir, "unpublished.json.123.tmp"), '{"text":"not published"}');
  enqueueOutbox(f.cfg.stateDir, "legacy", "after recovery", "0000");
  enqueueOutbox(f.cfg.stateDir, "legacy", "retry must retain original payload", "zz-orphan");
  const items = readOutbox(f.cfg.stateDir, "legacy");
  expect(items.map(({ file }) => file)).toEqual([
    "sent.json",
    "zz-first.json",
    "aa-second.json",
    "legacy.json",
    "zz-orphan.json",
    "0000.json",
  ]);
  expect(items.at(-2)?.item.text).toBe("published before crash");
  expect(items[0]?.item.sent).toBe(true);
});

test("concurrent supervisor and worker writers retain every reply in each writer's order", async () => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  await r.drain();
  f.sent.length = 0;
  const writer = join(f.dir, "writer.ts");
  writeFileSync(
    writer,
    `
    import { enqueueOutbox } from ${JSON.stringify(resolve(import.meta.dir, "../src/thread-outbox.ts"))};
    const [state, key, writer] = process.argv.slice(2);
    for (let i = 0; i < 5; i++) enqueueOutbox(state, key, writer + ":" + i, writer + "-" + (5 - i));
  `,
  );
  const children = ["a", "b", "c"].map((name) =>
    Bun.spawn([process.execPath, "--no-env-file", writer, f.cfg.stateDir, t.key, name], {
      cwd: f.dir,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  try {
    for (let i = 0; i < 5; i++) r.enqueueReply(t, `supervisor:${i}`, `supervisor-${5 - i}`);
    await r.drain(); // snapshot may race publication; later replies must follow the snapshot
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0]);
    await r.stop();
    await f.router().drain();
    expect(f.sent).toHaveLength(20);
    expect(new Set(f.sent.map(({ text }) => text)).size).toBe(20);
    for (const writer of ["a", "b", "c", "supervisor"]) {
      expect(
        f.sent.filter(({ text }) => text.startsWith(`${writer}:`)).map(({ text }) => text),
      ).toEqual(Array.from({ length: 5 }, (_, i) => `${writer}:${i}`));
    }
    expect(f.sent.map(({ text }) => text)).toEqual(
      readOutbox(f.cfg.stateDir, t.key)
        .slice(1)
        .map(({ item }) => item.text),
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
});

test("resident-owned policy persists source/old/new, unverified worker grants cannot widen defaults", () => {
  const f = fixture();
  const r = f.router();
  const ref = f.post("grant", "grant", "channel1", "allow merge for owner/repo");
  const args = ["policy-set", ref, "owner/repo", '{"merge":true}', "--repo-wide"];
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  expect(() => r.command("worker-token", args)).toThrow("resident authorization");
  expect(() =>
    r.command(r.token, ["policy-set", "mm:channel1:invented", "owner/repo", '{"merge":true}']),
  ).toThrow("not received");
  expect(() => r.command(r.token, args.slice(0, 4))).toThrow("requires --repo-wide");
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  r.command(r.token, args);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(true);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").push_main).toBe(false);
  expect(repoPolicy(f.cfg.notesDir, "other").merge).toBe(false);
  const audit = JSON.parse(readFileSync(join(f.cfg.notesDir, "policy/autonomy.json"), "utf8"))
    .audit[0];
  expect(audit.source.text).toBe("allow merge for owner/repo");
  expect(audit.before.merge).toBe(false);
  expect(audit.after.merge).toBe(true);
  expect(() =>
    r.command(r.token, ["policy-set", ref, "owner/repo", '{"everything":true}']),
  ).toThrow("unknown policy");
  r.command(r.token, ["policy-set", ref, "owner/repo", '{"merge":false}']);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
});

const approvalScope = {
  target: "https://github.com/owner/repo/pull/123",
  head: "a".repeat(40),
  actions: ["merge", "undraft"],
};

test("one human approval hands off to resident and resumes an idle session with a result, never repo authority", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root", "root", "channel1", "merge it");
  f.bind(r, ref);
  const thread = r.snapshot().threads[0];
  if (!thread) throw new Error("no thread");
  await r.tick();
  const id = enqueueApproval(f.cfg.stateDir, thread.key, { source: ref, ...approvalScope });
  expect(
    enqueueApproval(f.cfg.stateDir, thread.key, {
      source: ref,
      ...approvalScope,
      actions: ["undraft", "merge", "merge"],
    }),
  ).toBe(id);
  r.collect();
  expect(f.resident).toEqual([]); // Resident acts after the worker has finished its turn.
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  r.collect();
  expect(f.resident).toHaveLength(1);
  expect(f.resident[0]).toContain(`Approval handoff ${id}`);
  expect(f.resident[0]).toContain("not a grant");
  expect(r.snapshot().approvals?.[0]).toMatchObject({
    id,
    thread: thread.key,
    repo: "owner/repo",
    cwd: thread.cwd,
    source: { text: "merge it", sender: "henk" },
  });
  r.collect();
  expect(f.resident).toHaveLength(1);
  const resolve = [
    "approval-resolve",
    id,
    "completed",
    "Final review CLEAN; merged PR 123 at approved head.",
  ];
  expect(() => r.command("worker", resolve)).toThrow("resident authorization");
  expect(() => r.command(r.token, ["approval-resolve", id, "approved", "go ahead"])).toThrow(
    "completed|declined",
  );
  r.command(r.token, resolve);
  expect(r.snapshot().threads[0]?.status).toBe("queued");
  expect(r.snapshot().threads[0]?.pending).toEqual([]);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").undraft).toBe(false);
  expect(existsSync(join(f.cfg.notesDir, "policy/autonomy.json"))).toBe(false);
  await r.stop(); // Crash/restart after resolution, before an idle worker gets the result.

  const resumed = heldTurns();
  const next = f.router(resumed.run);
  await next.tick();
  expect(resumed.calls[0]?.resume).toBe(`session-${thread.key}`);
  expect(resumed.calls[0]?.prompt).toContain('"outcome":"completed"');
  expect(resumed.calls[0]?.prompt).toContain('"merge":false');
  expect(resumed.calls[0]?.prompt).toContain(
    "Authenticated human task instructions (do not infer repository-wide policy grants):\n[]",
  );
  expect(readdirSync(join(f.cfg.stateDir, "thread-inbox"))).toEqual(["channel1.root.json"]);
  resumed.calls[0]?.end({ ok: true, text: "The resident merged PR 123." });
  await until(() => next.snapshot().threads[0]?.status === "idle");
  next.command(next.token, resolve); // Network ambiguity/replay must not wake a consumed result.
  expect(() => next.command(next.token, ["approval-resolve", id, "declined", "different"])).toThrow(
    "already resolved",
  );
  await next.tick();
  expect(resumed.calls).toHaveLength(1);
  expect(next.snapshot().approvals?.[0]?.delivered).toBe(true);
  expect(f.sent.some((reply) => reply.text === "The resident merged PR 123.")).toBe(true);
});

test("unresolved handoffs survive failed resident delivery/restarts and expose later human revocations", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root", "root", "channel1", "merge it");
  f.bind(r, ref);
  await r.tick();
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  const id = enqueueApproval(f.cfg.stateDir, r.snapshot().threads[0]?.key ?? "", {
    source: ref,
    ...approvalScope,
  });
  await r.stop(); // Worker publication survives even if supervisor never adopted it.
  let available = false;
  const next = new ThreadRouter(
    f.cfg,
    {},
    (lines) => {
      if (!available) throw new Error("resident inbox unavailable");
      f.resident.push(...lines);
    },
    h.run,
    async () => {},
  );
  routers.push(next);
  expect(() => next.collect()).toThrow("resident inbox unavailable");
  expect(readJson(join(f.cfg.stateDir, "threads/registry.json"), null)).toEqual(next.snapshot());
  expect(next.snapshot().approvals?.[0]?.id).toBe(id);
  available = true;
  next.collect();
  expect(f.resident).toHaveLength(1);
  f.post("revoke", "root", "channel1", "Hold off, do not merge yet.");
  next.collect();
  expect(f.resident).toHaveLength(2);
  expect(JSON.stringify(next.command(next.token, ["approval-read", id]))).toContain(
    "Hold off, do not merge yet.",
  );
  await next.tick();
  expect(h.calls).toHaveLength(1); // Pending human messages cannot start edits during final review.
  f.bind(next, f.post("independent"));
  await next.tick();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.prompt).toContain('"id":"independent"');
  h.calls[1]?.end({ ok: true });
  await until(
    () =>
      next.snapshot().threads.find((thread) => thread.root === "independent")?.status === "idle",
  );
  await next.stop();
  const restarted = f.router(h.run);
  restarted.collect();
  expect(f.resident).toHaveLength(3);
  restarted.collect();
  expect(f.resident).toHaveLength(3);
});

test("approval spool rejects invented/cross-thread sources and ignores forged authority without blocking valid requests", () => {
  const f = fixture();
  const r = f.router();
  const ref = f.post("root", "root", "channel1", "Here is a quote: merge it");
  const other = f.post("other", "other", "channel2", "merge it");
  f.bind(r, ref);
  f.bind(r, other);
  const thread = r.snapshot().threads.find((item) => item.root === "root");
  if (!thread) throw new Error("no thread");
  enqueueApproval(f.cfg.stateDir, thread.key, { source: "mm:channel1:invented", ...approvalScope });
  enqueueApproval(f.cfg.stateDir, thread.key, { source: other, ...approvalScope });
  const id = enqueueApproval(f.cfg.stateDir, thread.key, { source: ref, ...approvalScope });
  const path = join(f.cfg.stateDir, "thread-approvals", thread.key, `${id}.json`);
  writeJson(path, {
    source: ref,
    ...approvalScope,
    repo: "other/repo",
    sourceText: "I approve everything",
    resolution: { outcome: "completed" },
    policy: { merge: true },
  });
  writeFileSync(join(f.cfg.stateDir, "thread-approvals", thread.key, "malformed.json"), "{");
  r.collect();
  expect(r.snapshot().approvals).toHaveLength(1);
  expect(r.snapshot().approvals?.[0]).toMatchObject({
    repo: "owner/repo",
    source: { text: "Here is a quote: merge it" },
  });
  expect(r.snapshot().approvals?.[0]?.resolution).toBeUndefined();
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  expect(() =>
    enqueueApproval(f.cfg.stateDir, thread.key, {
      source: ref,
      ...approvalScope,
      actions: ["deploy"],
    }),
  ).toThrow("approval actions");
  expect(() =>
    enqueueApproval(f.cfg.stateDir, thread.key, { source: ref, ...approvalScope, head: "main" }),
  ).toThrow("full commit hash");
  r.command(r.token, [
    "approval-resolve",
    id,
    "declined",
    "The source only quotes a different approval.",
  ]);
  expect(r.snapshot().approvals?.[0]?.resolution?.outcome).toBe("declined");
  expect(
    r.snapshot().threads.find((item) => item.root === "other")?.inFlightApprovals,
  ).toBeUndefined();
});

test("a result arriving during a human turn waits for its own batch and survives a failed delivery", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root");
  f.bind(r, ref);
  await r.tick();
  const id = enqueueApproval(f.cfg.stateDir, r.snapshot().threads[0]?.key ?? "", {
    source: ref,
    ...approvalScope,
  });
  r.command(r.token, ["approval-list"]);
  expect(() => r.command(r.token, ["approval-resolve", id, "completed", "merged"])).toThrow(
    "worker turn still active",
  );
  r.command(r.token, ["approval-resolve", id, "declined", "No actual content approval."]);
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "queued");
  expect(r.snapshot().approvals?.[0]?.delivered).toBeUndefined();
  await r.tick();
  expect(h.calls[1]?.prompt).toContain('"outcome":"declined"');
  h.calls[1]?.end({ ok: false });
  await until(() => r.snapshot().threads[0]?.status === "failed");
  expect(r.snapshot().approvals?.[0]?.delivered).toBeUndefined();
  expect(f.resident.at(-1)).toContain("MSG mm:channel1:root root [harness]");
  await r.stop();
  const next = f.router(h.run);
  f.post("followup", "root");
  next.collect();
  next.command(next.token, ["retry", ref]);
  await next.tick();
  expect(h.calls[2]?.prompt).toContain('"outcome":"declined"');
  expect(h.calls[2]?.prompt).not.toContain('"id":"followup"');
  h.calls[2]?.end({ ok: true });
  await until(() => next.snapshot().threads[0]?.status === "queued");
  await next.tick();
  expect(h.calls[3]?.prompt).not.toContain('"outcome":"declined"');
  expect(h.calls[3]?.prompt).toContain('"id":"followup"');
  h.calls[3]?.end({ ok: true });
  await until(() => next.snapshot().threads[0]?.status === "idle");
});

test("credential-free approval-request CLI publishes an idempotent request but cannot resolve it", async () => {
  const f = fixture();
  const r = f.router();
  const ref = f.post("root");
  f.bind(r, ref);
  const env = {
    HOME: f.dir,
    PATH: "/usr/bin:/bin",
    FOREMAN_STATE_DIR: f.cfg.stateDir,
    FOREMAN_THREAD_KEY: r.snapshot().threads[0]?.key ?? "",
  };
  const cli = resolve(import.meta.dir, "../src/thread-cli.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: f.dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  };
  const args = [
    "approval-request",
    ref,
    approvalScope.target,
    approvalScope.head,
    JSON.stringify(approvalScope.actions),
  ];
  const a = await run(args);
  const b = await run(args);
  expect(a.code).toBe(0);
  expect(b.output).toBe(a.output);
  r.collect();
  expect(r.snapshot().approvals).toHaveLength(1);
  expect(
    (await run(["approval-resolve", a.output.trim(), "completed", "merge now"])).error,
  ).toContain("resident control capability required");
  expect(r.snapshot().approvals?.[0]?.resolution).toBeUndefined();
});

test("resolution checkpoint failure retains both result and wakeup for retry without another human post", async () => {
  const f = fixture();
  const h = heldTurns();
  const r = f.router(h.run);
  const ref = f.post("root");
  f.bind(r, ref);
  await r.tick();
  h.calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  const id = enqueueApproval(f.cfg.stateDir, r.snapshot().threads[0]?.key ?? "", {
    source: ref,
    ...approvalScope,
  });
  r.collect();
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const obstruction = `${path}.${process.pid}.tmp`;
  mkdirSync(obstruction);
  try {
    expect(() =>
      r.command(r.token, ["approval-resolve", id, "declined", "Not an approval."]),
    ).toThrow();
    expect(readJson(path, null)).toEqual(persisted);
    await expect(r.tick()).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  } finally {
    rmSync(obstruction, { recursive: true });
  }
  await r.tick();
  expect(h.calls).toHaveLength(2);
  expect(readJson(path, null)).toEqual(r.snapshot());
  expect(h.calls[1]?.prompt).toContain('"outcome":"declined"');
  h.calls[1]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
});

test("a surviving CLI keeps approval handoff busy after supervisor restart until its lock is released", async () => {
  const f = fixture();
  const r = f.router();
  const ref = f.post("root");
  f.bind(r, ref);
  const key = r.snapshot().threads[0]?.key ?? "";
  const id = enqueueApproval(f.cfg.stateDir, key, { source: ref, ...approvalScope });
  const ready = join(f.dir, "approval-lock-ready");
  const holder = Bun.spawn(
    [
      "flock",
      "-F",
      join(f.cfg.stateDir, "threads", `${key}.lock`),
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(ready)}, 'ready'); await Bun.stdin.text();`,
    ],
    {
      cwd: f.dir,
      env: { HOME: f.dir, PATH: "/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    await until(() => existsSync(ready));
    await r.stop();
    const next = f.router();
    next.collect();
    expect(f.resident).toEqual([]);
    expect(next.command(next.token, ["approval-list"])).toMatchObject([{ workerBusy: true }]);
    expect(() => next.command(next.token, ["approval-resolve", id, "completed", "merged"])).toThrow(
      "worker turn still active",
    );
    holder.stdin.end();
    await holder.exited;
    next.collect();
    expect(f.resident).toHaveLength(1);
    expect(next.command(next.token, ["approval-list"])).toMatchObject([{ workerBusy: false }]);
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
});

test("authorization filters sender/channel, fails closed without humans, deduplicates timestamp boundary after durable poll", async () => {
  const f = fixture();
  const post = {
    id: "p1",
    channel_id: "c1",
    root_id: "",
    user_id: "henk",
    message: "work",
    create_at: 101,
  };
  const posts = [
    post,
    { ...post, id: "stranger", user_id: "stranger" },
    { ...post, id: "wrong", channel_id: "c2" },
    { ...post, id: "webhook", type: "", props: { from_webhook: "true" } },
    { ...post, id: "webhookBoolean", type: "", props: { from_webhook: true } },
  ];
  expect(authorizedPosts(posts, "c1", ["henk"])).toHaveLength(1);
  expect(authorizedPosts(posts, "c1", [])).toHaveLength(0);
  let expected = posts;
  const request = (async () =>
    Response.json({ posts: Object.fromEntries(expected.map((p) => [p.id, p])) })) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  writeJson(join(f.cfg.stateDir, "wait-reply/mm-c1.json"), 100);
  const dest = { channels: ["c1"], humans: ["henk"] };
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual(["MSG mm:c1:p1 p1 work"]);
  expect(existsSync(receiptPath(f.cfg.stateDir, "c1", "p1"))).toBe(true);
  expect(existsSync(receiptPath(f.cfg.stateDir, "c1", "webhook"))).toBe(false);
  expect(existsSync(receiptPath(f.cfg.stateDir, "c1", "webhookBoolean"))).toBe(false);
  expected = [...posts, { ...post, id: "sameTime" }];
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual(["MSG mm:c1:sameTime sameTime work"]);
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual([]);
  expect(await new Mattermost({}, request).destinations().catch(() => "closed")).toBe("closed");
});

test("first activation preserves later channels' messages when an earlier channel fails", async () => {
  const f = fixture();
  const post = {
    id: "duringFailure",
    channel_id: "c2",
    root_id: "",
    user_id: "henk",
    message: "work",
    create_at: 200,
  };
  const oldPost = { ...post, id: "beforeActivation", create_at: 99 };
  let fail = true;
  const requested: string[] = [];
  const request = (async (input) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path === "/api/v4/channels/c1/posts") {
      if (fail) return new Response("offline", { status: 503 });
      return Response.json({ posts: {} });
    }
    return Response.json({ posts: { [post.id]: post, [oldPost.id]: oldPost } });
  }) as typeof fetch;
  const env = { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" };
  const dest = { channels: ["c1", "c2"], humans: ["henk"] };
  const clock = spyOn(Date, "now").mockReturnValue(100);
  try {
    await expect(new Mattermost(env, request).poll(f.cfg.stateDir, dest)).rejects.toThrow("503");
    expect(requested).toEqual(["/api/v4/channels/c1/posts"]);
    for (const channel of dest.channels) {
      expect(readJson(join(f.cfg.stateDir, "wait-reply", `mm-${channel}.json`), 0)).toBe(100);
    }
    fail = false;
    clock.mockReturnValue(300);
    const recovered = new Mattermost(env, request);
    expect(await recovered.poll(f.cfg.stateDir, dest)).toEqual([
      "MSG mm:c2:duringFailure duringFailure work",
    ]);
    expect(existsSync(receiptPath(f.cfg.stateDir, "c2", post.id))).toBe(true);
    expect(existsSync(receiptPath(f.cfg.stateDir, "c2", oldPost.id))).toBe(false);
    expect(readJson(join(f.cfg.stateDir, "wait-reply/mm-c2.json"), 0)).toBe(200);
    expect(await recovered.poll(f.cfg.stateDir, dest)).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("poll backfills over 1,000 mixed-author posts, retrying failed pages and ID verification", async () => {
  const f = fixture();
  const posts = Array.from({ length: 2607 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: i % 7 === 0 && (i < 1400 || i >= 2000) ? "henk" : i % 2 ? "bot" : "stranger",
    props: { from_webhook: i % 11 === 0 },
    create_at: 90 + Math.floor(i / 3),
    message: `work ${i}`,
  }));
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let fail = true;
  let failVerification = true;
  let verifications = 0;
  const pages: number[] = [];
  const request = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/posts/ids") {
      const ids = JSON.parse(String(init?.body)) as string[];
      expect(ids.length).toBeLessThanOrEqual(1000);
      if (++verifications === 2 && failVerification)
        return new Response("offline", { status: 503 });
      return Response.json(posts.filter((p) => ids.includes(p.id)));
    }
    const query = url.searchParams;
    const sorted = [...posts].sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id));
    const page = Number(query.get("page") ?? 0);
    const size = Number(query.get("per_page") ?? 60);
    pages.push(page);
    if (fail && page === 2) return new Response("offline", { status: 503 });
    // Model the old since endpoint's cap as well as ordinary channel pagination.
    const batch = query.has("since")
      ? sorted.filter((p) => p.create_at > Number(query.get("since"))).slice(0, 1000)
      : sorted.slice(page * size, (page + 1) * size);
    const oldRoot = { ...posts[0], id: "oldroot", create_at: 1 };
    return Response.json({
      order: batch.map((p) => p.id),
      posts: Object.fromEntries([...batch, oldRoot].map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  const dest = { channels: ["c1"], humans: ["henk"] };
  await expect(mm.poll(f.cfg.stateDir, dest)).rejects.toThrow("503");
  expect(readJson(cursor, 0)).toBe(100);
  fail = false;
  await expect(mm.poll(f.cfg.stateDir, dest)).rejects.toThrow("503");
  expect(verifications).toBe(2);
  expect(readJson(cursor, 0)).toBe(100);
  expect(existsSync(join(f.cfg.stateDir, "thread-inbox"))).toBe(false);
  failVerification = false;
  pages.length = 0;
  const expected = authorizedPosts(posts, "c1", ["henk"]).filter((p) => p.at >= 100);
  const lines = await mm.poll(f.cfg.stateDir, dest);
  expect(lines).toEqual(expected.map((p) => `MSG mm:c1:${p.id} ${p.root} ${p.text}`));
  expect(pages.length).toBeGreaterThan(5);
  expect(readdirSync(join(f.cfg.stateDir, "thread-inbox"))).toHaveLength(expected.length);
  const newest = expected.at(-1);
  if (!newest) throw new Error("no expected posts");
  expect(readJson(cursor, 0)).toBe(newest.at);
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual([]);
  posts.push({
    id: "late",
    root_id: "",
    channel_id: "c1",
    user_id: "henk",
    props: { from_webhook: false },
    create_at: newest.at,
    message: "same timestamp",
  });
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual(["MSG mm:c1:late late same timestamp"]);
});

test.each([
  1, 75, 200,
])("poll retains unread posts when %i already-read posts are deleted between pages", async (deletions) => {
  const f = fixture();
  const posts = Array.from({ length: 1250 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: i % 3 ? "henk" : "bot",
    // More than a page shares a timestamp, including the durable cursor boundary.
    create_at: i < 1050 ? 100 : 101,
    delete_at: 0,
    message: `work ${i}`,
  }));
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let calls = 0;
  const request = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/posts/ids") {
      const ids = JSON.parse(String(init?.body)) as string[];
      return Response.json(posts.filter((p) => ids.includes(p.id)));
    }
    // No partial scan may acknowledge posts, even when it has to restart.
    expect(readJson(cursor, 0)).toBe(100);
    if (++calls === 2) {
      for (const post of posts.slice(-deletions)) post.delete_at = 200;
    }
    const query = url.searchParams;
    const page = Number(query.get("page") ?? 0);
    const size = Number(query.get("per_page") ?? 60);
    const before = posts.find((p) => p.id === query.get("before"));
    const sorted = posts
      .filter((p) => !p.delete_at && (!before || p.create_at < before.create_at))
      .sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id));
    const batch = query.has("since")
      ? sorted.filter((p) => p.create_at > Number(query.get("since"))).slice(0, 1000)
      : sorted.slice(page * size, (page + 1) * size);
    // Thread roots in the map are outside the actual page and must not end the scan.
    const oldRoot = { ...posts[0], id: "oldroot", create_at: 1 };
    return Response.json({
      order: batch.map((p) => p.id),
      posts: Object.fromEntries([...batch, oldRoot].map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  const lines = await mm.poll(f.cfg.stateDir, { channels: ["c1"], humans: ["henk"] });
  const expected = authorizedPosts(posts, "c1", ["henk"]);
  for (const post of expected) {
    expect(lines).toContain(`MSG mm:c1:${post.id} ${post.root} ${post.text}`);
    expect(readJson(receiptPath(f.cfg.stateDir, "c1", post.id), null)).toEqual(post);
  }
  expect(new Set(lines).size).toBe(lines.length);
  expect(readJson(cursor, 0)).toBe(expected.at(-1)?.at);
  expect(calls).toBeLessThan(30);
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("poll recovers reordered ties despite a surviving boundary (delete=%s, old rows=%s)", async (deletion, oldRows) => {
  const f = fixture();
  const tied = Array.from({ length: 250 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: i % 3 ? "henk" : "bot",
    create_at: 101,
    delete_at: 0,
    message: `work ${i}`,
  }));
  const first = tied[0];
  if (!first) throw new Error("missing fixture post");
  const newest = { ...first, id: "newest", user_id: "henk", create_at: 102 };
  const older = Array.from({ length: oldRows ? 400 : 0 }, (_, i) => ({
    ...newest,
    id: `old${i}`,
    create_at: 99,
  }));
  const posts = [newest, ...tied, ...older];
  let sorted = [...posts];
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let calls = 0;
  const request = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/posts/ids") {
      const ids = JSON.parse(String(init?.body)) as string[];
      return Response.json(posts.filter((p) => ids.includes(p.id)));
    }
    if (++calls === 2) {
      const read = tied[0];
      const boundary = tied[198];
      const unread = tied[199];
      if (!read || !boundary || !unread) throw new Error("missing fixture post");
      if (deletion) {
        read.delete_at = 200;
        sorted = sorted.filter((p) => p !== read);
        // The deleted, already-read ID can mask the missing ID in a naive count.
        [sorted[198], sorted[199]] = [unread, boundary];
      } else {
        [sorted[1], sorted[200]] = [unread, read];
      }
      // Keep the overlap witness while moving an unread tie behind the offset.
      expect(sorted[199]?.id).toBe(boundary.id);
    }
    if (calls > 30) throw new Error("poll did not finish");
    const page = Number(url.searchParams.get("page") ?? 0);
    const size = Number(url.searchParams.get("per_page") ?? 60);
    const batch = sorted.slice(page * size, (page + 1) * size);
    const oldRoot = { ...newest, id: "oldroot", create_at: 1 };
    return Response.json({
      order: batch.map((p) => p.id),
      posts: Object.fromEntries([...batch, oldRoot].map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  const dest = { channels: ["c1"], humans: ["henk"] };
  const expected = authorizedPosts(posts, "c1", dest.humans).filter((p) => p.at >= 100);
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual(
    expected.map((p) => `MSG mm:c1:${p.id} ${p.root} ${p.text}`),
  );
  expect(existsSync(receiptPath(f.cfg.stateDir, "c1", "p0199"))).toBe(true);
  expect(readJson(cursor, 0)).toBe(102);
  // The skipped tie is older than the new cursor and cannot be rescued by the next poll.
  expect(
    await new Mattermost(
      { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
      request,
    ).poll(f.cfg.stateDir, dest),
  ).toEqual([]);
});

test("poll leaves the durable cursor untouched when deletions repeatedly break page continuity", async () => {
  const f = fixture();
  const posts = Array.from({ length: 1200 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: "henk",
    create_at: 101 + i,
    message: `work ${i}`,
  }));
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let mutate = true;
  let calls = 0;
  const request = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/posts/ids") {
      const ids = JSON.parse(String(init?.body)) as string[];
      return Response.json(posts.filter((p) => ids.includes(p.id)));
    }
    if (++calls > 30) throw new Error("poll did not finish");
    const query = url.searchParams;
    const page = Number(query.get("page") ?? 0);
    const size = Number(query.get("per_page") ?? 60);
    if (mutate && page > 0) posts.splice(-200);
    const batch = [...posts].reverse().slice(page * size, (page + 1) * size);
    return Response.json({
      order: batch.map((p) => p.id),
      posts: Object.fromEntries(batch.map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  const dest = { channels: ["c1"], humans: ["henk"] };
  await expect(mm.poll(f.cfg.stateDir, dest)).rejects.toThrow("changed during pagination");
  expect(readJson(cursor, 0)).toBe(100);
  expect(existsSync(join(f.cfg.stateDir, "thread-inbox"))).toBe(false);
  mutate = false;
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual(
    posts.map((p) => `MSG mm:c1:${p.id} ${p.id} ${p.message}`),
  );
  expect(readJson(cursor, 0)).toBe(posts.at(-1)?.create_at);
  expect(await mm.poll(f.cfg.stateDir, dest)).toEqual([]);
});

test.each([
  "reordered ties",
  "missing ID",
  "duplicate ID",
  "wrong channel",
  "changed timestamp",
  "malformed verification",
])("poll retains its cursor and retries after unverifiable coverage (%s)", async (fault) => {
  const f = fixture();
  const posts = Array.from({ length: 251 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: "henk",
    create_at: i === 0 ? 102 : 101,
    message: `work ${i}`,
  }));
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let unstable = true;
  let calls = 0;
  const request = (async (input, init) => {
    if (++calls > 30) throw new Error("poll did not finish");
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/posts/ids") {
      const ids = JSON.parse(String(init?.body)) as string[];
      const current = posts.filter((p) => ids.includes(p.id));
      if (unstable) {
        const first = current[0];
        const second = current[1];
        if (!first || !second) throw new Error("missing fixture post");
        if (fault === "missing ID") current.shift();
        if (fault === "duplicate ID") current[0] = second;
        if (fault === "wrong channel") current[0] = { ...first, channel_id: "c2" };
        if (fault === "changed timestamp") current[0] = { ...first, create_at: 103 };
        if (fault === "malformed verification") return Response.json({ posts: current });
      }
      return Response.json(current);
    }
    const page = Number(url.searchParams.get("page") ?? 0);
    const size = Number(url.searchParams.get("per_page") ?? 60);
    const sorted = [...posts];
    if (unstable && fault === "reordered ties" && page > 0) {
      const read = posts[1];
      const unread = posts[200];
      if (!read || !unread) throw new Error("missing fixture post");
      [sorted[1], sorted[200]] = [unread, read];
    }
    const batch = sorted.slice(page * size, (page + 1) * size);
    return Response.json({
      order: batch.map((p) => p.id),
      posts: Object.fromEntries(batch.map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const env = { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" };
  const dest = { channels: ["c1"], humans: ["henk"] };
  await expect(new Mattermost(env, request).poll(f.cfg.stateDir, dest)).rejects.toThrow(
    fault === "malformed verification" ? "verification response" : "changed during pagination",
  );
  expect(readJson(cursor, 0)).toBe(100);
  expect(existsSync(join(f.cfg.stateDir, "thread-inbox"))).toBe(false);
  unstable = false;
  const expected = authorizedPosts(posts, "c1", dest.humans);
  const recovered = new Mattermost(env, request);
  expect(await recovered.poll(f.cfg.stateDir, dest)).toEqual(
    expected.map((p) => `MSG mm:c1:${p.id} ${p.root} ${p.text}`),
  );
  expect(readJson(cursor, 0)).toBe(102);
  expect(await recovered.poll(f.cfg.stateDir, dest)).toEqual([]);
});

test.each([
  "empty",
  "root",
  "unordered",
])("poll verifies the boundary before accepting a short page (%s)", async (response) => {
  const f = fixture();
  const posts = Array.from({ length: 250 }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    root_id: "",
    channel_id: "c1",
    user_id: "henk",
    create_at: 101 + i,
    message: `work ${i}`,
  }));
  const cursor = join(f.cfg.stateDir, "wait-reply/mm-c1.json");
  writeJson(cursor, 100);
  let calls = 0;
  const request = (async (input) => {
    const removed = ++calls === 2 ? posts.splice(-200) : [];
    const query = new URL(String(input)).searchParams;
    const page = Number(query.get("page") ?? 0);
    const size = Number(query.get("per_page") ?? 60);
    const batch = [...posts].reverse().slice(page * size, (page + 1) * size);
    // A thread root outside `order` must not stand in for the missing page boundary.
    const extra = response !== "empty" ? removed.slice(0, 1) : [];
    return Response.json({
      ...(calls === 2 && response === "unordered" ? {} : { order: batch.map((p) => p.id) }),
      posts: Object.fromEntries([...batch, ...extra].map((p) => [p.id, p])),
    });
  }) as typeof fetch;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid", MATTERMOST_BOT_TOKEN: "fake" },
    request,
  );
  const poll = mm.poll(f.cfg.stateDir, { channels: ["c1"], humans: ["henk"] });
  if (response === "unordered") {
    await expect(poll).rejects.toThrow("requires ordered posts");
    expect(readJson(cursor, 0)).toBe(100);
    expect(existsSync(join(f.cfg.stateDir, "thread-inbox"))).toBe(false);
    return;
  }
  expect(await poll).toEqual(posts.map((p) => `MSG mm:c1:${p.id} ${p.id} ${p.message}`));
  expect(readJson(cursor, 0)).toBe(posts.at(-1)?.create_at);
});

test("explicit channel modes, cap validation and flag-off environment compatibility", async () => {
  expect(parseChannelMode("auto")).toBe("auto");
  expect(parseChannelMode("telegram")).toBe("telegram");
  expect(() => parseChannelMode("typo")).toThrow();
  for (const cap of [1, 2, 8, 9, 50, 51, Number.MAX_SAFE_INTEGER]) {
    expect(parseThreadCap(String(cap))).toBe(cap);
  }
  for (const value of [
    "",
    " ",
    "typo",
    "50agents",
    "unlimited",
    "0",
    "-0",
    "-1",
    "2.5",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e309",
    "9007199254740992",
    "9007199254740993",
  ]) {
    expect(() => parseThreadCap(value)).toThrow(
      "FOREMAN_MAX_THREAD_AGENTS must be a positive safe integer",
    );
  }
  const env = {
    MATTERMOST_BOT_TOKEN: "fake",
    TELEGRAM_BOT_TOKEN: "fake",
    FOREMAN_ROUTER_TOKEN: "resident",
    FOREMAN_THREAD_AGENTS: "0",
  };
  expect(agentEnv(env)).toEqual(env);
  const clean = agentEnv({ ...env, FOREMAN_THREAD_AGENTS: "1", FOREMAN_THREAD_KEY: "thread" });
  expect(clean["MATTERMOST_BOT_TOKEN"]).toBeUndefined();
  expect(clean["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
  expect(clean["FOREMAN_ROUTER_TOKEN"]).toBeUndefined();
  const f = fixture();
  f.cfg.channelMode = "telegram";
  const held = heldTurns();
  const r = f.router(held.run);
  f.bind(r, f.post("old"));
  await r.tick();
  expect(held.calls).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  expect(f.resident).toHaveLength(0);
  expect(formatInboxPrompt(["MSG 123 - legacy"])).toContain("MSG 123 - legacy");
});

test("real CodexSession adapter with mock CLI emits stable independent IDs, resumes explicit ID and scrubs inherited credentials", async () => {
  const f = fixture();
  const cli = join(f.dir, "mock-codex");
  writeFileSync(
    cli,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args = process.argv.slice(2);\nconst id = args[1] === 'resume' ? args.at(-2) : 'session-' + process.env.FOREMAN_THREAD_KEY;\nappendFileSync(${JSON.stringify(join(f.dir, "calls"))}, JSON.stringify({args, id, cwd:process.cwd(), secret:!!process.env.MATTERMOST_BOT_TOKEN, control:!!process.env.FOREMAN_ROUTER_TOKEN, prompt:await Bun.stdin.text()})+'\\n');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:id}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'mock result'}}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`,
  );
  chmodSync(cli, 0o700);
  f.cfg.codexBin = cli;
  const r = f.router();
  f.bind(r, f.post("one"));
  f.bind(r, f.post("two"));
  await r.tick();
  await until(() => r.snapshot().threads.every((t) => t.status === "idle"));
  await r.stop();
  f.post("again", "one");
  const next = f.router();
  await next.tick();
  await until(() => next.snapshot().threads.every((t) => t.status === "idle"));
  const calls = readFileSync(join(f.dir, "calls"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  expect(calls[2].args[1]).toBe("resume");
  expect(calls[2].args).not.toContain("--last");
  expect(calls[2].args).toContain("gpt-6-astra");
  expect(calls[2].args).toContain("model_reasoning_effort=xhigh");
  expect(calls.every((c) => !c.secret && !c.control)).toBe(true);
  expect(calls[2].args.at(-2)).toBe(
    next.snapshot().threads.find((t) => t.root === "one")?.sessionId,
  );
});

test.each([
  "answer",
  "repeated answer",
  "empty answer",
  "failed turn",
])("Codex thread replies publish progress once and only the final assistant message (%s)", async (scenario) => {
  const f = fixture();
  const cli = join(f.dir, "mock-codex");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const resumed = args[1] === "resume";
const id = resumed ? args.at(-2) : "session-" + process.env.FOREMAN_THREAD_KEY;
const progress = resumed ? "Checking the follow-up." : "Investigating the duplicate replies.";
const final = ${JSON.stringify(scenario)} === "empty answer" ? "" : resumed ? "Follow-up fixed." : "Duplicate replies fixed.";
appendFileSync(${JSON.stringify(join(f.dir, "calls"))}, id + "\\n");
await Bun.stdin.text();
const emit = (event) => console.log(JSON.stringify(event));
const message = (text) => emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "thread.started", thread_id: id });
emit({ type: "turn.started" });
message(progress);
const reply = Bun.spawnSync([process.execPath, "--no-env-file", ${JSON.stringify(resolve(import.meta.dir, "../src/thread-cli.ts"))}, "outbox"], {
  stdin: Buffer.from(progress), stdout: "pipe", stderr: "pipe",
});
if (reply.exitCode !== 0) throw new Error("mock progress reply failed");
emit({ type: "item.completed", item: { type: "command_execution", aggregated_output: "tool output must not become a reply" } });
message("Verification is complete.");
message(final);
if (${JSON.stringify(scenario)} === "repeated answer") message(final);
emit({ type: "item.updated", item: { type: "agent_message", text: "unfinished update must not become a reply" } });
emit({ type: ${JSON.stringify(scenario === "failed turn" ? "turn.failed" : "turn.completed")} });
`,
  );
  chmodSync(cli, 0o700);
  f.cfg.codexBin = cli;
  const r = f.router();
  f.bind(r, f.post("root"));
  await r.tick();
  await until(() => r.snapshot().threads[0]?.status !== "running");
  await r.drain();
  const expected = [
    "Bound to a dedicated agent; queued for the next available slot.",
    "Investigating the duplicate replies.",
  ];
  if (scenario !== "empty answer") {
    expected.push(
      scenario === "failed turn"
        ? "Turn failed; messages retained. Resident must inspect and use thread-control retry."
        : "Duplicate replies fixed.",
    );
  }
  expect(f.sent.map(({ text }) => text)).toEqual(expected);
  await r.stop();
  if (scenario !== "failed turn") {
    f.post("followup", "root");
    const next = f.router();
    await next.tick();
    await until(() => next.snapshot().threads[0]?.status !== "running");
    await next.drain();
    expected.push("Checking the follow-up.");
    if (scenario !== "empty answer") expected.push("Follow-up fixed.");
    expect(f.sent.map(({ text }) => text)).toEqual(expected);
    // Duplicate ingress after restart must not create another turn or final reply.
    next.collect();
    await next.tick();
    const calls = readFileSync(join(f.dir, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(f.sent.map(({ text }) => text)).toEqual(expected);
  }
  expect(f.sent.every(({ channel, root }) => channel === "channel1" && root === "root")).toBe(true);
});

test("credential-free thread-reply CLI spools only text and control endpoint rejects absent capability", async () => {
  const f = fixture();
  const r = f.router();
  f.bind(r, f.post("root"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  const cli = resolve(import.meta.dir, "../src/thread-cli.ts");
  const child = Bun.spawn([process.execPath, cli, "outbox"], {
    cwd: f.dir,
    env: {
      HOME: f.dir,
      PATH: "/usr/bin:/bin",
      FOREMAN_STATE_DIR: f.cfg.stateDir,
      FOREMAN_THREAD_KEY: t.key,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("spooled without credentials");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  await r.drain();
  expect(f.sent.some((s) => s.text === "spooled without credentials" && s.root === "root")).toBe(
    true,
  );
  const access = r.start();
  const response = await fetch("http://localhost/control", {
    unix: access["FOREMAN_ROUTER_SOCKET"],
    method: "POST",
    body: JSON.stringify({ args: ["policy-set", "mm:channel1:root", "repo", '{"merge":true}'] }),
  });
  expect(response.status).toBe(403);
  expect(readdirSync(join(f.cfg.stateDir, "thread-outbox", t.key)).length).toBeGreaterThan(0);
});

test("resident reply and ask-human proxy reads stdin only when the helper needs it", async () => {
  const f = fixture();
  const socket = join(f.dir, "control.sock");
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => Response.json(await request.json()),
  });
  try {
    const cases = [
      { args: ["reply", "root", "argument reply"] },
      { args: ["reply", "root", "--dry-run", "argument reply"] },
      { args: ["reply", "root", ""] },
      { args: ["ask-human", "argument question", "--urgency", "background"] },
      { args: ["reply", "root"], input: "piped reply" },
      { args: ["reply", "root", "--dry-run"], input: "piped dry run" },
      { args: ["reply", "root", "-"], input: "stray root field" },
      { args: ["reply", "root", "--dry-run", "-"], input: "piped dash dry run" },
      { args: ["reply", "root", "-"], input: "" },
      { args: ["ask-human", "-", "--urgency", "background"], input: "piped question" },
    ];
    for (const { args, input } of cases) {
      const command = [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../src/thread-cli.ts"),
        ...args,
      ];
      const child = Bun.spawn(
        // Bun's piped stdin is a socket; use a shell pipe for the helper's stray '-' recovery.
        input === undefined ? command : ["bash", "-c", 'cat | "$@"', "stdin-proxy", ...command],
        {
          cwd: f.dir,
          env: {
            HOME: f.dir,
            PATH: "/usr/bin:/bin",
            FOREMAN_ROUTER_TOKEN: "test-capability",
            FOREMAN_ROUTER_SOCKET: socket,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        if (input !== undefined) {
          child.stdin.write(input);
          child.stdin.end();
        } // Argument messages must complete with stdin still open.
        await until(() => child.exitCode !== null);
        expect(await child.exited).toBe(0);
        expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
          args,
          text: input ?? "",
        });
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
  } finally {
    server.stop(true);
  }
});

test("surviving CLI locks count against the concurrency cap after restart", async () => {
  const f = fixture();
  f.cfg.maxThreadAgents = 1;
  const h = heldTurns();
  const r = f.router(h.run);
  f.bind(r, f.post("old"));
  f.bind(r, f.post("new"));
  const t = r.snapshot().threads[0];
  if (!t) throw new Error("no thread");
  const ready = join(f.dir, "lock-ready");
  const holder = Bun.spawn(
    [
      "flock",
      "-F",
      join(f.cfg.stateDir, "threads", `${t.key}.lock`),
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(ready)},'ready'); await Bun.stdin.text();`,
    ],
    {
      cwd: f.dir,
      env: { HOME: f.dir, PATH: "/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    await until(() => existsSync(ready));
    await r.tick();
    expect(h.calls).toHaveLength(0);
    holder.stdin.end();
    await holder.exited;
    await r.tick();
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.end({ ok: true });
    await until(() => r.snapshot().threads.every((thread) => thread.status !== "running"));
  } finally {
    holder.kill();
    await holder.exited;
  }
});

async function shellFixture() {
  const f = fixture();
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  const log = join(f.dir, "transport.jsonl");
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2); const config=args.includes('-K') ? await Bun.stdin.text() : '';
const url=args.find(a=>a.startsWith('https://') || a.startsWith('http://')) || config;
const tg=url.includes('telegram.org');
appendFileSync(process.env.MOCK_LOG,JSON.stringify({tg,args})+'\\n');
if(tg) console.log(JSON.stringify({ok:true,result:url.includes('getUpdates') ? JSON.parse(process.env.MOCK_UPDATES || '[]') : {message_id:7}}));
else if(url.endsWith('/users/me')) console.log(JSON.stringify({id:process.env.MOCK_BAD ? null:'bot'}));
else if(url.includes('/users/username/')) console.log(JSON.stringify({id:'henk'}));
else if(url.includes('/posts/root')) console.log(JSON.stringify({id:'root',root_id:'',channel_id:'actualchannel'}));
else console.log(JSON.stringify({id:'posted'}));
`,
  );
  chmodSync(curl, 0o700);
  const env = {
    HOME: f.dir,
    PATH: `${bin}:/usr/bin:/bin`,
    FOREMAN_HOME: resolve(import.meta.dir, ".."),
    FOREMAN_STATE_DIR: f.cfg.stateDir,
    FOREMAN_THREAD_AGENTS: "0",
    FOREMAN_WAIT_TIMEOUT: "1",
    MOCK_LOG: log,
    MATTERMOST_BASE_URL: "https://mock.invalid",
    MATTERMOST_BOT_TOKEN: "fabricated-mm",
    MATTERMOST_TARGET_USER: "henk",
    MATTERMOST_CHANNEL_ID: "configuredchannel",
    TELEGRAM_BOT_TOKEN: "fabricated-tg",
    TELEGRAM_CHAT_ID: "123",
  };
  const run = async (
    name: string,
    mode: string,
    args: string[],
    extra: Record<string, string> = {},
  ) => {
    const p = Bun.spawn(
      ["bash", resolve(import.meta.dir, `../examples/agent-bin/${name}.sh`), ...args],
      {
        cwd: f.dir,
        env: { ...env, FOREMAN_CHANNEL_MODE: mode, ...extra },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    p.stdin.write("hello");
    p.stdin.end();
    const stdout = await new Response(p.stdout).text();
    const stderr = await new Response(p.stderr).text();
    return { code: await p.exited, stdout, stderr };
  };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const clear = () => rmSync(log, { force: true });
  return { ...f, bin, env, run, calls, clear };
}

async function proxyFixture(mode: "auto" | "mattermost" | "telegram") {
  const f = await shellFixture();
  f.cfg.channelMode = mode;
  symlinkSync(process.execPath, join(f.bin, "bun"));
  for (const name of ["reply", "ask-human"])
    symlinkSync(resolve(import.meta.dir, `../examples/agent-bin/${name}.sh`), join(f.bin, name));
  const env = {
    ...f.env,
    FOREMAN_THREAD_KEY: "",
    FOREMAN_AGE_IDENTITY: join(f.cfg.stateDir, "age-identity.txt"),
    FOREMAN_AGE_RECIPIENT: "",
    MATTERMOST_TEAM: "",
    MATTERMOST_CHANNELS: "",
    MATTERMOST_ALLOWED_USERS: "henk",
    MOCK_BAD: "",
  };
  const router = new ThreadRouter(
    f.cfg,
    env,
    () => {},
    async () => ({ ok: false }),
    async () => {},
  );
  routers.push(router);
  const access = router.start();
  const proxy = async (name: string, args: string[], input = "") => {
    const child = Bun.spawn(
      ["bash", "-c", 'cat | "$@"', "proxy-test", join(f.bin, name), ...args],
      {
        cwd: f.dir,
        env: { HOME: f.dir, PATH: env.PATH, FOREMAN_HOME: env.FOREMAN_HOME, ...access },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(input);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { ...f, env, router, proxy };
}

test("resident proxy forwards consumed dash input through the real reply helper", async () => {
  const f = await proxyFixture("mattermost");
  const cwd = process.cwd();
  process.chdir(f.dir); // binPath resolves the fixture's helpers, never the live workspace's bin/.
  try {
    for (const dryRun of [false, true]) {
      for (const input of ["piped 'reply'\nsecond line\n", "", "\n"]) {
        f.clear();
        const result = await f.proxy(
          "reply",
          ["root", ...(dryRun ? ["--dry-run"] : []), "-"],
          input,
        );
        expect(result.code).toBe(0);
        const send = f.calls().find((c) => c.args.includes("-d"));
        const body = dryRun
          ? JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
          : JSON.parse(send.args[send.args.indexOf("-d") + 1]);
        expect(body.message).toBe(input.replace(/\n+$/, "") || "-");
        expect(body.root_id).toBe("root");
        expect(body.channel_id).toBe("actualchannel");
        if (dryRun) expect(send).toBeUndefined();
      }
    }
  } finally {
    await f.router.stop();
    process.chdir(cwd);
  }
});

test("resident auto proxy preserves lookup-failure fallback and bypasses lookup for Telegram-only secrets", async () => {
  const f = await proxyFixture("auto");
  let lookups = 0;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      lookups++;
      return new Response("offline", { status: 503 });
    },
  });
  f.env.MATTERMOST_BASE_URL = `http://127.0.0.1:${api.port}`;
  f.env.MATTERMOST_CHANNEL_ID = "";
  f.env.MOCK_BAD = "1";
  const cwd = process.cwd();
  process.chdir(f.dir);
  try {
    const result = await f.proxy("ask-human", ["question", "--options", "--secret"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^q\d+$/);
    expect(lookups).toBe(1);
    expect(f.calls().some((c) => c.tg)).toBe(true);
    // Explicit Mattermost mode still fails closed instead of falling back to Telegram.
    f.clear();
    f.cfg.channelMode = "mattermost";
    expect((await f.proxy("ask-human", ["question"])).code).toBe(1);
    expect(lookups).toBe(2);
    expect(f.calls()).toHaveLength(0);
    f.cfg.channelMode = "auto";
    // With both inboxes configured, the existing secret helper must still reject capture.
    expect((await f.proxy("ask-human", ["-", "--secret"], "fabricated question")).code).toBe(1);
    expect(lookups).toBe(2);
    expect(f.calls()).toHaveLength(0);
    // A dormant MM token alone must not block an otherwise Telegram-only secret question.
    f.env.MATTERMOST_BASE_URL = "";
    const wm = join(f.cfg.stateDir, "wait-reply");
    mkdirSync(wm, { recursive: true });
    writeFileSync(join(wm, "inbox.tg.offset"), "100");
    expect(
      Bun.spawnSync(["age-keygen", "-o", f.env.FOREMAN_AGE_IDENTITY], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode,
    ).toBe(0);
    const secret = await f.proxy("ask-human", ["-", "--secret"], "fabricated question");
    expect(secret.code).toBe(0);
    expect(secret.stdout.trim()).toMatch(/^secret-[a-f0-9-]+$/);
    expect(lookups).toBe(2);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0].tg).toBe(true);
    expect(existsSync(join(wm, "secret-replies", secret.stdout.trim(), "route.json"))).toBe(true);
  } finally {
    await f.router.stop();
    api.stop(true);
    process.chdir(cwd);
  }
});

test("real reply/ask/wait scripts obey primary/emergency modes and auto compatibility using mock curl", async () => {
  const f = await shellFixture();
  expect((await f.run("reply", "mattermost", ["root"])).code).toBe(0);
  expect(f.calls().every((c) => !c.tg)).toBe(true);
  const send = f.calls().find((c) => c.args.includes("-d"));
  const body = JSON.parse(send.args[send.args.indexOf("-d") + 1]);
  expect(body.channel_id).toBe("actualchannel");
  expect(body.root_id).toBe("root");
  f.clear();
  expect((await f.run("reply", "telegram", ["123"])).code).toBe(0);
  expect(f.calls().every((c) => c.tg)).toBe(true);
  f.clear();
  expect((await f.run("ask-human", "mattermost", ["question"])).code).toBe(0);
  expect(f.calls().every((c) => !c.tg)).toBe(true);
  f.clear();
  expect((await f.run("ask-human", "telegram", ["question"])).code).toBe(0);
  expect(f.calls().every((c) => c.tg)).toBe(true);
  f.clear();
  expect((await f.run("ask-human", "auto", ["question"])).code).toBe(0);
  expect(f.calls().some((c) => c.tg)).toBe(true);
  expect(f.calls().some((c) => !c.tg)).toBe(true);
  f.clear();
  expect((await f.run("wait-reply", "mattermost", ["--inbox"], { MOCK_BAD: "1" })).code).toBe(1);
  expect(f.calls().every((c) => !c.tg)).toBe(true);
  f.clear();
  expect((await f.run("reply", "typo", ["root"])).code).toBe(2);
  expect(f.calls()).toHaveLength(0);
});

test.each([
  ["auto", false],
  ["auto", true],
  ["mattermost", false],
  ["mattermost", true],
] as const)("thread inbox setup failure falls back only in auto mode (mode=%s, lookup=%j)", async (mode, lookup) => {
  const f = await shellFixture();
  symlinkSync(process.execPath, join(f.bin, "bun"));
  const offset = join(f.cfg.stateDir, "wait-reply/inbox.tg.offset");
  writeJson(offset, 100);
  let lookups = 0;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      lookups++;
      return new Response("offline", { status: 503 });
    },
  });
  try {
    const result = await f.run("wait-reply", mode, ["--inbox"], {
      FOREMAN_THREAD_AGENTS: "1",
      MATTERMOST_BASE_URL: `http://127.0.0.1:${api.port}`,
      MATTERMOST_TARGET_USER: lookup ? "henk" : "",
      MOCK_UPDATES: JSON.stringify([
        { update_id: 100, message: { message_id: 7, chat: { id: 123 }, text: "fallback reply" } },
      ]),
    });
    expect(lookups).toBe(lookup ? 1 : 0);
    expect(result.stderr).toContain(lookup ? "503" : "MATTERMOST_ALLOWED_USERS");
    if (mode === "auto") {
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("MSG 100 - fallback reply\n");
      expect(readJson(offset, 0)).toBe(101);
      expect(f.calls().length).toBeGreaterThan(0);
      expect(f.calls().every((c) => c.tg)).toBe(true);
    } else {
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(readJson(offset, 0)).toBe(100);
      expect(f.calls()).toHaveLength(0);
    }
  } finally {
    api.stop(true);
  }
});

test.each([
  "success",
  "timeout",
  "failure",
] as const)("thread inbox auto mode stays on Mattermost after setup (poll=%s)", async (outcome) => {
  const f = await shellFixture();
  symlinkSync(process.execPath, join(f.bin, "bun"));
  writeJson(join(f.cfg.stateDir, "wait-reply/mm-configuredchannel.json"), 0);
  let polls = 0;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.url.includes("/users/username/")) return Response.json({ id: "henk" });
      polls++;
      if (outcome === "failure") return new Response("offline", { status: 503 });
      const posts =
        outcome === "success"
          ? [
              {
                id: "post",
                root_id: "root",
                channel_id: "configuredchannel",
                user_id: "henk",
                create_at: 100,
                message: "Mattermost reply",
              },
            ]
          : [];
      return Response.json({
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      });
    },
  });
  try {
    const result = await f.run("wait-reply", "auto", ["--inbox"], {
      FOREMAN_THREAD_AGENTS: "1",
      MATTERMOST_BASE_URL: `http://127.0.0.1:${api.port}`,
    });
    expect(polls).toBeGreaterThan(0);
    expect(result.code).toBe(outcome === "success" ? 0 : outcome === "timeout" ? 3 : 1);
    expect(result.stdout).toBe(
      outcome === "success" ? "MSG mm:configuredchannel:post root Mattermost reply\n" : "",
    );
    expect(f.calls()).toHaveLength(0);
  } finally {
    api.stop(true);
  }
});

test.each([
  ["auto", true],
  ["auto", false],
  ["mattermost", true],
] as const)("thread inbox retains its wrapper and releases its child and lock (mode=%s, telegram=%j)", async (mode, telegram) => {
  const f = await shellFixture();
  symlinkSync(process.execPath, join(f.bin, "bun"));
  let polling = false;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.url.includes("/users/username/")) return Response.json({ id: "henk" });
      polling = true;
      return Response.json({ order: [], posts: {} });
    },
  });
  const child = Bun.spawn(
    ["bash", resolve(import.meta.dir, "../examples/agent-bin/wait-reply.sh"), "--inbox"],
    {
      cwd: f.dir,
      env: {
        ...f.env,
        FOREMAN_THREAD_AGENTS: "1",
        FOREMAN_CHANNEL_MODE: mode,
        FOREMAN_WAIT_TIMEOUT: "60",
        MATTERMOST_BASE_URL: `http://127.0.0.1:${api.port}`,
        TELEGRAM_BOT_TOKEN: telegram ? "fake" : "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await until(() => polling);
    const command = Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "args="], {
      stdout: "pipe",
    });
    expect(command.exitCode).toBe(0);
    expect(command.stdout.toString()).toContain("wait-reply.sh --inbox");
    child.kill();
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(f.calls()).toHaveLength(0);
    expect(
      Bun.spawnSync(["flock", "-n", join(f.cfg.stateDir, "wait-reply/.inbox.lock"), "true"])
        .exitCode,
    ).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    api.stop(true);
  }
});

test("existing single inbox script runs feature transport for two named channels and persists authorized receipts before routing", async () => {
  const f = await shellFixture();
  const preload = join(f.dir, "mock-transport.ts");
  writeFileSync(
    preload,
    `globalThis.fetch=async(input)=>{
const url=String(input);
if(url.includes('/users/username/')) return Response.json({id:'henk'});
if(url.includes('/channels/name/')) return Response.json({id:url.endsWith('/general')?'c1':'c2'});
const channel=url.includes('/channels/c1/')?'c1':'c2';
const p={id:'root'+channel,root_id:'',channel_id:channel,user_id:'henk',create_at:100,message:'work'};
return Response.json({posts:{a:p,b:{...p,id:'stranger'+channel,user_id:'stranger'}}});
};`,
  );
  writeFileSync(
    join(f.bin, "bun"),
    `#!/bin/sh\nexec '${process.execPath}' --preload "$MOCK_PRELOAD" "$@"\n`,
  );
  chmodSync(join(f.bin, "bun"), 0o700);
  for (const channel of ["c1", "c2"])
    writeJson(join(f.cfg.stateDir, `wait-reply/mm-${channel}.json`), 0);
  const result = await f.run("wait-reply", "mattermost", ["--inbox"], {
    FOREMAN_THREAD_AGENTS: "1",
    MOCK_PRELOAD: preload,
    MATTERMOST_TEAM: "calabytes",
    MATTERMOST_CHANNELS: "general,foreman-improvements",
    MATTERMOST_ALLOWED_USERS: "henk",
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("MSG mm:c1:rootc1 rootc1 work");
  expect(result.stdout).toContain("MSG mm:c2:rootc2 rootc2 work");
  expect(result.stdout).not.toContain("stranger");
  const h = heldTurns();
  const r = f.router(h.run);
  expect(r.route(result.stdout.trim().split("\n"))).toEqual([]);
  expect(f.resident).toHaveLength(2);
  f.bind(r, "mm:c2:rootc2");
  await r.tick();
  expect(h.calls).toHaveLength(1);
  h.calls[0]?.end({ ok: true, text: "thread result" });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  await r.drain();
  expect(
    f.sent.some((s) => s.channel === "c2" && s.root === "rootc2" && s.text === "thread result"),
  ).toBe(true);
});

test("deliberate shutdown retains an interrupted batch as queued for resume", async () => {
  const f = fixture();
  const held = heldTurns();
  const r = f.router(held.run);
  f.bind(r, f.post("shutdown"));
  await r.tick();
  await r.stop();
  held.calls[0]?.end({ ok: false });
  await until(() => r.snapshot().threads[0]?.status === "queued");
  expect(r.snapshot().threads[0]?.pending).toEqual(["shutdown"]);
  expect(r.snapshot().threads[0]?.error).toBeUndefined();
});
