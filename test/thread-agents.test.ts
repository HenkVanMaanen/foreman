// Unit and end-to-end mock checks. No real CLI, credentials, transport, poller reaper or supervisor.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, parseChannelMode, parseThreadCap } from "../src/config.ts";
import { formatInboxPrompt } from "../src/inbox.ts";
import { authorizedPosts, type HumanPost, Mattermost, receiptPath } from "../src/mattermost.ts";
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
  const cfg = {
    ...loadConfig(),
    threadAgents: true,
    channelMode: "mattermost" as const,
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

test("explicit channel modes, cap validation and flag-off environment compatibility", async () => {
  expect(parseChannelMode("auto")).toBe("auto");
  expect(parseChannelMode("telegram")).toBe("telegram");
  expect(() => parseChannelMode("typo")).toThrow();
  expect(() => parseThreadCap("0")).toThrow();
  expect(() => parseThreadCap("2.5")).toThrow();
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
  f.cfg.channelMode = "telegram" as "mattermost";
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
const url=args.find(a=>a.startsWith('https://')) || config;
const tg=url.includes('telegram.org');
appendFileSync(process.env.MOCK_LOG,JSON.stringify({tg,args})+'\\n');
if(tg) console.log(JSON.stringify({ok:true,result:{message_id:7}}));
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
