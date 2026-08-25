// Engine-neutral session facade. Claude uses one bidirectional stream-json child; Codex uses the
// process-per-turn exec/resume adapter in codex-session.ts.

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import { CodexSession } from "./codex-session.ts";
import type { Config } from "./config.ts";
import { interruptMessage, type StreamEvent, userMessage } from "./protocol.ts";

export interface StartOptions {
  /** extra env for the subprocess (e.g. channel creds passed through to the agent). */
  env?: Record<string, string>;
}

class ClaudeSession {
  private proc: Subprocess<"pipe", "pipe", "inherit"> | undefined;
  // Serialise stdin writes. There are now TWO writers: the main loop (send) and the always-on
  // inbox poller (interrupt, from its own async context). A half-written line would corrupt the
  // stream, so every write chains onto the previous one. The chain swallows its own rejections so
  // one failed write (EPIPE on a dead child) does not permanently poison later writes — the
  // failure is still surfaced to the caller that issued it.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private cfg: Config) {}

  /** Launch the subprocess. Does not send any turn — call send() with the bootstrap. */
  start(env: Record<string, string> = {}): void {
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
      env: { ...process.env, ...env },
    });
  }

  /** One serialised stdin write. The chain keeps ordering even if a write rejects. */
  private write(line: string): Promise<void> {
    const run = this.writeChain.then(async () => {
      if (!this.proc) throw new Error("session not started");
      const writer = this.proc.stdin;
      writer.write(line);
      await writer.flush();
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  /** Send a user turn to the subprocess. */
  async send(text: string): Promise<void> {
    await this.write(`${userMessage(text)}\n`);
  }

  /**
   * Interrupt the in-flight turn via the stdin control protocol (see interruptMessage). Returns the
   * request_id so a caller can correlate the `control_response`. The current turn then ends with an
   * `error_during_execution` result frame, at which point the supervisor's turn-boundary path
   * delivers whatever the poller has queued — turning "wait out a 1h turn" into "seconds".
   */
  async interrupt(): Promise<string> {
    const id = randomUUID();
    await this.write(`${interruptMessage(id)}\n`);
    return id;
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

interface SessionDriver {
  start(env?: Record<string, string>): void;
  send(text: string): Promise<void>;
  interrupt(): Promise<string>;
  events(): AsyncGenerator<StreamEvent>;
  stop(): Promise<void>;
}

export class Session {
  private driver: SessionDriver;

  constructor(cfg: Config) {
    this.driver = cfg.sessionEngine === "codex" ? new CodexSession(cfg) : new ClaudeSession(cfg);
  }

  start(opts: StartOptions = {}): void {
    this.driver.start(opts.env ?? {});
  }

  send(text: string): Promise<void> {
    return this.driver.send(text);
  }

  interrupt(): Promise<string> {
    return this.driver.interrupt();
  }

  events(): AsyncGenerator<StreamEvent> {
    return this.driver.events();
  }

  stop(): Promise<void> {
    return this.driver.stop();
  }
}
