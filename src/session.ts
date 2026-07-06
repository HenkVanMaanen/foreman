// Owns one long-lived `claude -p` subprocess and speaks the stream-json protocol.

import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { type StreamEvent, userMessage } from "./protocol.ts";

export interface StartOptions {
  /** extra env for the subprocess (e.g. channel creds passed through to the agent). */
  env?: Record<string, string>;
}

export class Session {
  private proc: Subprocess<"pipe", "pipe", "inherit"> | undefined;

  constructor(private cfg: Config) {}

  /** Launch the subprocess. Does not send any turn — call send() with the bootstrap. */
  start(opts: StartOptions = {}): void {
    if (this.proc) throw new Error("session already started");

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (this.cfg.skipPermissions) args.push("--dangerously-skip-permissions");
    args.push(...this.cfg.claudeExtraArgs);

    this.proc = Bun.spawn([this.cfg.claudeBin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
  }

  /** Send a user turn to the subprocess. */
  async send(text: string): Promise<void> {
    if (!this.proc) throw new Error("session not started");
    const writer = this.proc.stdin;
    writer.write(`${userMessage(text)}\n`);
    await writer.flush();
  }

  /** Async iterator over stream-json frames until the process exits. */
  async *events(): AsyncGenerator<StreamEvent> {
    if (!this.proc) throw new Error("session not started");
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const ev = this.parse(line);
          if (ev) yield ev;
        }
        nl = buf.indexOf("\n");
      }
    }
  }

  private parse(line: string): StreamEvent | undefined {
    try {
      const obj = JSON.parse(line) as Partial<StreamEvent>;
      return { type: obj.type ?? "system", ...obj, raw: obj } as StreamEvent;
    } catch {
      return undefined; // skip malformed lines
    }
  }

  /** Terminate the subprocess. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill();
    await this.proc.exited;
    this.proc = undefined;
  }
}
