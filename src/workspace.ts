// Cold-start workspace bootstrap. Before launching the agent, make sure it has
// everything it needs to resume-from-disk: a notes dir (seeded on first run), a bin/
// of scripts it can call (human contact + a `foreman` shim), and the state/worktrees
// dirs. Returns env additions (PATH + FOREMAN_HOME) to hand to the agent subprocess.

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

export async function ensureWorkspace(
  cfg: Config,
  home: string,
): Promise<Record<string, string>> {
  await mkdir(cfg.stateDir, { recursive: true });
  await mkdir(cfg.worktreesDir, { recursive: true });

  // Notes: seed from the committed template only on a genuine cold start; never
  // overwrite notes the agent has already written.
  const seed = join(home, "agent-workspace-seed", "notes");
  if (!existsSync(cfg.notesDir) || (await isEmptyDir(cfg.notesDir))) {
    await mkdir(cfg.notesDir, { recursive: true });
    if (existsSync(seed)) await cp(seed, cfg.notesDir, { recursive: true });
  }
  await mkdir(join(cfg.notesDir, "journal"), { recursive: true });
  await mkdir(join(cfg.notesDir, "tasks"), { recursive: true });

  // bin/: seed the reference human-contact scripts (agent may refine them) and a
  // `foreman` shim so the agent can call `foreman run/secret` for credentials.
  const binDir = resolve("bin");
  await mkdir(binDir, { recursive: true });
  const examples = join(home, "examples", "agent-bin");
  for (const src of ["ask-human.sh", "wait-reply.sh"]) {
    const dest = join(binDir, src.replace(/\.sh$/, ""));
    if (!existsSync(dest) && existsSync(join(examples, src))) {
      await cp(join(examples, src), dest);
      await chmod(dest, 0o755);
    }
  }
  const shim = join(binDir, "foreman");
  if (!existsSync(shim)) {
    await writeFile(shim, `#!/usr/bin/env bash\nexec bun run "$FOREMAN_HOME/src/foreman.ts" "$@"\n`, {
      mode: 0o755,
    });
  }

  return {
    FOREMAN_HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
}
