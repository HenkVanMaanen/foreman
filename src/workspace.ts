// Cold-start workspace bootstrap. Before launching the agent, make sure it has
// everything it needs to resume-from-disk: a notes dir (cloned from the foreman-state
// repo when configured, else seeded from the template), a bin/ of scripts it can call
// (human contact, secrets, and git sync), and the state/worktrees dirs. Returns env
// additions (PATH, FOREMAN_HOME, FOREMAN_NOTES_DIR) to hand to the agent subprocess.

import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";

/** Run git synchronously; returns {ok, stdout}. Never throws on non-zero exit. */
function git(args: string[]): { ok: boolean; stdout: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString() };
}

// Reference scripts the agent adopts (and may refine). Seeded into bin/ on cold start.
const BIN_SCRIPTS = [
  "ask-human",
  "wait-reply",
  "reply",
  "notes-sync",
  "harness-sync",
  "park",
  "wait-on",
  "spawn-worker",
  "worker-status",
  "worker-list",
  "worker-stop",
  "pipeline-wait",
  "review-loop",
  "second-opinion",
  "thread-control",
  "thread-reply",
] as const;

/**
 * Absolute path to one of the agent's bin/ scripts, resolved the SAME way ensureWorkspace()
 * seeds it (relative to the harness cwd). Absolute so callers never depend on the child env's
 * PATH resolution; a missing file makes Bun.spawn throw rather than silently pick another one.
 * Restricted to BIN_SCRIPTS so a typo (or a script dropped from the list) is a compile error
 * rather than an ENOENT swallowed by a caller's try/catch.
 *
 * Resolved per call, not once at import: freezing it at module-load time would bind every path
 * to whatever cwd happened to be current when the first import ran.
 */
export function binPath(name: (typeof BIN_SCRIPTS)[number]): string {
  return join(resolve("bin"), name);
}

/**
 * Env for a harness-spawned bin/ script. Pins FOREMAN_STATE_DIR from config so the child
 * reads/advances the SAME watermarks and secret store the agent used; without it a child could
 * fall back to $HOME/.foreman and drain a different inbox offset.
 *
 * `extra` is folded in here rather than spread over the result by the caller: this copies the
 * whole process env, and a caller that only wants one more variable should not pay for a second
 * copy of it. It cannot override FOREMAN_STATE_DIR — that pin is the point of the helper.
 */
export function harnessChildEnv(
  cfg: Config,
  env: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...env,
    ...extra,
    FOREMAN_STATE_DIR: resolve(cfg.stateDir),
    FOREMAN_CHANNEL_MODE: cfg.channelMode,
    FOREMAN_THREAD_AGENTS: cfg.threadAgents ? "1" : "0",
  };
}

/** Credential hygiene, not hostile-worker isolation. Keep the resident's control capability only. */
export function agentEnv(
  env: Record<string, string | undefined>,
  resident = true,
): Record<string, string> {
  const result: Record<string, string> = {};
  const thread = Boolean(env["FOREMAN_THREAD_KEY"]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((thread || env["FOREMAN_THREAD_AGENTS"] === "1") && /^(MATTERMOST_|TELEGRAM_)/.test(key))
      continue;
    if ((!resident || thread) && /^FOREMAN_ROUTER_/.test(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * The harness root (the checkout holding examples/). Derived once here rather than passed in by
 * each caller: the invariant used to have to be restated, and restated correctly, at every call
 * site.
 */
const home = resolve(import.meta.dir, "..");

export async function ensureWorkspace(cfg: Config): Promise<Record<string, string>> {
  await mkdir(cfg.stateDir, { recursive: true });
  await mkdir(cfg.worktreesDir, { recursive: true });

  // Secret store root of trust: an age identity. Generate one on cold start if absent so a
  // fresh box self-provisions (secrets are re-captured from a human, so a new key is fine).
  const ageIdentity = resolve(cfg.ageIdentityFile);
  if (!cfg.ageRecipient && !existsSync(ageIdentity)) {
    // Bun.spawnSync THROWS (ENOENT) when the binary is absent rather than returning a
    // non-zero exit, so wrap the whole call: on a box without `age` installed (e.g. CI),
    // cold-start must degrade gracefully — the identity is re-provisioned when a secret is
    // first captured — not crash the supervisor before the agent ever launches.
    try {
      const r = Bun.spawnSync(["age-keygen", "-o", ageIdentity], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode === 0) await chmod(ageIdentity, 0o600);
      else console.log(`[workspace] age-keygen failed: ${r.stderr.toString().trim()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[workspace] age-keygen unavailable, skipping identity: ${msg}`);
    }
  }

  const notes = resolve(cfg.notesDir);

  // Notes: prefer the durable foreman-state repo (clone on cold start, pull on restart) so
  // memory survives crashes and a fresh machine resumes prior state. Fall back to the
  // committed template when no state repo is configured (or the state repo is empty).
  if (cfg.stateRepo) {
    if (!existsSync(join(notes, ".git"))) {
      // `--` stops a stateRepo value starting with `-` from being parsed as a git option
      // (argument-injection hardening; source is trusted operator env, so risk is low).
      git(["clone", "--", cfg.stateRepo, notes]); // empty repo → empty tree; template seeded below
      if (!existsSync(notes)) await mkdir(notes, { recursive: true });
      if (!git(["-C", notes, "remote"]).stdout.includes("origin")) {
        git(["-C", notes, "init"]);
        git(["-C", notes, "remote", "add", "origin", cfg.stateRepo]);
      }
    } else {
      git(["-C", notes, "pull", "--ff-only"]); // best-effort resume of latest memory
    }
    git(["-C", notes, "config", "user.email", "foreman@localhost"]);
    git(["-C", notes, "config", "user.name", "foreman"]);
  }

  const seed = join(home, "agent-workspace-seed", "notes");
  await mkdir(notes, { recursive: true }); // idempotent — ensure the notes tree exists
  if (!existsSync(join(notes, "INDEX.md")) && existsSync(seed)) {
    await cp(seed, notes, { recursive: true }); // seed template into a fresh notes tree
  }
  await mkdir(join(notes, "journal"), { recursive: true });
  await mkdir(join(notes, "tasks"), { recursive: true });

  // bin/: seed the reference scripts (agent may refine them) executable.
  const binDir = resolve("bin");
  await mkdir(binDir, { recursive: true });
  const examples = join(home, "examples", "agent-bin");
  for (const name of BIN_SCRIPTS) {
    const dest = join(binDir, name);
    const src = join(examples, `${name}.sh`);
    if (!existsSync(src)) continue;
    // Seed bin/ as SYMLINKS into the tracked reference scripts, not copies, so a `git pull` that
    // updates examples/agent-bin propagates to the agent's bin/ automatically on the next launch
    // (the old copy-once behaviour meant merged script fixes never reached a running box). But NEVER
    // clobber a regular file at dest: that is a deliberate local override — an agent-refined script,
    // or a test's mock — and the whole self-modification model depends on it surviving. So: seed a
    // symlink only when dest is MISSING, and refresh an existing symlink if it points elsewhere; a
    // real file is left untouched. (A one-time `ln -sf` migrates already-copied boxes at deploy.)
    let info: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      info = await lstat(dest);
    } catch {
      info = null; // dest missing
    }
    if (info === null) {
      await symlink(src, dest);
    } else if (info.isSymbolicLink() && (await readlink(dest)) !== src) {
      await rm(dest, { force: true });
      await symlink(src, dest);
    }
  }
  const shim = join(binDir, "foreman");
  if (!existsSync(shim)) {
    await writeFile(
      shim,
      `#!/usr/bin/env bash\nexec bun run "$FOREMAN_HOME/src/foreman.ts" "$@"\n`,
      {
        mode: 0o755,
      },
    );
  }

  return {
    FOREMAN_HOME: home,
    FOREMAN_NOTES_DIR: notes,
    FOREMAN_STATE_REPO: cfg.stateRepo,
    // Absolute so the agent's `foreman run --secret` resolves the same store from any cwd
    // (e.g. inside a worktree), not a `state/` relative to wherever it was invoked.
    FOREMAN_STATE_DIR: resolve(cfg.stateDir),
    FOREMAN_AGE_IDENTITY: ageIdentity,
    PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
  };
}

/**
 * Commit + push the agent's notes to foreman-state. Harness safety net (e.g. on recycle).
 *
 * NEVER throws — same convention as recordEvent()/writeStatus(): every call site is a
 * best-effort checkpoint on a path (recycle, auth-required) that must proceed whether or not
 * the push lands, so swallowing here saves each of them restating the identical try/catch.
 */
export function syncNotes(cfg: Config, reason: string): void {
  try {
    if (!cfg.stateRepo) return;
    const notes = resolve(cfg.notesDir);
    if (!existsSync(join(notes, ".git"))) return;
    git(["-C", notes, "add", "-A"]);
    if (git(["-C", notes, "diff", "--cached", "--quiet"]).ok) return; // nothing staged
    git(["-C", notes, "commit", "-q", "-m", `notes: ${reason}`]);
    git(["-C", notes, "branch", "-M", "main"]);
    git(["-C", notes, "push", "-q", "-u", "origin", "main"]);
  } catch (e) {
    console.log(`[workspace] notes sync failed (${reason}): ${e}`);
  }
}
