// Finite read-only app-server queries and supervisor-owned quota episode state. No model turns.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueOutbox } from "./thread-outbox.ts";
import { readJson, writeJson } from "./thread-store.ts";

export interface QuotaWindow {
  slot: "primary" | "secondary";
  remaining: number;
  durationMins: number | null;
  resetsAt: number | null;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** An explicit main bucket is required. Never substitute Spark, reserve or an unlabeled bucket. */
export function quotaWindows(result: unknown, now = Date.now()): QuotaWindow[] {
  const response = object(result);
  const byId = response?.["rateLimitsByLimitId"];
  const bucket = object(byId == null ? response?.["rateLimits"] : object(byId)?.["codex"]);
  if (!bucket || (bucket["limitId"] !== "codex" && !(byId && bucket["limitId"] == null))) return [];
  const windows: QuotaWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = object(bucket[slot]);
    const used = window?.["usedPercent"];
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const reset = window?.["resetsAt"];
    // A stale low reading after its reset is not evidence of another low episode.
    if (positive(reset) && reset * 1000 <= now) continue;
    const duration = window?.["windowDurationMins"];
    windows.push({
      slot,
      remaining: 100 - used,
      durationMins: positive(duration) ? duration : null,
      resetsAt: positive(reset) && reset <= 8.64e12 ? reset : null,
    });
  }
  return windows;
}

/** Only these three protocol messages are ever written. Raw responses/stderr are never logged. */
export async function readCodexQuota(
  bin: string,
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<QuotaWindow[]> {
  const cwd = mkdtempSync(join(tmpdir(), "foreman-quota-"));
  const child = spawn(bin, ["app-server", "--listen", "stdio://"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  try {
    return await new Promise<QuotaWindow[]>((resolve, reject) => {
      const fail = () => reject(new Error("Codex quota unavailable"));
      timer = setTimeout(fail, timeoutMs);
      child.once("error", fail);
      child.once("exit", fail);
      child.stdin.on("error", fail);
      let buffer = "";
      let bytes = 0;
      let initialized = false;
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          fail();
          return;
        }
        buffer += chunk;
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message: Record<string, unknown> | undefined;
          try {
            message = object(JSON.parse(line));
          } catch {
            continue;
          }
          // Discard all notifications, server requests and unrelated responses.
          if (!message || message["method"] !== undefined) continue;
          if (!initialized && message["id"] === 1) {
            if (message["error"] || !object(message["result"])) return fail();
            initialized = true;
            send({ method: "initialized", params: {} });
            send({ method: "account/rateLimits/read", id: 2 });
          } else if (initialized && message["id"] === 2) {
            if (message["error"]) return fail();
            resolve(quotaWindows(message["result"]));
          }
        }
      });
      send({
        method: "initialize",
        id: 1,
        params: { clientInfo: { name: "foreman_quota", version: "1" } },
      });
    });
  } finally {
    clearTimeout(timer);
    child.stdout.removeAllListeners("data");
    child.stdout.resume();
    child.stdin.end();
    // EOF normally exits app-server. Only this owned child can be signalled, never a PID scan.
    await Promise.race([exited, Bun.sleep(500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([exited, Bun.sleep(500)]);
    child.stdout.destroy();
    child.stdin.destroy();
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface Episode {
  resetsAt: number | null;
  alertId: string | null;
}
interface QuotaState {
  version: 1;
  checkedAt?: number;
  status?: "ok" | "unknown";
  observed?: QuotaWindow[];
  episodes: Record<string, Episode>;
  pending?: { id: string; key: string; text: string };
}

function describe(window: QuotaWindow): string {
  const duration = window.durationMins;
  const label =
    duration === 10080 ? "weekly" : duration === null ? window.slot : `${duration / 60}h`;
  const reset =
    window.resetsAt === null
      ? "reset time unavailable"
      : `resets ${new Date(window.resetsAt * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
  return `${label}: ${Number(window.remaining.toFixed(2))}% left (${reset})`;
}

/** tick() is called by the sole thread router timer; overlapping/too-frequent reads are skipped. */
export class CodexQuotaMonitor {
  private busy: Promise<void> | undefined;
  private nextCheck = 0;
  private stopped = false;
  private path: string;

  constructor(
    stateDir: string,
    private intervalMs: number,
    private read: () => Promise<QuotaWindow[]>,
    private publish = (key: string, text: string, id: string) =>
      enqueueOutbox(stateDir, key, text, id, true),
    private now = Date.now,
  ) {
    this.path = join(stateDir, "codex-quota/monitor.json");
  }

  tick(key: string | undefined): Promise<void> {
    if (this.stopped || !key || this.busy || this.now() < this.nextCheck)
      return this.busy ?? Promise.resolve();
    this.nextCheck = this.now() + this.intervalMs;
    this.busy = this.check(key).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private async check(key: string): Promise<void> {
    const state = readJson<QuotaState>(this.path, { version: 1, episodes: {} });
    if (state.version !== 1 || !object(state.episodes)) throw new Error("Invalid quota state");
    const publishPending = () => {
      if (!state.pending) return;
      this.publish(state.pending.key, state.pending.text, state.pending.id);
      delete state.pending;
      writeJson(this.path, state);
    };
    publishPending(); // Replay the same immutable delivery ID if publication/checkpoint crashed.
    let windows: QuotaWindow[] = [];
    try {
      windows = await this.read();
    } catch {
      // Auth/network/protocol failures are unknown quota, never zero or a reason to wake a model.
    }
    if (this.stopped) return;
    state.checkedAt = this.now();
    state.status = windows.length ? "ok" : "unknown";
    state.observed = windows;
    const low: QuotaWindow[] = [];
    const id = `quota-${randomUUID()}`;
    for (const window of windows) {
      // Duration, not primary/secondary position, identifies a known allowance window.
      const name = String(window.durationMins ?? window.slot);
      const episode = state.episodes[name] ?? { resetsAt: null, alertId: null };
      if (window.resetsAt !== null) {
        if (episode.resetsAt !== null && window.resetsAt > episode.resetsAt) episode.alertId = null;
        episode.resetsAt = Math.max(episode.resetsAt ?? 0, window.resetsAt);
      }
      if (window.remaining > 5) episode.alertId = null;
      else if (!episode.alertId) {
        episode.alertId = id;
        low.push(window);
      }
      state.episodes[name] = episode;
    }
    if (low.length)
      state.pending = {
        id,
        key,
        text: `Codex quota heads-up — ${low.map(describe).join("; ")}. You may want to use a reset.`,
      };
    writeJson(this.path, state); // Commit episode + pending alert together, before publication.
    publishPending();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.busy;
  }
}
