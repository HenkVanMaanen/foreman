import { join } from "node:path";

// Share the read-only status probe with the shell helpers, including legacy registry handling.
// This runs only for workers explicitly named by wait-on; it adds no poller or state mutation.
const probe = join(import.meta.dir, "../examples/agent-bin/worker-state.sh");

export function workerNeedsAttention(stateDir: string, name: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return true;
  try {
    const result = Bun.spawnSync(["bash", probe, stateDir, name], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    });
    if (result.exitCode !== 0) return true;
    const status = result.stdout.toString().trim();
    return status !== "RUNNING" && status !== "STARTING";
  } catch {
    // Wake for investigation if liveness cannot be checked; never sleep forever on missing .done.
    return true;
  }
}
