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
  notesDir: string;
  stateDir: string;
  worktreesDir: string;
  secretsPassphrase: string;
  bootstrapPromptPath: string;
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
  return {
    claudeBin: str("FOREMAN_CLAUDE_BIN", "claude"),
    claudeExtraArgs: str("FOREMAN_CLAUDE_EXTRA_ARGS", "").split(" ").filter(Boolean),
    skipPermissions: str("FOREMAN_SKIP_PERMISSIONS", "1") !== "0",
    contextWindow: num("FOREMAN_CONTEXT_WINDOW", 200_000),
    softMark: num("FOREMAN_SOFT_MARK", 0.6),
    hardMark: num("FOREMAN_HARD_MARK", 0.8),
    notesDir: str("FOREMAN_NOTES_DIR", "notes"),
    stateDir: str("FOREMAN_STATE_DIR", "state"),
    worktreesDir: str("FOREMAN_WORKTREES_DIR", "worktrees"),
    secretsPassphrase: str("FOREMAN_SECRETS_PASSPHRASE", ""),
    bootstrapPromptPath: str("FOREMAN_BOOTSTRAP_PROMPT", "prompts/bootstrap.md"),
  };
}
