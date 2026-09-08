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
  expect(r.snapshot().threads[0]?.pending).toEqual(["root"]);
  expect(r.snapshot().threads[0]?.sessionId).toBeUndefined();
  expect(() => r.command("worker", ["retry", ref])).toThrow("resident authorization");
  r.command(r.token, ["retry", ref]);
  await r.tick();
  await until(() => r.snapshot().threads[0]?.status === "failed");
  expect(count).toBe(2);
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
  const args = ["policy-set", ref, "owner/repo", '{"merge":true}'];
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  expect(() => r.command("worker-token", args)).toThrow("resident authorization");
  expect(() =>
    r.command(r.token, ["policy-set", "mm:channel1:invented", "owner/repo", '{"merge":true}']),
  ).toThrow("not received");
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

test("poll backfills over 1,000 mixed-author posts before committing the cursor, retrying failed pages", async () => {
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
  const pages: number[] = [];
  const request = (async (input) => {
    const query = new URL(String(input)).searchParams;
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

test("stopping the auto-mode thread inbox releases its child and inbox lock", async () => {
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
        FOREMAN_CHANNEL_MODE: "auto",
        FOREMAN_WAIT_TIMEOUT: "60",
        MATTERMOST_BASE_URL: `http://127.0.0.1:${api.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await until(() => polling);
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
