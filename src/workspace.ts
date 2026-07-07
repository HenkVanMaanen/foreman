// Cold-start workspace bootstrap. Before launching the agent, make sure it has
// everything it needs to resume-from-disk: a notes dir (cloned from the foreman-state
// repo when configured, else seeded from the template), a bin/ of scripts it can call
// (human contact, secrets, and git sync), and the state/worktrees dirs. Returns env
// additions (PATH, FOREMAN_HOME, FOREMAN_NOTES_DIR) to hand to the agent subprocess.

import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return true;
  }
}

/** Run git synchronously; returns {ok, stdout}. Never throws on non-zero exit. */
function git(args: string[]): { ok: boolean; stdout: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString() };
}

// Reference scripts the agent adopts (and may refine). Seeded into bin/ on cold start.
const BIN_SCRIPTS = ["ask-human", "wait-reply", "notes-sync", "harness-sync"] as const;

export async function ensureWorkspace(cfg: Config, home: string): Promise<Record<string, string>> {
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
      git(["clone", cfg.stateRepo, notes]); // empty repo → empty tree; template seeded below
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
  if (!existsSync(notes) || (await isEmptyDir(notes))) {
    await mkdir(notes, { recursive: true });
  }
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
    if (!existsSync(dest) && existsSync(src)) {
      await cp(src, dest);
      await chmod(dest, 0o755);
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

/** Commit + push the agent's notes to foreman-state. Harness safety net (e.g. on recycle). */
export function syncNotes(cfg: Config, reason: string): void {
  if (!cfg.stateRepo) return;
  const notes = resolve(cfg.notesDir);
  if (!existsSync(join(notes, ".git"))) return;
  git(["-C", notes, "add", "-A"]);
  if (git(["-C", notes, "diff", "--cached", "--quiet"]).ok) return; // nothing staged
  git(["-C", notes, "commit", "-q", "-m", `notes: ${reason}`]);
  git(["-C", notes, "branch", "-M", "main"]);
  git(["-C", notes, "push", "-q", "-u", "origin", "main"]);
}
