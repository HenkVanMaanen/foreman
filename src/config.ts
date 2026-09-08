// Minimal configuration, read from the environment (see .env.example). Deliberately
// small: the *agent* keeps its own operational config in notes; this is only what the
// harness itself needs.

export interface Config {
  channelMode: "auto" | "mattermost" | "telegram";
  threadAgents: boolean;
  maxThreadAgents: number;
  // CLI that owns the resident foreman conversation. Claude keeps one streaming process alive;
  // Codex runs one `exec --json` process per turn and resumes the emitted thread id.
  sessionEngine: "claude" | "codex";
  claudeBin: string;
  claudeExtraArgs: string[];
  // codex CLI, used by both the resident session and the codex re-login relay.
  codexBin: string;
  codexExtraArgs: string[];
  // Which CLI's auth failure the supervisor detects and recovers. Kept independently selectable so
  // the recovery flow can still be rehearsed against a mock without changing the session engine.
  reloginEngine: "claude" | "codex";
  // When the selected CLI's OAuth dies the model can't ask for help, so the supervisor relays the
  // sign-in over the human channel itself. 0 disables (the loop exits for the keeper).
  reloginEnabled: boolean;
  // Test seam: report the first stream frame of the run as an auth failure, so the whole relay
  // can be rehearsed end to end without logging anyone out. One-shot per run.
  fakeAuthRequired: boolean;
  // Autonomous agents run tools without interactive approval; the human-in-the-loop is
  // ask-human, not per-tool prompts. Adds --dangerously-skip-permissions when true.
  skipPermissions: boolean;
  // When a human sends an URGENT message mid-turn (a leading !/​/now/​/interrupt token, or a
  // follow-up while the agent is already known busy), interrupt the in-flight turn (Claude control
  // frame or Codex SIGINT + resume) so it is handled in seconds instead of after the whole turn.
  // Set FOREMAN_URGENT_INTERRUPT=0 to fall back to queue-and-deliver-at-boundary only.
  urgentInterrupt: boolean;
  // EXPERIMENTAL, default off. Stream a NON-urgent mid-turn message to the agent's stdin
  // immediately instead of only delivering it at the turn boundary. Claude can queue this input;
  // Codex cannot accept input after stdin EOF, so its adapter rejects the send and the poller safely
  // leaves the line queued for the boundary. Set FOREMAN_STREAM_INJECT=1 to try it.
  streamInject: boolean;
  contextWindow: number;
  softMark: number; // fraction of window → nudge to checkpoint
  hardMark: number; // fraction of window → force checkpoint + restart
  // Watchdog: force-exit (so keeper respawns) if the supervisor makes no progress for this
  // long. Must exceed the longest legitimate quiet gap — the agent parking on a foreground
  // wait-reply or a long tool call (both capped near 600s) — so the default leaves generous
  // margin; 0 disables. checkMs is how often the stall test runs.
  watchdogTimeoutMs: number;
  watchdogCheckMs: number;
  notesDir: string;
  // Git remote for the agent's durable notes (the foreman-state repo). When set, the
  // harness clones it into notesDir on cold start and pulls on restart; the agent pushes
  // via `notes-sync`. Empty = notes are local-only.
  stateRepo: string;
  stateDir: string;
  worktreesDir: string;
  // Secret store (age). The private identity decrypts; the harness generates one at this
  // path on cold start if absent. ageRecipient (public key) is optional — if empty it is
  // derived from the identity, so capture stays non-interactive.
  ageIdentityFile: string;
  ageRecipient: string;
  bootstrapPromptPath: string;
  // Read-only observability dashboard (bound to 127.0.0.1).
  dashboardPort: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Fail closed on a typo: an unknown engine must never silently fall back to the wrong account. */
export function parseReloginEngine(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`unknown FOREMAN_RELOGIN_ENGINE '${value}' (expected: claude|codex)`);
}

/** The resident-session selector has the same fail-closed posture as the recovery selector. */
export function parseSessionEngine(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`unknown FOREMAN_SESSION_ENGINE '${value}' (expected: claude|codex)`);
}

export function loadConfig(): Config {
  const stateDir = str("FOREMAN_STATE_DIR", "state");
  const sessionEngine = parseSessionEngine(str("FOREMAN_SESSION_ENGINE", "claude"));
  return {
    channelMode: parseChannelMode(str("FOREMAN_CHANNEL_MODE", "auto")),
    threadAgents: str("FOREMAN_THREAD_AGENTS", "0") === "1",
    maxThreadAgents: parseThreadCap(str("FOREMAN_MAX_THREAD_AGENTS", "2")),
    sessionEngine,
    claudeBin: str("FOREMAN_CLAUDE_BIN", "claude"),
    claudeExtraArgs: str("FOREMAN_CLAUDE_EXTRA_ARGS", "").split(" ").filter(Boolean),
    codexBin: str("FOREMAN_CODEX_BIN", "codex"),
    codexExtraArgs: str(
      "FOREMAN_CODEX_EXTRA_ARGS",
      "--model gpt-6-astra -c model_reasoning_effort=xhigh",
    )
      .split(" ")
      .filter(Boolean),
    reloginEngine: parseReloginEngine(str("FOREMAN_RELOGIN_ENGINE", sessionEngine)),
    reloginEnabled: str("FOREMAN_RELOGIN", "1") !== "0",
    fakeAuthRequired: str("FOREMAN_FAKE_AUTH_REQUIRED", "0") === "1",
    skipPermissions: str("FOREMAN_SKIP_PERMISSIONS", "1") !== "0",
    urgentInterrupt: str("FOREMAN_URGENT_INTERRUPT", "1") !== "0",
    streamInject: str("FOREMAN_STREAM_INJECT", "0") === "1",
    contextWindow: num("FOREMAN_CONTEXT_WINDOW", 200_000),
    softMark: num("FOREMAN_SOFT_MARK", 0.6),
    hardMark: num("FOREMAN_HARD_MARK", 0.8),
    watchdogTimeoutMs: num("FOREMAN_WATCHDOG_TIMEOUT_MS", 1_200_000), // 20 min; 0 disables
    watchdogCheckMs: num("FOREMAN_WATCHDOG_CHECK_MS", 30_000),
    notesDir: str("FOREMAN_NOTES_DIR", "notes"),
    stateRepo: str("FOREMAN_STATE_REPO", ""),
    stateDir,
    worktreesDir: str("FOREMAN_WORKTREES_DIR", "worktrees"),
    ageIdentityFile: str("FOREMAN_AGE_IDENTITY", `${stateDir}/age-identity.txt`),
    ageRecipient: str("FOREMAN_AGE_RECIPIENT", ""),
    bootstrapPromptPath: str("FOREMAN_BOOTSTRAP_PROMPT", "prompts/bootstrap.md"),
    dashboardPort: num("FOREMAN_DASHBOARD_PORT", 7878),
  };
}

export function parseChannelMode(value: string): Config["channelMode"] {
  if (value === "auto" || value === "mattermost" || value === "telegram") return value;
  throw new Error("FOREMAN_CHANNEL_MODE must be auto|mattermost|telegram");
}

export function parseThreadCap(value: string): number {
  const cap = Number(value);
  if (Number.isSafeInteger(cap) && cap >= 1) return cap;
  throw new Error("FOREMAN_MAX_THREAD_AGENTS must be a positive safe integer");
}
