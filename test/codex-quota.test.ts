// Isolated state, injected transport and harmless app-server stubs only. No real CLI or reaper.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexQuotaMonitor,
  type QuotaWindow,
  quotaWindows,
  readCodexQuota,
} from "../src/codex-quota.ts";
import { loadConfig, parseQuotaPollMs, parseQuotaThread } from "../src/config.ts";
import { enqueueOutbox, readOutbox } from "../src/thread-outbox.ts";
import { readJson, writeJson } from "../src/thread-store.ts";
import { ThreadRouter } from "../src/threads.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "fm-quota-test-"));
  dirs.push(dir);
  return dir;
}
const start = 1_800_000_000_000;
const reset = start / 1000 + 86400;
const rawWindow = (used = 95, resetsAt: number | null = reset, windowDurationMins = 10080) => ({
  usedPercent: used,
  resetsAt,
  windowDurationMins,
});
const sample = (remaining = 5, resetsAt: number | null = reset): [QuotaWindow] => [
  {
    slot: "primary",
    remaining,
    durationMins: 10080,
    resetsAt,
  },
];

function fixture() {
  const state = directory();
  let now = start;
  let windows = sample();
  let failed = false;
  let reads = 0;
  const read = async () => {
    reads++;
    if (failed) throw new Error("private upstream details must not persist");
    return windows;
  };
  const monitor = () => new CodexQuotaMonitor(state, 60000, read, undefined, () => now);
  const poll = async (m: CodexQuotaMonitor, value: QuotaWindow[] = windows) => {
    windows = value;
    now += 60000;
    await m.tick("bound");
  };
  return {
    state,
    monitor,
    poll,
    read,
    reads: () => reads,
    fail: () => {
      failed = true;
    },
    entries: () => readOutbox(state, "bound"),
  };
}

test("main codex selection, both windows, null secondary, and unknown/stale fields", () => {
  const response = {
    rateLimits: { limitId: "codex_spark", primary: rawWindow(100) },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: rawWindow(95), secondary: rawWindow(96, reset, 300) },
      codex_spark: { primary: rawWindow(100) },
      reserve: { primary: rawWindow(100) },
    },
  };
  expect(quotaWindows(response, start)).toEqual([
    ...sample(),
    { slot: "secondary", remaining: 4, durationMins: 300, resetsAt: reset },
  ]);
  expect(
    quotaWindows(
      { rateLimits: { limitId: "codex", primary: rawWindow(), secondary: null } },
      start,
    ),
  ).toEqual(sample());
  expect(quotaWindows({ rateLimitsByLimitId: { codex: { primary: rawWindow() } } }, start)).toEqual(
    sample(),
  );
  for (const result of [
    null,
    {},
    { rateLimits: { primary: rawWindow() } },
    { rateLimits: { limitId: "codex_spark", primary: rawWindow() } },
    { ...response, rateLimitsByLimitId: {} },
    { ...response, rateLimitsByLimitId: { codex: { limitId: "reserve", primary: rawWindow() } } },
  ])
    expect(quotaWindows(result, start)).toEqual([]);
  for (const usedPercent of [null, undefined, "95", Number.NaN, Infinity, -1, 101]) {
    expect(
      quotaWindows({ rateLimits: { limitId: "codex", primary: { usedPercent } } }, start),
    ).toEqual([]);
  }
  expect(
    quotaWindows({ rateLimits: { limitId: "codex", primary: rawWindow(99, start / 1000) } }, start),
  ).toEqual([]);
  expect(
    quotaWindows({ rateLimits: { limitId: "codex", primary: rawWindow(99, null) } }, start)[0]
      ?.remaining,
  ).toBe(1);
});

test("inclusive 5% threshold, one combined alert, no repeats at zero or after restart", async () => {
  const f = fixture();
  const m = f.monitor();
  await f.poll(m, sample(5.01));
  expect(f.entries()).toHaveLength(0);
  const windows = [...sample(), { ...sample(4)[0], slot: "secondary" as const, durationMins: 300 }];
  await f.poll(m, windows);
  const entries = f.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.item.text).toContain("weekly: 5% left");
  expect(entries[0]?.item.text).toContain("5h: 4% left");
  expect(entries[0]?.item.text).toContain("UTC");
  await f.poll(m, sample(0));
  await f.poll(f.monitor(), sample(0));
  const restartedEntries = f.entries();
  expect(restartedEntries).toHaveLength(1);
  expect(restartedEntries[0]?.item.sendOnce).toBe(true);
});

test("recovery and forward reset rearm; backwards or missing reset metadata do not", async () => {
  const f = fixture();
  const m = f.monitor();
  await f.poll(m);
  await f.poll(m, sample(30));
  await f.poll(m, sample(4));
  expect(f.entries()).toHaveLength(2);
  await f.poll(m, sample(3, reset + 86400));
  expect(f.entries()).toHaveLength(3);
  await f.poll(m, sample(3, reset));
  await f.poll(m, sample(3, null));
  await f.poll(m, sample(3, reset + 86400));
  const entries = f.entries();
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map((entry) => entry.file)).size).toBe(3);
});

test("duration metadata changes preserve suppression and recovery across restarts", async () => {
  for (const durationMins of [10080, null]) {
    for (const resetsAt of [reset, null]) {
      const f = fixture();
      const first = { ...sample(4, resetsAt)[0], durationMins };
      const changed = { ...first, durationMins: durationMins === null ? 10080 : null };
      await f.poll(f.monitor(), [first]);
      await f.poll(f.monitor(), [changed]);
      await f.poll(f.monitor(), []);
      await f.poll(f.monitor(), [first]);
      expect(f.entries()).toHaveLength(1);

      await f.poll(f.monitor(), [{ ...changed, remaining: 30 }]);
      await f.poll(f.monitor(), [first]);
      expect(f.entries()).toHaveLength(2);
      await f.poll(f.monitor(), [{ ...first, remaining: 30 }]);
      await f.poll(f.monitor(), [changed]);
      expect(f.entries()).toHaveLength(3);
      await f.poll(f.monitor(), [first]);
      expect(f.entries()).toHaveLength(3);
    }
  }
});

test("duration identities remain independent after slot swaps and missing metadata", async () => {
  const f = fixture();
  const weekly = { ...sample(4)[0], slot: "secondary" as const };
  const short = { ...sample(4)[0], durationMins: 300 };
  await f.poll(f.monitor(), [short, weekly]);
  await f.poll(f.monitor(), [
    { ...weekly, slot: "primary" },
    { ...short, slot: "secondary" },
  ]);
  await f.poll(f.monitor(), [
    { ...weekly, slot: "primary", durationMins: null, remaining: 30 },
    { ...short, slot: "secondary", durationMins: null },
  ]);
  expect(f.entries()).toHaveLength(1);
  await f.poll(f.monitor(), [short, weekly]);
  const entries = f.entries();
  expect(entries).toHaveLength(2);
  expect(entries.filter((entry) => entry.item.text.includes("5h:"))).toHaveLength(1);
});

test("slot swaps with one missing duration preserve both alerted episodes", async () => {
  for (const missingDuration of [300, 10080]) {
    const f = fixture();
    const weekly = { ...sample(4)[0], slot: "secondary" as const };
    const short = { ...sample(4)[0], durationMins: 300 };
    const swapped: QuotaWindow[] = [
      { ...weekly, slot: "primary" as const },
      { ...short, slot: "secondary" as const },
    ].map((window) => ({
      ...window,
      durationMins: window.durationMins === missingDuration ? null : window.durationMins,
    }));
    await f.poll(f.monitor(), [short, weekly]);
    await f.poll(f.monitor(), swapped);
    expect(f.entries()).toHaveLength(1);
    await f.poll(
      f.monitor(),
      swapped.map((window) => ({ ...window, durationMins: null })),
    );
    expect(f.entries()).toHaveLength(1);

    await f.poll(
      f.monitor(),
      swapped.map((window) => ({
        ...window,
        remaining: window.durationMins === null ? 30 : window.remaining,
      })),
    );
    await f.poll(f.monitor(), [short, weekly]);
    const entries = f.entries();
    expect(entries).toHaveLength(2);
    const unchangedLabel = missingDuration === 300 ? "weekly:" : "5h:";
    expect(entries.filter((entry) => entry.item.text.includes(unchangedLabel))).toHaveLength(1);
  }
});

test("existing quota state supplies identities when duration metadata disappears", async () => {
  const f = fixture();
  const path = join(f.state, "codex-quota/monitor.json");
  writeJson(path, {
    version: 1,
    observed: sample(4),
    episodes: { "10080": { resetsAt: reset, alertId: "quota-existing" } },
  });
  await f.poll(f.monitor(), [{ ...sample(4)[0], durationMins: null }]);
  expect(f.entries()).toHaveLength(0);
  await f.poll(f.monitor(), [{ ...sample(30)[0], durationMins: null }]);
  await f.poll(f.monitor(), sample(4));
  expect(f.entries()).toHaveLength(1);
});

test("older reset recovery cannot rearm an unchanged low episode", async () => {
  const f = fixture();
  await f.poll(f.monitor(), sample(4, reset + 86400));
  await f.poll(f.monitor(), sample(30, reset));
  await f.poll(f.monitor(), sample(4, reset + 86400));
  expect(f.entries()).toHaveLength(1);
  await f.poll(f.monitor(), sample(30, reset + 86400));
  await f.poll(f.monitor(), sample(4, reset + 86400));
  expect(f.entries()).toHaveLength(2);
});

test("unknown quota preserves low episode; each main window crosses independently", async () => {
  const f = fixture();
  const m = f.monitor();
  await f.poll(m);
  await f.poll(m, []);
  await f.poll(m, sample(4));
  expect(f.entries()).toHaveLength(1);
  const secondary: QuotaWindow = {
    slot: "secondary",
    remaining: 4,
    durationMins: 300,
    resetsAt: reset,
  };
  await f.poll(m, [secondary]);
  expect(f.entries()).toHaveLength(2);
  // Swapping primary/secondary does not rename a known duration's episode.
  await f.poll(m, [
    { ...sample(3)[0], slot: "secondary" },
    { ...secondary, slot: "primary" },
  ]);
  expect(f.entries()).toHaveLength(2);
  f.fail();
  await f.poll(m);
  expect(
    readJson<{ status: string }>(join(f.state, "codex-quota/monitor.json"), { status: "" }).status,
  ).toBe("unknown");
  expect(readFileSync(join(f.state, "codex-quota/monitor.json"), "utf8")).not.toContain(
    "private upstream",
  );
  expect(f.entries()).toHaveLength(2);
});

test("crash before or after outbox publication replays the same durable alert ID", async () => {
  for (const afterPublish of [false, true]) {
    const f = fixture();
    const m = new CodexQuotaMonitor(
      f.state,
      60000,
      f.read,
      (key, text, id) => {
        if (afterPublish) enqueueOutbox(f.state, key, text, id, true);
        throw new Error("simulated crash");
      },
      () => start,
    );
    await expect(m.tick("bound")).rejects.toThrow("simulated crash");
    const saved = readJson<{ pending: { id: string } } | null>(
      join(f.state, "codex-quota/monitor.json"),
      null,
    );
    await f.poll(f.monitor());
    expect(f.entries().map((entry) => entry.file)).toEqual([`${saved?.pending.id}.json`]);
  }
});

test("cadence, overlap, missing binding and stop never create extra reads", async () => {
  const state = directory();
  let reads = 0;
  let finish: (value: QuotaWindow[]) => void = () => {};
  const m = new CodexQuotaMonitor(
    state,
    60000,
    () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    undefined,
    () => start,
  );
  await m.tick(undefined);
  expect(reads).toBe(0);
  const active = m.tick("bound");
  const overlap = m.tick("bound");
  expect(reads).toBe(1);
  const stopped = m.stop();
  finish(sample());
  await Promise.all([active, overlap, stopped]);
  await m.tick("bound");
  expect(reads).toBe(1);
  expect(readOutbox(state, "bound")).toHaveLength(0);
  const f = fixture();
  const monitor = f.monitor();
  await monitor.tick("bound");
  await monitor.tick("bound");
  expect(f.reads()).toBe(1);
});

function routerFixture(target = "mm:channel:root", mode: "mattermost" | "telegram" = "mattermost") {
  const state = directory();
  const thread = {
    key: "bound",
    channel: "channel",
    root: "root",
    repo: "owner/repo",
    cwd: state,
    status: "idle",
    pending: [],
    done: [],
  };
  writeJson(join(state, "threads/registry.json"), { version: 1, threads: [thread], dismissed: [] });
  const cfg = {
    ...loadConfig(),
    stateDir: state,
    notesDir: join(state, "notes"),
    threadAgents: true,
    channelMode: mode,
    codexQuotaThread: target,
    codexQuotaPollMs: 60000,
    codexBin: "/must-never-run",
  };
  return { state, cfg };
}

test("router uses bound outbox without a model turn; disabled, missing target and Telegram pause", async () => {
  for (const [target, mode, expected] of [
    ["mm:channel:root", "mattermost", 1],
    ["", "mattermost", 0],
    ["mm:channel:other", "mattermost", 0],
    ["mm:channel:root", "telegram", 0],
  ] as const) {
    const f = routerFixture(target, mode);
    let reads = 0;
    const sent: string[] = [];
    const router = new ThreadRouter(
      f.cfg,
      {},
      () => {
        throw new Error("no resident wake");
      },
      async () => {
        throw new Error("no model turn");
      },
      async (thread, text) => {
        expect(thread.root).toBe("root");
        expect(thread.channel).toBe("channel");
        sent.push(text);
      },
      async () => {
        reads++;
        return sample();
      },
    );
    try {
      await router.tick();
      await router.drain();
      expect(reads).toBe(expected);
      expect(sent).toHaveLength(expected);
    } finally {
      await router.stop();
    }
  }
});

test("ambiguous quota send and pre-send crash never retry, survive restart, and allow later replies", async () => {
  const f = routerFixture("");
  enqueueOutbox(f.state, "bound", "quota alert", "quota-test", true);
  let attempts = 0;
  const send = async () => {
    attempts++;
    expect(readOutbox(f.state, "bound")[0]?.item.attemptedAt).toBeNumber();
    throw new Error("server accepted but connection lost");
  };
  const r = new ThreadRouter(f.cfg, {}, () => {}, undefined, send);
  await r.drain();
  await r.drain();
  await r.stop();
  const next = new ThreadRouter(f.cfg, {}, () => {}, undefined, send);
  await next.drain();
  await next.stop();
  expect(attempts).toBe(1);
  expect(readOutbox(f.state, "bound")[0]?.item.sent).not.toBe(true);
  enqueueOutbox(f.state, "bound", "second quota", "quota-before-send", true);
  writeJson(join(f.state, "thread-outbox/bound/quota-before-send.json"), {
    text: "second quota",
    sendOnce: true,
    attemptedAt: start,
  });
  enqueueOutbox(f.state, "bound", "ordinary reply", "ordinary");
  const sent: string[] = [];
  const final = new ThreadRouter(
    f.cfg,
    {},
    () => {},
    undefined,
    async (_thread, text) => {
      sent.push(text);
    },
  );
  await final.drain();
  await final.stop();
  expect(sent).toEqual(["ordinary reply"]);
});

test("quota config is opt-in with bounded 60s default and strict routing syntax", () => {
  expect(parseQuotaThread("")).toBe("");
  expect(parseQuotaThread("mm:channel:root")).toBe("mm:channel:root");
  expect(parseQuotaPollMs("60000")).toBe(60000);
  for (const value of ["root", "mm:channel:../root"])
    expect(() => parseQuotaThread(value)).toThrow();
  for (const value of ["NaN", "0", "9999", "3600001", "10000.5"])
    expect(() => parseQuotaPollMs(value)).toThrow();
});

function stub(mode: string) {
  const dir = directory();
  const path = join(dir, "codex-stub");
  const trace = join(dir, "requests.jsonl");
  writeFileSync(
    path,
    `#!${process.execPath}\n
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
const trace = ${JSON.stringify(trace)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
writeFileSync(trace + '.start', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (mode === 'timeout') setInterval(() => {}, 1000);
else {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const msg = JSON.parse(line);
    appendFileSync(trace, line + '\\n');
    if (msg.method === 'initialize') {
      if (mode === 'oversize') process.stdout.write('x'.repeat(1024 * 1024 + 1));
      else if (mode === 'init-error') send({ id: 1, error: { message: 'private-error' } });
      else send({ id: 1, result: {} });
    } else if (msg.method === 'account/rateLimits/read') {
      send({ method: 'unrelated', params: { secret: 'never-persist' } });
      if (mode === 'error') send({ id: 2, error: { message: 'private-error' } });
      else send({ id: 2, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 86400 } } } });
    }
  }
  writeFileSync(trace + '.eof', 'yes');
}
`,
  );
  chmodSync(path, 0o700);
  return { path, trace, env: { HOME: dir, PATH: "/usr/bin:/bin" } };
}

test("finite app-server handshake only reads quota, discards noise, closes EOF and removes temporary cwd", async () => {
  const f = stub("ok");
  const windows = await readCodexQuota(f.path, f.env, 2000);
  expect(windows[0]?.remaining).toBe(5);
  const requests = readFileSync(f.trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
  expect(readFileSync(`${f.trace}.eof`, "utf8")).toBe("yes");
  const start = JSON.parse(readFileSync(`${f.trace}.start`, "utf8"));
  expect(start.argv).toEqual(["app-server", "--listen", "stdio://"]);
  expect(existsSync(start.cwd)).toBe(false);
});

test("reader errors, output cap, timeout and absent CLI are bounded and sanitize errors", async () => {
  for (const mode of ["error", "init-error", "oversize", "timeout"]) {
    const f = stub(mode);
    const begin = Date.now();
    await expect(readCodexQuota(f.path, f.env, 150)).rejects.toThrow("Codex quota unavailable");
    expect(Date.now() - begin).toBeLessThan(2000);
  }
  await expect(readCodexQuota("/nonexistent-quota-cli", {}, 150)).rejects.toThrow(
    "Codex quota unavailable",
  );
});
