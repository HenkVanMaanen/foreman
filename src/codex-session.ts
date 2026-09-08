// Codex resident-session adapter.
//
// Unlike Claude's bidirectional stream-json process, `codex exec` owns exactly one turn. The
// first turn emits a thread id; every later turn starts a fresh CLI process with
// `codex exec resume <thread-id>`. This class makes that process-per-turn shape look like the
// Session interface the supervisor already consumes.

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import type { StreamEvent } from "./protocol.ts";
import { agentEnv } from "./workspace.ts";

type AgentProcess = Subprocess<"pipe", "pipe", "inherit">;

interface CodexRun {
  proc: AgentProcess;
  terminal: boolean;
  interrupted: boolean;
}

interface CodexUsage {
  input_tokens?: unknown;
}

/** Build one initial or resumed Codex command. Exported so the exact CLI contract is unit-tested. */
export function codexTurnCommand(
  cfg: Pick<Config, "codexBin" | "skipPermissions" | "codexExtraArgs">,
  threadId?: string,
): string[] {
  const args = ["exec"];
  if (threadId) args.push("resume");
  args.push("--json", "--skip-git-repo-check");
  if (cfg.skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push(...cfg.codexExtraArgs);
  if (threadId) args.push(threadId);
  args.push("-"); // the complete prompt is written to stdin, then stdin is closed
  return [cfg.codexBin, ...args];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function failureMessage(raw: Record<string, unknown>): string {
  const error = object(raw["error"]);
  const message = error?.["message"];
  return typeof message === "string" ? message : "Codex turn failed";
}

/** Translate terminal Codex JSONL events into the small protocol the supervisor already uses. */
export function codexStreamEvent(rawValue: unknown): StreamEvent | undefined {
  const raw = object(rawValue);
  if (!raw || typeof raw["type"] !== "string") return undefined;

  if (raw["type"] === "thread.started") {
    return {
      type: "system",
      subtype: "init",
      ...(typeof raw["thread_id"] === "string" ? { session_id: raw["thread_id"] } : {}),
      raw,
    };
  }

  if (raw["type"] === "turn.completed") {
    const usage = object(raw["usage"]) as CodexUsage | undefined;
    // Codex's input_tokens already INCLUDES cached_input_tokens (the latter is a subset). Mapping
    // only the total input count makes the supervisor's result fallback equal context occupancy,
    // instead of double-counting the cached prefix or adding output tokens.
    const input = usage?.input_tokens;
    return {
      type: "result",
      is_error: false,
      ...(typeof input === "number" ? { usage: { input_tokens: input } } : {}),
      raw,
    };
  }

  if (raw["type"] === "turn.failed") {
    return {
      type: "result",
      is_error: true,
      result: failureMessage(raw),
      raw,
    };
  }

  // Progress frames still reach the supervisor so they feed the watchdog. Their original type is
  // intentionally preserved in `raw`; no supervisor policy depends on these unmodelled types.
  return { type: raw["type"], raw } as unknown as StreamEvent;
}

function rawType(value: unknown): string | undefined {
  const raw = object(value);
  return typeof raw?.["type"] === "string" ? raw["type"] : undefined;
}

export class CodexSession {
  exitCode: number | null = null;
  private started = false;
  private stopping = false;
  private childEnv: Record<string, string> = {};
  private threadId: string | undefined;
  private run: CodexRun | undefined;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    private cfg: Config,
    private options: {
      sessionId?: string;
      cwd?: string;
      commandPrefix?: string[];
    } = {},
  ) {
    this.threadId = options.sessionId;
  }

  start(env: Record<string, string> = {}): void {
    if (this.started) throw new Error("session already started");
    this.started = true;
    this.childEnv = env;
  }

  private async launch(text: string): Promise<void> {
    if (!this.started || this.stopping) throw new Error("session not started");

    const previous = this.run;
    if (previous) {
      // Codex consumes stdin to EOF before it starts and offers no mid-turn input channel. The
      // inbox poller treats this error as a safe queue-at-boundary fallback.
      if (!previous.terminal) throw new Error("codex turn already running");
      await previous.proc.exited;
      if (this.run === previous) this.run = undefined;
    }
    if (this.threadId === undefined && previous?.terminal) {
      throw new Error("codex completed a turn without emitting a thread id");
    }

    const proc = Bun.spawn(
      [...(this.options.commandPrefix ?? []), ...codexTurnCommand(this.cfg, this.threadId)],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: agentEnv({ ...process.env, ...this.childEnv }),
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      },
    );
    this.run = { proc, terminal: false, interrupted: false };
    proc.stdin.write(text);
    proc.stdin.end();
  }

  send(text: string): Promise<void> {
    const next = this.sendChain.then(() => this.launch(text));
    this.sendChain = next.catch(() => {});
    return next;
  }

  /** Codex has no control-message channel; SIGINT ends the turn, which is then resumed normally. */
  async interrupt(): Promise<string> {
    const run = this.run;
    if (!run || run.terminal) throw new Error("no codex turn is running");
    // An initial turn cannot be resumed until Codex has emitted thread.started. Refuse the tiny
    // pre-init race so the poller keeps the urgent message queued instead of killing the only
    // process that could tell us which thread to resume.
    if (!this.threadId) throw new Error("codex thread is not resumable yet");
    run.interrupted = true;
    run.proc.kill("SIGINT");
    return randomUUID();
  }

  private consumeLine(line: string, run: CodexRun): StreamEvent | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return undefined;
    }

    const type = rawType(raw);
    const rawObject = object(raw);
    if (type === "thread.started" && typeof rawObject?.["thread_id"] === "string") {
      if (this.threadId && this.threadId !== rawObject["thread_id"]) {
        throw new Error(`codex resumed unexpected thread ${rawObject["thread_id"]}`);
      }
      this.threadId = rawObject["thread_id"];
    }
    if (type === "turn.completed" || type === "turn.failed") run.terminal = true;
    return codexStreamEvent(raw);
  }

  /** Yield one continuous event stream across the short-lived initial/resume processes. */
  async *events(): AsyncGenerator<StreamEvent> {
    if (!this.started || !this.run) throw new Error("session not started");

    for (;;) {
      const run: CodexRun | undefined = this.run;
      if (!run) return;
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of run.proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            const event = this.consumeLine(line, run);
            if (event) yield event;
          }
          nl = buf.indexOf("\n");
        }
      }
      const tail = `${buf}${decoder.decode()}`.trim();
      if (tail) {
        const event = this.consumeLine(tail, run);
        if (event) yield event;
      }
      this.exitCode = await run.proc.exited;

      // SIGINT may close the process without a formal turn.failed frame. Synthesize exactly one
      // failed boundary so the supervisor can deliver the urgent queued message via exec resume.
      if (run.interrupted && !run.terminal && !this.stopping) {
        run.terminal = true;
        const raw = { type: "turn.failed", error: { message: "interrupted by supervisor" } };
        yield { type: "result", is_error: true, result: "interrupted by supervisor", raw };
      }

      // During a terminal-event yield, the supervisor calls send(), waits for this process, and
      // replaces `this.run`. Follow that replacement; otherwise the CLI ended unexpectedly and the
      // session is over, so the outer keeper gets its established clean-respawn path.
      if (this.run === run) {
        this.run = undefined;
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const run = this.run;
    if (!run) return;
    run.proc.kill();
    await run.proc.exited;
    if (this.run === run) this.run = undefined;
  }
}
