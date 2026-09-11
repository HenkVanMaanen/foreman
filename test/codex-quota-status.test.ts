import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexQuotaMonitor,
  type QuotaWindow,
  quotaStatusText,
  quotaWindows,
} from "../src/codex-quota.ts";
import { loadConfig } from "../src/config.ts";
import { Mattermost } from "../src/mattermost.ts";
import { readOutbox } from "../src/thread-outbox.ts";
import { ThreadRouter } from "../src/threads.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "fm-quota-status-"));
  dirs.push(dir);
  return dir;
}
const start = 1_800_000_000_000;
const windows: [QuotaWindow, QuotaWindow] = [
  { slot: "primary", remaining: 82, durationMins: 300, resetsAt: null },
  { slot: "secondary", remaining: 64, durationMins: 10080, resetsAt: null },
];

test("short status shows remaining main quota, ordered by duration, without Spark", () => {
  const quota = quotaWindows({
    rateLimits: { limitId: "codex_spark", primary: { usedPercent: 100 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 36, windowDurationMins: 10080 },
        secondary: { usedPercent: 18, windowDurationMins: 300 },
      },
      codex_spark: { primary: { usedPercent: 100 } },
    },
  });
  expect(quotaStatusText(quota)).toBe("Codex 5h 82% · 7d 64% left");
  expect(quotaStatusText([])).toBe("Codex ?");
  expect(
    quotaStatusText([{ slot: "primary", remaining: 0, durationMins: null, resetsAt: null }]),
  ).toBe("Codex primary 0% left");
  expect(
    quotaStatusText([{ slot: "secondary", remaining: 99.9, durationMins: 30, resetsAt: null }]),
  ).toBe("Codex 30m 99% left");
  expect(
    quotaStatusText(
      quotaWindows({ rateLimits: { limitId: "codex_spark", primary: { usedPercent: 10 } } }),
    ),
  ).toBe("Codex ?");
});

test("status refreshes immediately and every five minutes without a bound alert thread", async () => {
  const state = directory();
  let now = start;
  let reads = 0;
  const statuses: { text: string; expiresAt: string }[] = [];
  const monitor = new CodexQuotaMonitor(
    state,
    60000,
    async () => {
      reads++;
      return windows;
    },
    undefined,
    () => now,
    async (text, expiresAt) => {
      statuses.push({ text, expiresAt });
    },
  );
  await monitor.tick(undefined);
  expect(statuses).toEqual([
    {
      text: "Codex 5h 82% · 7d 64% left",
      expiresAt: new Date(start + 360000).toISOString(),
    },
  ]);
  now += 299999;
  await monitor.tick(undefined);
  expect(reads).toBe(1);
  now++;
  await monitor.tick(undefined);
  expect(reads).toBe(2);
  expect(statuses).toHaveLength(2);
  expect(statuses[1]?.expiresAt).toBe(new Date(now + 360000).toISOString());
  expect(existsSync(join(state, "codex-quota/monitor.json"))).toBe(false);
  await monitor.stop();
  now += 300000;
  await monitor.tick(undefined);
  expect(reads).toBe(2);
});

test("status shares due reads with alerts while retaining each cadence", async () => {
  for (const interval of [60000, 3600000]) {
    const state = directory();
    let now = start;
    let reads = 0;
    const statuses: string[] = [];
    const monitor = new CodexQuotaMonitor(
      state,
      interval,
      async () => {
        reads++;
        return [{ ...windows[0], remaining: 4 }];
      },
      undefined,
      () => now,
      async (text) => {
        statuses.push(text);
      },
    );
    for (let minute = 0; minute <= 5; minute++) {
      now = start + minute * 60000;
      await monitor.tick("bound");
    }
    expect(reads).toBe(interval === 60000 ? 6 : 2);
    expect(statuses).toEqual(["Codex 5h 4% left", "Codex 5h 4% left"]);
    expect(readOutbox(state, "bound")).toHaveLength(1);
    await monitor.stop();
  }
});

test("unknown readings replace old percentages and HTTP failures retry without blocking alerts", async () => {
  const state = directory();
  let now = start;
  let readFails = false;
  let statusFails = true;
  const statuses: string[] = [];
  const log = spyOn(console, "error").mockImplementation(() => {});
  const monitor = new CodexQuotaMonitor(
    state,
    60000,
    async () => {
      if (readFails) throw new Error("private quota response");
      return [{ ...windows[0], remaining: 4 }];
    },
    undefined,
    () => now,
    async (text) => {
      statuses.push(text);
      if (statusFails) throw new Error("private HTTP response");
    },
  );
  try {
    await monitor.tick("bound");
    expect(readOutbox(state, "bound")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("[quota] status update failed; retry in five minutes");
    statusFails = false;
    readFails = true;
    now += 300000;
    await monitor.tick("bound");
    readFails = false;
    now += 300000;
    await monitor.tick("bound");
    expect(statuses).toEqual(["Codex 5h 4% left", "Codex ?", "Codex 5h 4% left"]);
    expect(readOutbox(state, "bound")).toHaveLength(1);
  } finally {
    await monitor.stop();
    log.mockRestore();
  }
});

test("overlapping status ticks share one read and shutdown suppresses late writes", async () => {
  let finish: (value: QuotaWindow[]) => void = () => {};
  let reads = 0;
  let writes = 0;
  let now = start;
  const monitor = new CodexQuotaMonitor(
    directory(),
    60000,
    () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    undefined,
    () => now,
    async () => {
      writes++;
    },
  );
  const first = monitor.tick(undefined);
  now += 300000;
  const overlap = monitor.tick(undefined);
  expect(reads).toBe(1);
  const stopped = monitor.stop();
  finish(windows);
  await Promise.all([first, overlap, stopped]);
  expect(writes).toBe(0);
});

test("Mattermost uses the bot's custom status endpoint with PUT and expiring JSON", async () => {
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  let fails = false;
  const mm = new Mattermost(
    { MATTERMOST_BASE_URL: "https://mock.invalid/", MATTERMOST_BOT_TOKEN: "fake" },
    (async (input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fake");
      expect(init?.signal).toBeDefined();
      requests.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return fails
        ? new Response("private error", { status: 503 })
        : Response.json({ status: "OK" });
    }) as typeof fetch,
  );
  const expiresAt = new Date(start + 360000).toISOString();
  await mm.setCustomStatus("Codex 5h 82% · 7d 64% left", expiresAt);
  expect(requests).toEqual([
    {
      url: "https://mock.invalid/api/v4/users/me/status/custom",
      method: "PUT",
      body: {
        emoji: "battery",
        text: "Codex 5h 82% · 7d 64% left",
        duration: "date_and_time",
        expires_at: expiresAt,
      },
    },
  ]);
  fails = true;
  await expect(mm.setCustomStatus("Codex ?", expiresAt)).rejects.toThrow("Mattermost HTTP 503");
});

test("router status needs configured Mattermost and thread agents, but no alert binding or model turn", async () => {
  for (const mode of ["mattermost", "auto", "telegram"] as const) {
    for (const enabled of [true, false]) {
      for (const configured of [true, false]) {
        for (const threadAgents of [true, false]) {
          const state = directory();
          let reads = 0;
          const statuses: string[] = [];
          let delivered: () => void = () => {};
          const delivery = new Promise<void>((resolve) => {
            delivered = resolve;
          });
          const router = new ThreadRouter(
            {
              ...loadConfig(),
              stateDir: state,
              notesDir: join(state, "notes"),
              channelMode: mode,
              threadAgents,
              codexQuotaStatus: enabled,
              codexQuotaThread: "",
            },
            {
              MATTERMOST_BASE_URL: configured ? "https://mock.invalid" : "",
              MATTERMOST_BOT_TOKEN: configured ? "fake" : "",
            },
            () => {
              throw new Error("no resident wake");
            },
            async () => {
              throw new Error("no model turn");
            },
            async () => {
              throw new Error("no chat post");
            },
            async () => {
              reads++;
              return windows;
            },
            async (text) => {
              statuses.push(text);
              delivered();
            },
          );
          try {
            await router.tick();
            const expected = mode !== "telegram" && enabled && configured && threadAgents;
            expect(reads).toBe(expected ? 1 : 0);
            if (expected) await delivery;
            expect(statuses).toEqual(expected ? ["Codex 5h 82% · 7d 64% left"] : []);
          } finally {
            await router.stop();
          }
        }
      }
    }
  }
});
