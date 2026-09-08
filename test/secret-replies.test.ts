// Real scripts + real age, fake Telegram. No .env, network or user credentials.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatInboxPrompt } from "../src/inbox.ts";

const home = resolve(import.meta.dir, "..");
const script = join(home, "examples/agent-bin/wait-reply.sh");
const ask = join(home, "examples/agent-bin/ask-human.sh");
const helper = join(home, "src/secret-replies.ts");
const sentinel = "FABRICATED_CAPTURE_SENTINEL_!_abc123";
const fixtures: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const p of children.splice(0)) {
    if (p.exitCode === null) {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        p.kill();
      }
    }
    await p.exited;
  }
  for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("test barrier timed out");
    await Bun.sleep(10);
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "foreman-secret-test-"));
  fixtures.push(dir);
  const state = join(dir, "state");
  const wm = join(state, "wait-reply");
  await mkdir(wm, { recursive: true });
  await mkdir(join(dir, "bin"));
  // Resolve Bun before replacing HOME: host version-manager shims need the real HOME.
  await symlink(process.execPath, join(dir, "bin/bun"));
  await writeFile(join(wm, "inbox.tg.offset"), "100");
  await writeFile(join(dir, "updates.json"), "[]");
  const key = Bun.spawnSync(["age-keygen", "-o", join(state, "age-identity.txt")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(key.exitCode).toBe(0);
  const curl = join(dir, "bin/curl");
  await writeFile(
    curl,
    `#!${process.execPath}
import {existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync} from 'node:fs';
const dir = process.env.MOCK_DIR;
const config = await Bun.stdin.text();
if (config.includes('/sendMessage')) {
  const text = process.argv.find(a => a.startsWith('text='));
  const id = text.match(/#(secret-[a-f0-9-]+)/)[1];
  if (!existsSync(dir+'/state/wait-reply/secret-replies/'+id+'/route.json')) process.exit(9);
  writeFileSync(dir+'/posted-id', id);
  console.log(JSON.stringify({ok: !existsSync(dir+'/fail-send')}));
} else if (config.includes('/getUpdates')) {
  let fd;
  try { fd = openSync(dir+'/api-active', 'wx'); } catch { writeFileSync(dir+'/overlap', '1'); process.exit(9); }
  const offset = Number(config.match(/offset=(-?\\d+)/)[1]);
  writeFileSync(dir+'/poll-entered', String(offset));
  while (existsSync(dir+'/hold') && !existsSync(dir+'/release')) await Bun.sleep(10);
  const updates = JSON.parse(readFileSync(dir+'/updates.json', 'utf8'));
  console.log(JSON.stringify({ok:true,result:offset < 0 ? updates.slice(-1) : updates.filter(u => u.update_id >= offset)}));
  closeSync(fd); unlinkSync(dir+'/api-active');
} else { console.log('{"ok":true}'); }
`,
  );
  await chmod(curl, 0o700);
  const env = {
    PATH: `${join(dir, "bin")}:/usr/bin:/bin:${process.env["PATH"]}`,
    HOME: dir,
    FOREMAN_HOME: home,
    FOREMAN_STATE_DIR: state,
    TELEGRAM_BOT_TOKEN: "FABRICATED_BOT_TOKEN",
    TELEGRAM_CHAT_ID: "123",
    FOREMAN_WAIT_TIMEOUT: "1",
    MOCK_DIR: dir,
  };
  function spawn(args: string[], extra = {}) {
    const p = Bun.spawn(["setsid", ...args], {
      cwd: dir,
      env: { ...env, ...extra },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(p);
    return p;
  }
  async function run(args: string[], extra = {}, input = "") {
    const p = spawn(args, extra);
    p.stdin.write(input);
    await p.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { out, err, code };
  }
  async function reserve() {
    const result = await run(["bash", ask, "Fabricated test question", "--secret"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    return result.out.trim();
  }
  async function updates(items: unknown[]) {
    await writeFile(join(dir, "updates.json"), JSON.stringify(items));
  }
  function reply(id: string, uid = 100, chat = 123, text = sentinel) {
    return {
      update_id: uid,
      message: {
        message_id: uid,
        chat: { id: chat },
        text,
        reply_to_message: { text: `Fabricated question (ref #${id})` },
      },
    };
  }
  const ordinary = (uid = 101) => ({
    update_id: uid,
    message: { message_id: uid, chat: { id: 123 }, text: "ordinary follow-up" },
  });
  const route = (id: string) => join(wm, "secret-replies", id);
  return { dir, wm, state, env, spawn, run, reserve, updates, reply, ordinary, route };
}

test("in-flight supervisor poll + raw waiter: encrypt before MSG output, exactly one API owner", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "hold"), "1");
  const inbox = f.spawn(["bash", script, "--inbox"]);
  await until(() => existsSync(join(f.dir, "poll-entered")));
  const id = await f.reserve(); // reserve while the supervisor's request is already in flight
  const waiter = f.spawn(["bash", script, id, "--raw"], { FOREMAN_WAIT_TIMEOUT: "5" });
  await until(() => existsSync(join(f.route(id), "waiter.lock")));
  await f.updates([f.reply(id), f.ordinary()]);
  await writeFile(join(f.dir, "release"), "1");
  const out = await new Response(inbox.stdout).text();
  expect(await inbox.exited).toBe(0);
  expect(out).toBe("MSG 101 - ordinary follow-up\n");
  expect(formatInboxPrompt(out.trim().split("\n"))).not.toContain(sentinel);
  expect(await new Response(waiter.stdout).text()).toBe(sentinel); // no newline
  expect(await waiter.exited).toBe(0);
  expect(await new Response(waiter.stderr).text()).toBe("");
  expect(existsSync(join(f.dir, "overlap"))).toBe(false);
  expect(await readFile(join(f.wm, "inbox.tg.offset"), "utf8")).toBe("102");
  expect(existsSync(join(f.wm, ".single-active"))).toBe(false);
  expect(existsSync(join(f.route(id), "reply.age"))).toBe(false);
  expect(existsSync(join(f.route(id), "closed"))).toBe(true);
});

test("reply before waiter, killed waiter, restarted inbox and replay retain private ownership", async () => {
  const f = await fixture();
  const id = await f.reserve();
  const abandoned = f.spawn(["bash", script, id, "--raw"], { FOREMAN_WAIT_TIMEOUT: "10" });
  await until(() => existsSync(join(f.route(id), "waiter.lock")));
  // Wait for the OS lock, not a timing guess, before testing the second claimant.
  await until(
    async () => (await f.run(["flock", "-n", join(f.route(id), "waiter.lock"), "true"])).code === 1,
  );
  const duplicate = await f.run(["bash", script, id, "--raw"]);
  expect(duplicate.code).toBe(4);
  process.kill(-abandoned.pid, "SIGKILL");
  await abandoned.exited;
  await f.updates([f.reply(id), f.reply(id, 101), f.ordinary(102)]);
  expect((await f.run(["bash", script, "--inbox"])).out).toBe("MSG 102 - ordinary follow-up\n");
  const cipher = await readFile(join(f.route(id), "reply.age"), "utf8");
  expect(cipher).toStartWith("-----BEGIN AGE ENCRYPTED FILE-----");
  expect(cipher).not.toContain(sentinel);
  expect((await stat(join(f.route(id), "reply.age"))).mode & 0o777).toBe(0o600);
  // Simulate a crash after ciphertext commit but before offset commit.
  await writeFile(join(f.wm, "inbox.tg.offset"), "100");
  await f.run(["bash", script, "--inbox"]);
  expect(await readFile(join(f.route(id), "reply.age"), "utf8")).toBe(cipher);
  const recovered = await f.run(["bash", script, id, "--raw"]);
  expect(recovered).toEqual({ out: sentinel, err: "", code: 0 });
  // Late replies after completion are tombstoned even in a new poller process.
  await f.updates([f.reply(id, 103), f.ordinary(104)]);
  expect((await f.run(["bash", script, "--inbox"])).out).toBe("MSG 104 - ordinary follow-up\n");
  expect((await f.run(["bash", script, id, "--raw"])).code).toBe(4);
});

test("timeout, explicit cancel, expiry and ambiguous send clean up without releasing late replies", async () => {
  const f = await fixture();
  const timed = await f.reserve();
  const timeout = await f.run(["bash", script, timed, "--raw"], { FOREMAN_WAIT_TIMEOUT: "0.05" });
  expect(timeout.code).toBe(3);
  expect(timeout.out).toBe("");
  const cancelled = await f.reserve();
  expect((await f.run(["bash", script, cancelled, "--cancel"])).code).toBe(0);
  const expired = await f.reserve();
  const metadata = join(f.route(expired), "route.json");
  const route = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(metadata, JSON.stringify({ ...route, expires: 0 }));
  await writeFile(join(f.dir, "fail-send"), "1");
  expect((await f.run(["bash", ask, "Fabricated question", "--secret"])).code).not.toBe(0);
  const failed = await readFile(join(f.dir, "posted-id"), "utf8");
  await f.updates([
    f.reply(timed),
    f.reply(cancelled, 101),
    f.reply(expired, 102),
    f.reply(failed, 103),
    f.ordinary(104),
  ]);
  expect((await f.run(["bash", script, "--inbox"])).out).toBe("MSG 104 - ordinary follow-up\n");
  for (const id of [timed, cancelled, expired, failed]) {
    expect(existsSync(join(f.route(id), "closed"))).toBe(true);
    expect(existsSync(join(f.route(id), "reply.age"))).toBe(false);
  }
});

test("encryption/metadata errors fail closed with no stdout and no watermark advance", async () => {
  const f = await fixture();
  const id = await f.reserve();
  const meta = join(f.route(id), "route.json");
  const good = await readFile(meta, "utf8");
  await writeFile(
    meta,
    JSON.stringify({ ...JSON.parse(good), recipient: "invalid-test-recipient" }),
  );
  await f.updates([f.reply(id), f.ordinary()]);
  const failed = await f.run(["bash", script, "--inbox"]);
  expect(failed.code).toBe(1);
  expect(failed.out).toBe("");
  expect(failed.err).not.toContain(sentinel);
  expect(await readFile(join(f.wm, "inbox.tg.offset"), "utf8")).toBe("100");
  await writeFile(meta, good);
  expect((await f.run(["bash", script, "--inbox"])).out).toBe("MSG 101 - ordinary follow-up\n");
  await writeFile(meta, `invalid JSON ${sentinel}`);
  const corrupt = await f.run(
    [process.execPath, helper, "filter"],
    {},
    JSON.stringify({ result: [] }),
  );
  expect(corrupt.code).toBe(1);
  expect(corrupt.out).toBe("");
  expect(corrupt.err).not.toContain(sentinel);
});

test("wrong chat, unknown namespace, exact tag boundaries and legacy raw claims fail closed", async () => {
  const f = await fixture();
  const id = await f.reserve();
  const unreserved = "secret-00000000-0000-0000-0000-000000000000";
  await f.updates([
    f.reply(id, 100, 999),
    f.reply(unreserved, 101),
    f.reply(`${id}extra`, 102),
    f.ordinary(103),
  ]);
  expect((await f.run(["bash", script, "--inbox"])).out).toBe("MSG 103 - ordinary follow-up\n");
  expect(existsSync(join(f.route(id), "reply.age"))).toBe(false);
  expect((await f.run(["bash", script, "q-fabricated", "--raw"])).code).toBe(2);
  expect((await f.run(["bash", script, id])).code).toBe(2);
  // Tag in answer itself (legacy typing convention) is supported, with exact boundaries.
  await f.updates([
    { update_id: 104, message: { message_id: 104, chat: { id: 123 }, text: `${sentinel} #${id}` } },
    f.ordinary(105),
  ]);
  await f.run(["bash", script, "--inbox"]);
  expect((await f.run(["bash", script, id, "--raw"])).out).toBe(sentinel);
  // Every persisted artifact contains only metadata/ciphertext, never the fabricated value.
  for (const name of await readdir(f.route(id))) {
    expect(await readFile(join(f.route(id), name), "utf8")).not.toContain(sentinel);
  }
});

test("a missing watermark on restart captures pending replies instead of seeding past them", async () => {
  const f = await fixture();
  const id = await f.reserve();
  await rm(join(f.wm, "inbox.tg.offset"));
  await f.updates([f.reply(id), f.ordinary()]);
  const inbox = await f.run(["bash", "-x", script, "--inbox"]);
  expect(inbox.code).toBe(0);
  expect(inbox.out).toBe("MSG 101 - ordinary follow-up\n");
  expect(inbox.err).not.toContain(sentinel);
  expect(inbox.err).not.toContain(f.env.TELEGRAM_BOT_TOKEN);
  expect(await readFile(join(f.dir, "poll-entered"), "utf8")).toBe("0");
  expect((await f.run(["bash", script, id, "--raw"])).out).toBe(sentinel);
});

test("two inboxes serialize in-flight calls; legacy waits also encrypt reserved replies", async () => {
  const f = await fixture();
  const id = await f.reserve();
  await writeFile(join(f.dir, "hold"), "1");
  const first = f.spawn(["bash", script, "--inbox"]);
  await until(() => existsSync(join(f.dir, "poll-entered")));
  // The second process announces itself before attempting the already-held poll lock.
  const second = f.spawn([
    "bash",
    "-c",
    'touch "$MOCK_DIR/second-started"; exec bash "$1" --inbox',
    "test",
    script,
  ]);
  await until(() => existsSync(join(f.dir, "second-started")));
  expect((await f.run(["flock", "-n", join(f.wm, ".telegram-poll.lock"), "true"])).code).toBe(1);
  await f.updates([f.reply(id), f.ordinary()]);
  await writeFile(join(f.dir, "release"), "1");
  expect(await new Response(first.stdout).text()).toBe("MSG 101 - ordinary follow-up\n");
  expect(await first.exited).toBe(0);
  expect(await new Response(second.stdout).text()).toBe("");
  expect(await second.exited).toBe(3);
  expect(existsSync(join(f.dir, "overlap"))).toBe(false);
  const other = await f.reserve();
  await f.updates([
    f.reply(other, 102),
    { ...f.ordinary(103), message: { message_id: 103, chat: { id: 123 }, text: "yes #q-test" } },
  ]);
  const legacy = await f.run(["bash", script, "q-test"]);
  expect(legacy).toEqual({ out: "yes\n", err: "", code: 0 });
  expect(existsSync(join(f.wm, ".single-active"))).toBe(false);
  expect((await f.run(["bash", script, other, "--raw"])).out).toBe(sentinel);
  expect((await f.run(["bash", script, id, "--raw"])).out).toBe(sentinel);
});

test("raw pipe stores ciphertext only; failed consumers cannot replay a claimed value", async () => {
  const f = await fixture();
  const id = await f.reserve();
  await f.updates([f.reply(id), f.ordinary()]);
  await f.run(["bash", script, "--inbox"]);
  const stored = await f.run([
    "bash",
    "-o",
    "pipefail",
    "-c",
    'bash "$1" "$2" --raw | bun "$FOREMAN_HOME/src/foreman.ts" secret set FABRICATED_CAPTURE',
    "test",
    script,
    id,
  ]);
  expect(stored).toEqual({ out: "stored secret FABRICATED_CAPTURE\n", err: "", code: 0 });
  const file = join(f.state, "secrets/FABRICATED_CAPTURE.age");
  const cipher = await readFile(file, "utf8");
  expect(cipher).toStartWith("-----BEGIN AGE ENCRYPTED FILE-----");
  expect(cipher).not.toContain(sentinel);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await f.run(["age", "-d", "-i", join(f.state, "age-identity.txt"), file])).out).toBe(
    sentinel,
  );
  const failed = await f.reserve();
  await f.updates([f.reply(failed, 102), f.ordinary(103)]);
  await f.run(["bash", script, "--inbox"]);
  // Consume without logging, then fail (e.g. the downstream store could not commit).
  const sink = await f.run([
    "bash",
    "-o",
    "pipefail",
    "-c",
    'bash "$1" "$2" --raw | { cat >/dev/null; exit 7; }',
    "test",
    script,
    failed,
  ]);
  expect(sink.code).toBe(7);
  expect(sink.out).toBe("");
  expect((await f.run(["bash", script, failed, "--raw"])).code).toBe(4);
  expect(existsSync(join(f.route(failed), "reply.age"))).toBe(false);
});

test("decryption failures retain only ciphertext for retry; invalid setup never posts a question", async () => {
  const f = await fixture();
  const id = await f.reserve();
  await f.updates([f.reply(id), f.ordinary()]);
  await f.run(["bash", script, "--inbox"]);
  const broken = { FOREMAN_AGE_IDENTITY: join(f.dir, "missing-test-key") };
  const failed = await f.run(["bash", script, id, "--raw"], broken);
  expect(failed.code).toBe(1);
  expect(failed.out).toBe("");
  expect(failed.err).not.toContain(sentinel);
  expect(existsSync(join(f.route(id), "reply.age"))).toBe(true);
  expect((await f.run(["bash", script, id, "--raw"])).out).toBe(sentinel);
  await rm(join(f.dir, "posted-id"));
  for (const config of [
    broken,
    { MATTERMOST_BASE_URL: "https://fabricated.invalid", MATTERMOST_BOT_TOKEN: "FABRICATED" },
  ]) {
    const askResult = await f.run(["bash", ask, "Fabricated question", "--secret"], config);
    expect(askResult.code).toBe(1);
    expect(askResult.out).toBe("");
    expect(existsSync(join(f.dir, "posted-id"))).toBe(false);
  }
});

test("documents, edits and ambiguous routes stay private without changing ordinary document output", async () => {
  const f = await fixture();
  const id = await f.reserve();
  const other = await f.reserve();
  const privateDocument = {
    update_id: 100,
    message: {
      chat: { id: 123 },
      document: { file_id: sentinel, file_name: sentinel },
      caption: sentinel,
      reply_to_message: { text: `Fabricated question #${id}` },
    },
  };
  await f.updates([
    privateDocument,
    { update_id: 101, edited_message: f.reply(id).message },
    f.reply(id, 102, 123, `${sentinel} #${other}`),
    {
      update_id: 103,
      message: {
        message_id: 103,
        chat: { id: 123 },
        document: { file_id: "file-test", file_name: "test.txt" },
        caption: "ordinary\ncaption",
      },
    },
  ]);
  const inbox = await f.run(["bash", script, "--inbox"]);
  expect(inbox.out).toBe(
    "MSG 103 - TG_DOCUMENT file_id=file-test file_name=test.txt caption=ordinary caption\n",
  );
  expect(inbox.err).not.toContain(sentinel);
  expect(existsSync(join(f.route(other), "reply.age"))).toBe(false);
  expect((await f.run(["bash", script, id, "--raw"])).out).toBe(sentinel);
});
