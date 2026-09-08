// Telegram secret replies are intercepted BEFORE inbox formatting. Only ciphertext and
// routing metadata reach disk; the raw waiter never calls getUpdates. All mutations use
// the same flock (including across processes/restarts). Never print caught errors here:
// JSON parser, HTTP and subprocess diagnostics can contain a reply or credentials.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";

const base = join(process.env["FOREMAN_STATE_DIR"] || "state", "wait-reply");
const routes = join(base, "secret-replies");
const idPattern = /^secret-[a-f0-9-]{36}$/;
const tagPattern = /#(secret-[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g;
const ttlMs = 60 * 60 * 1000;
type Route = { chat: string; recipient: string; expires: number };
type Message = {
  text?: string;
  caption?: string;
  chat?: { id: number | string };
  reply_to_message?: Message;
};
type Update = { update_id: number; message?: Message; edited_message?: Message };

function routeDir(id: string): string {
  if (!idPattern.test(id)) throw new Error("invalid secret route");
  return join(routes, id);
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  const file = await open(tmp, "w", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  const dir = await open(resolve(path, ".."), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function closeRoute(id: string): Promise<void> {
  const dir = routeDir(id);
  if (!existsSync(dir)) throw new Error("unknown secret route");
  // Keep the tombstone forever: late replies, edits and replay must stay private.
  await atomicWrite(join(dir, "closed"), "1");
  await rm(join(dir, "reply.age"), { force: true });
  await rm(join(dir, "reply.age.tmp"), { force: true });
}

async function sweep(): Promise<void> {
  if (!existsSync(routes)) return;
  for (const id of await readdir(routes)) {
    if (!idPattern.test(id)) continue;
    const dir = routeDir(id);
    const meta = join(dir, "route.json");
    if (!existsSync(meta)) continue; // interrupted reserve; unknown secret tags still suppressed
    const route: Route = JSON.parse(await readFile(meta, "utf8"));
    if (route.expires <= Date.now() || existsSync(join(dir, "closed"))) await closeRoute(id);
  }
}

async function reserve(): Promise<void> {
  const cfg = loadConfig();
  const chat = process.env["TELEGRAM_CHAT_ID"];
  // This capture path intentionally uses Telegram only. Mattermost-first pollers cannot
  // deliver it, so reject that configuration before posting anything to the human.
  if (
    !chat ||
    !process.env["TELEGRAM_BOT_TOKEN"] ||
    (process.env["MATTERMOST_BASE_URL"] && process.env["MATTERMOST_BOT_TOKEN"])
  )
    throw new Error("requires Telegram inbox");
  const offset = await readFile(join(base, "inbox.tg.offset"), "utf8");
  if (!/^\d+$/.test(offset)) throw new Error("start the inbox first");
  let recipient = cfg.ageRecipient;
  if (!recipient) {
    const p = Bun.spawnSync(["age-keygen", "-y", resolve(cfg.ageIdentityFile)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) throw new Error("missing age identity");
    recipient = p.stdout.toString().trim();
  }
  // Validate encryption before asking for a secret (fabricated, non-secret probe).
  const probe = Bun.spawnSync(["age", "-a", "-r", recipient], {
    stdin: Buffer.from("capture readiness probe"),
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) throw new Error("age unavailable");
  const check = Bun.spawnSync(["age", "-d", "-i", resolve(cfg.ageIdentityFile)], {
    stdin: probe.stdout,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (check.exitCode !== 0) throw new Error("capture identity cannot decrypt");
  await mkdir(routes, { recursive: true, mode: 0o700 });
  await chmod(routes, 0o700);
  const id = `secret-${randomUUID()}`;
  await mkdir(routeDir(id), { mode: 0o700 });
  await atomicWrite(
    join(routeDir(id), "route.json"),
    JSON.stringify({
      chat,
      recipient,
      expires: Date.now() + ttlMs,
    } satisfies Route),
  );
  console.log(id);
}

async function filter(): Promise<void> {
  const response = JSON.parse(await Bun.stdin.text()) as { result: Update[] };
  if (!Array.isArray(response.result)) throw new Error("invalid Telegram response");
  await sweep();
  for (const [index, update] of response.result.entries()) {
    const message = update.message ?? update.edited_message;
    if (!message) continue;
    const tags = new Set<string>();
    // Telegram's Reply UI puts the routing tag in the quoted question, not in the answer.
    for (const text of [
      message.text,
      message.caption,
      message.reply_to_message?.text,
      message.reply_to_message?.caption,
    ]) {
      for (const match of (text ?? "").matchAll(tagPattern)) tags.add(match[1] as string);
    }
    if (tags.size === 0) continue;
    // Preserve update_id for the offset, but never return any part of a private update.
    response.result[index] = { update_id: update.update_id };
    if (tags.size !== 1 || !message.text) continue;
    const id = [...tags][0] as string;
    if (!idPattern.test(id)) continue; // reserved namespace also fails closed without metadata
    const dir = routeDir(id);
    if (!existsSync(join(dir, "route.json")) || existsSync(join(dir, "closed"))) continue;
    const route: Route = JSON.parse(await readFile(join(dir, "route.json"), "utf8"));
    if (String(message.chat?.id) !== route.chat || existsSync(join(dir, "reply.age"))) continue;
    const value = message.text?.replace(new RegExp(`#${id}(?![A-Za-z0-9_-])`, "g"), "").trim();
    if (!value) continue; // attachments/reactions/empty replies cannot become secret values
    const p = Bun.spawn(["age", "-a", "-r", route.recipient], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    p.stdin.write(value);
    await p.stdin.end();
    const ciphertext = await new Response(p.stdout).arrayBuffer();
    if ((await p.exited) !== 0) throw new Error("encryption failed");
    await atomicWrite(join(dir, "reply.age"), new Uint8Array(ciphertext));
  }
  // Only after ALL captures have been committed can the caller advance its watermark.
  console.log(JSON.stringify(response));
}

async function take(id: string): Promise<number> {
  const cfg = loadConfig();
  const dir = routeDir(id);
  const route: Route = JSON.parse(await readFile(join(dir, "route.json"), "utf8"));
  if (route.expires <= Date.now()) await closeRoute(id);
  if (existsSync(join(dir, "closed"))) return 4;
  if (!existsSync(join(dir, "reply.age"))) return 3;
  const p = Bun.spawn(["age", "-d", "-i", resolve(cfg.ageIdentityFile), join(dir, "reply.age")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const value = await new Response(p.stdout).arrayBuffer();
  if ((await p.exited) !== 0) throw new Error("decryption failed");
  // Claim before emitting. A crashed downstream consumer must start a NEW capture; never
  // replay this reply into a different consumer. Nothing prints except on this raw path.
  await closeRoute(id);
  await Bun.write(Bun.stdout, value);
  return 0;
}

async function locked(command: string, id: string): Promise<number> {
  const p = Bun.spawn(
    ["flock", join(base, ".secret.lock"), process.execPath, import.meta.path, command, id],
    { stdin: "ignore", stdout: "inherit", stderr: "ignore" },
  );
  return await p.exited;
}

async function wait(id: string): Promise<number> {
  routeDir(id);
  const seconds = Number(process.env["FOREMAN_WAIT_TIMEOUT"] ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid timeout");
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const code = await locked("take", id);
    if (code !== 3) return code;
    await Bun.sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  await locked("cancel", id);
  return 3;
}

try {
  const [, , command, id = ""] = process.argv;
  switch (command) {
    case "reserve":
      await reserve();
      break;
    case "filter":
      await filter();
      break;
    case "take":
      process.exitCode = await take(id);
      break;
    case "wait":
      process.exitCode = await wait(id);
      break;
    case "cancel":
      await closeRoute(id);
      break;
    default:
      throw new Error("unknown operation");
  }
} catch {
  console.error(
    "secret-reply: failed safely; check capture configuration/state (no payload logged)",
  );
  process.exitCode = 1;
}
