// Minimal configuration, read from the environment (see .env.example). Deliberately
// small: the *agent* keeps its own operational config in notes; this is only what the
// harness itself needs.

export interface Config {
  claudeBin: string;
  claudeExtraArgs: string[];
  // Autonomous agents run tools without interactive approval; the human-in-the-loop is
  // ask-human, not per-tool prompts. Adds --dangerously-skip-permissions when true.
  skipPermissions: boolean;
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

export function loadConfig(): Config {
  const stateDir = str("FOREMAN_STATE_DIR", "state");
  return {
    claudeBin: str("FOREMAN_CLAUDE_BIN", "claude"),
    claudeExtraArgs: str("FOREMAN_CLAUDE_EXTRA_ARGS", "").split(" ").filter(Boolean),
    skipPermissions: str("FOREMAN_SKIP_PERMISSIONS", "1") !== "0",
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
