// Real helper processes with a fake review-loop and local Git repositories. No review agents/API calls.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { receiptPath } from "../src/mattermost.ts";
import { approvalArtifact, enqueueApproval } from "../src/thread-approval.ts";
import { readJson, writeJson } from "../src/thread-store.ts";
import { type RunTurn, repoPolicy, ThreadRouter, type TurnResult } from "../src/threads.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("mock barrier timed out");
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fm-grant-"));
  const cwd = join(dir, "worktree");
  mkdirSync(cwd);
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", cwd, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode) throw new Error("fixture git failed");
    return run.stdout.toString().trim();
  };
  git("init", "-b", "task");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "README"), "approved content\n");
  git("add", "README");
  git("commit", "-m", "approved content");
  const head = git("rev-parse", "HEAD");
  const cfg = {
    ...loadConfig(),
    threadAgents: true,
    channelMode: "mattermost" as const,
    stateDir: join(dir, "state"),
    notesDir: join(dir, "notes"),
    codexBin: "/no-real-codex",
  };
  const resident: string[] = [];
  const calls: { prompt: string; resume?: string; end: (result: TurnResult) => void }[] = [];
  const run: RunTurn = (thread, prompt, session) => {
    const resume = thread.sessionId;
    session(resume ?? "saved-session");
    return new Promise((end) => calls.push({ prompt, ...(resume ? { resume } : {}), end }));
  };
  const routers: ThreadRouter[] = [];
  const children: { exited: Promise<number> }[] = [];
  const router = () => {
    const r = new ThreadRouter(
      cfg,
      {},
      (lines) => resident.push(...lines),
      run,
      async () => {},
    );
    routers.push(r);
    return r;
  };
  cleanup.push(async () => {
    writeFileSync(join(dir, "gate-release"), "release");
    await Promise.all(children.map((child) => child.exited));
    for (const r of routers) await r.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (id: string, text: string, root = "root") => {
    writeJson(receiptPath(cfg.stateDir, "channel", id), {
      id,
      root,
      channel: "channel",
      sender: "human",
      text,
      at: Date.now(),
    });
    return `mm:channel:${id}`;
  };
  const ref = post("root", "Merge this PR after review.");
  const r = router();
  r.command(r.token, ["bind", ref, "owner/repo", cwd]);
  const key = r.snapshot().threads[0]?.key ?? "";
  await r.tick();
  calls[0]?.end({ ok: true });
  await until(() => r.snapshot().threads[0]?.status === "idle");
  const target = "https://github.com/owner/repo/pull/123";
  const id = enqueueApproval(cfg.stateDir, key, {
    source: ref,
    target,
    head,
    actions: ["merge", "undraft"],
  });
  r.collect();
  const gate = join(dir, "review-loop");
  writeFileSync(
    gate,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "gate-calls"))}, "review\\n");
const mode = process.env.GATE_MODE;
if (mode === "hold") {
  writeFileSync(${JSON.stringify(join(dir, "gate-ready"))}, "ready");
  while (!existsSync(${JSON.stringify(join(dir, "gate-release"))})) await Bun.sleep(5);
}
if (mode === "fix") {
  const child = Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "review fix"], {stdout:"ignore",stderr:"ignore"});
  if (child.exitCode) process.exit(5);
}
console.log("review-loop: CLEAN — mock gate completed.");
if (mode === "skipped") console.log("review-loop: skipped");
if (mode === "error") process.exit(5);
`,
  );
  chmodSync(gate, 0o700);
  const cli = (args: string[], mode = "clean", thread = key, worktree = cwd) => {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../src/thread-cli.ts"), ...args],
      {
        cwd: worktree,
        env: {
          HOME: dir,
          PATH: `${dir}:/usr/bin:/bin`,
          FOREMAN_STATE_DIR: cfg.stateDir,
          FOREMAN_THREAD_KEY: thread,
          GATE_MODE: mode,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(child);
    return (async () => ({
      code: await child.exited,
      output: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    }))();
  };
  return { dir, cwd, git, head, cfg, ref, id, key, target, r, router, calls, resident, post, cli };
}

test("verified approval resumes the same agent to review then merge only its PR, consuming task authority", async () => {
  const f = await fixture();
  const grant = ["approval-grant", f.id, f.ref];
  expect((await f.cli(["approval-review", f.id])).code).toBe(1);
  expect(existsSync(join(f.dir, "gate-calls"))).toBe(false);
  expect((await f.cli(grant)).error).toContain("resident control capability required");
  expect(() => f.r.command("worker", grant)).toThrow("resident authorization");
  expect(() => f.r.command(f.r.token, ["approval-grant", f.id, "mm:channel:invented"])).toThrow(
    "not received",
  );
  const other = f.post("other", "merge it", "other");
  expect(() => f.r.command(f.r.token, ["approval-grant", f.id, other])).toThrow("this binding");
  f.r.command(f.r.token, grant);
  f.r.command(f.r.token, grant);
  expect(f.r.snapshot().approvals?.[0]?.grants).toHaveLength(1);
  expect(f.r.snapshot().threads[0]?.pending).toEqual([]);
  expect(repoPolicy(f.cfg.notesDir, "owner/repo").merge).toBe(false);
  await f.r.stop();
  const next = f.router();
  await next.tick();
  expect(f.calls[1]?.resume).toBe("saved-session");
  expect(f.calls[1]?.prompt).toContain("YOU run thread-control approval-review");
  expect(f.calls[1]?.prompt).toContain("Merge this PR after review.");
  const check = (head: string, target = f.target, action = "merge") =>
    f.cli(["approval-check", f.id, target, head, action]);
  expect((await check(f.head)).code).toBe(1);
  expect((await f.cli(["approval-review", f.id], "skipped")).code).toBe(1);
  expect((await f.cli(["approval-review", f.id], "error")).code).toBe(1);
  expect((await check(f.head)).code).toBe(1);
  expect((await f.cli(["approval-review", f.id], "fix")).code).toBe(0);
  const reviewed = f.git("rev-parse", "HEAD");
  expect(reviewed).not.toBe(f.head); // In-scope review fixes stay inside the approved workflow.
  expect((await check(f.head)).code).toBe(1);
  expect((await check(reviewed, "https://github.com/owner/repo/pull/124")).code).toBe(1);
  expect((await check(reviewed, f.target, "deploy")).code).toBe(1);
  writeFileSync(join(f.cwd, "README"), "unreviewed changes\n");
  expect((await check(reviewed)).error).toContain("commit tracked review changes");
  writeFileSync(join(f.cwd, "README"), "approved content\n");
  expect(
    (await f.cli(["approval-check", f.id, f.target, reviewed, "merge"], "clean", "other-thread"))
      .code,
  ).toBe(1);
  expect(
    (await f.cli(["approval-check", f.id, f.target, reviewed, "merge"], "clean", f.key, f.dir))
      .code,
  ).toBe(1);
  expect((await f.cli(["approval-review", f.id])).code).toBe(0);
  expect(readFileSync(join(f.dir, "gate-calls"), "utf8").trim().split("\n")).toHaveLength(3); // Reuse CLEAN on unchanged replay.
  expect((await check(reviewed, f.target, "undraft")).code).toBe(0);
  expect((await check(reviewed)).code).toBe(0);
  // The mock forge action happens only after review and scope checks; no real merge is executed.
  expect(
    (await f.cli(["approval-finish", f.id, reviewed, "Merged PR 123 as mock-merge-commit."])).code,
  ).toBe(0);
  expect((await check(reviewed)).code).toBe(1); // Even before the next supervisor tick.
  f.calls[1]?.end({ ok: true, text: "Merged after CLEAN review." });
  await until(() => next.snapshot().threads[0]?.status === "idle");
  expect(next.snapshot().approvals?.[0]?.resolution).toMatchObject({
    outcome: "completed",
    actor: "worker",
  });
  expect(() => next.command(next.token, grant)).toThrow("already resolved");
  await next.tick();
  expect(f.calls).toHaveLength(2);
  expect(existsSync(join(f.cfg.notesDir, "policy/autonomy.json"))).toBe(false);
});

test("new human receipts suspend active grants before collection and invalidate an in-flight review", async () => {
  const f = await fixture();
  f.r.command(f.r.token, ["approval-grant", f.id, f.ref]);
  const review = f.cli(["approval-review", f.id], "hold");
  await until(() => existsSync(join(f.dir, "gate-ready")));
  await f.r.stop(); // Its review process survives; the review lock still blocks new turns.
  const next = f.router();
  await next.tick();
  expect(f.calls).toHaveLength(1);
  expect(next.command(next.token, ["approval-list"])).toMatchObject([{ workerBusy: true }]);
  expect(() => next.command(next.token, ["approval-grant", f.id, f.ref])).toThrow(
    "worker turn still active",
  );
  f.post("later", "Hold off on merging."); // Poller saved it; supervisor has not collected yet.
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).error).toContain(
    "new human messages suspend",
  );
  writeFileSync(join(f.dir, "gate-release"), "release");
  expect((await review).code).toBe(1);
  next.collect();
  expect(next.command(next.token, ["approval-list"])).toMatchObject([
    { grantCurrent: false, workerBusy: false },
  ]);
  next.command(next.token, ["approval-resolve", f.id, "declined", "Human revoked merge approval."]);
  expect((await f.cli(["approval-review", f.id])).code).toBe(1);
  expect(() => next.command(next.token, ["approval-grant", f.id, f.ref])).toThrow(
    "already resolved",
  );
});

test("regrant needs a new gate and a successful turn cannot silently abandon an authorized workflow", async () => {
  const f = await fixture();
  f.r.command(f.r.token, ["approval-grant", f.id, f.ref]);
  expect((await f.cli(["approval-review", f.id])).code).toBe(0);
  f.git("commit", "--allow-empty", "-m", "change after final review");
  const changedHead = f.git("rev-parse", "HEAD");
  expect((await f.cli(["approval-check", f.id, f.target, changedHead, "merge"])).code).toBe(1);
  f.post("status", "What is the status?");
  // Resident reads the follow-up and verifies that the existing actual approval still applies.
  f.r.command(f.r.token, ["approval-grant", f.id, f.ref]);
  expect(f.r.snapshot().approvals?.[0]?.grants).toHaveLength(2);
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).code).toBe(1);
  await f.r.tick();
  f.calls[1]?.end({ ok: true, text: "Waiting for permission." });
  await until(() => f.r.snapshot().threads[0]?.status === "failed");
  expect(f.resident.at(-1)).toContain("Turn failed");
  const approval = f.r.snapshot().approvals?.[0];
  const grant = approval?.grants?.at(-1);
  if (!approval || !grant) throw new Error("missing grant");
  writeJson(approvalArtifact(f.cfg.stateDir, approval, grant, "result"), {
    head: f.head,
    note: "forged completion",
    at: new Date().toISOString(),
  });
  f.r.collect();
  expect(f.r.snapshot().approvals?.[0]?.resolution).toBeUndefined(); // No CLEAN gate for this generation.
  expect(readJson(join(f.cfg.stateDir, "threads/registry.json"), null)).toEqual(f.r.snapshot());
});

test("failed grant checkpoint exposes no worker authority and retry saves grant plus idle-session wakeup together", async () => {
  const f = await fixture();
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const obstruction = `${path}.${process.pid}.tmp`;
  mkdirSync(obstruction);
  try {
    expect(() => f.r.command(f.r.token, ["approval-grant", f.id, f.ref])).toThrow();
    expect(readJson(path, null)).toEqual(persisted);
    expect((await f.cli(["approval-review", f.id])).code).toBe(1);
    expect(existsSync(join(f.dir, "gate-calls"))).toBe(false);
    await expect(f.r.tick()).rejects.toThrow();
  } finally {
    rmSync(obstruction, { recursive: true });
  }
  await f.r.tick();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]?.resume).toBe("saved-session");
  expect(readJson(path, null)).toEqual(f.r.snapshot());
  f.r.command(f.r.token, ["approval-resolve", f.id, "declined", "Cancel this mock grant."]);
  f.calls[1]?.end({ ok: true });
  await until(() => f.r.snapshot().threads[0]?.status === "queued");
});
