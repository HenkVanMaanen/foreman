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
import { readOutbox } from "../src/thread-outbox.ts";
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

function grantCommand(router: ThreadRouter, id: string, ref: string): string[] {
  const approval = router.command(router.token, ["approval-read", id]) as {
    id: string;
    receipts: string[];
  };
  return ["approval-grant", id, ref, JSON.stringify(approval.receipts)];
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
    codexQuotaStatus: false,
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
writeFileSync(${JSON.stringify(join(dir, "gate-args"))}, JSON.stringify(process.argv.slice(2)));
const mode = process.env.GATE_MODE;
if (mode === "hold") {
  writeFileSync(${JSON.stringify(join(dir, "gate-ready"))}, "ready");
  while (!existsSync(${JSON.stringify(join(dir, "gate-release"))})) await Bun.sleep(5);
}
if (mode === "fix") {
  const child = Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "review fix"], {stdout:"ignore",stderr:"ignore"});
  if (child.exitCode) process.exit(5);
}
if (mode === "verbose") console.log("detail ".repeat(20000));
console.log("review-loop: CLEAN — mock gate completed.");
if (mode === "skipped") console.log("review-loop: skipped");
if (mode === "error") process.exit(5);
`,
  );
  chmodSync(gate, 0o700);
  const cli = async (args: string[], mode = "clean", thread = key, worktree = cwd) => {
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
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  };
  return { dir, cwd, git, head, cfg, ref, id, key, target, r, router, calls, resident, post, cli };
}

test("approval summaries omit receipt bodies and resolved history; explicit reads retain all receipts", async () => {
  const f = await fixture();
  const before = f.r.command(f.r.token, ["approval-list"]) as { receiptVersion: string }[];
  f.post("later", `Hold off. ${"private receipt body ".repeat(3000)}`);
  const summaries = f.r.command(f.r.token, ["approval-list"]) as { receiptVersion: string }[];
  const serialized = JSON.stringify(summaries);
  expect(serialized.length).toBeLessThan(2000);
  expect(serialized).not.toContain("private receipt body");
  expect(summaries[0]?.receiptVersion).not.toBe(before[0]?.receiptVersion);
  const full = f.r.command(f.r.token, ["approval-read", f.id]) as {
    receipts: string[];
    messages: { text: string }[];
  };
  expect(full.receipts).toContain("later");
  expect(full.messages.some((m) => m.text.startsWith("Hold off."))).toBe(true);
  f.r.command(f.r.token, ["approval-resolve", f.id, "declined", "Human asked to hold off."]);
  expect(f.r.command(f.r.token, ["approval-list"])).toEqual([]);
  expect(f.r.command(f.r.token, ["approval-read", f.id])).toMatchObject({
    resolution: { outcome: "declined" },
  });
  expect(() => f.r.command("worker", ["approval-read", f.id])).toThrow("resident authorization");
});

test("large gate output is saved completely while the returned view remains bounded and CLEAN is checked", async () => {
  const f = await fixture();
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
  const result = await f.cli(["approval-review", f.id], "verbose");
  expect(result.code).toBe(0);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(10_100);
  expect(result.output).toContain("Full review output:");
  expect(result.output).toContain("review-loop: CLEAN");
  const log = /Full review output: ([^;\]]+)/.exec(result.output)?.[1];
  expect(log).toBeDefined();
  expect(readFileSync(log ?? "", "utf8").length).toBeGreaterThan(140_000);
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).code).toBe(0);
});

test.each([
  { ignoreTerm: false, shell: false },
  { ignoreTerm: true, shell: false },
  { ignoreTerm: false, shell: true },
  { ignoreTerm: true, shell: true },
])("capture failure stops the review group and keeps the gate closed (%j)", async ({
  ignoreTerm,
  shell,
}) => {
  const f = await fixture();
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
  const reviewerPid = join(f.dir, "reviewer.pid");
  const reviewer = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { ${ignoreTerm ? "" : "process.exit(0);"} });
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(reviewerPid)}, String(process.pid));
process.stdout.write("capture this");
`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(f.dir, "review-loop"),
    shell
      ? `#!/bin/sh\n${quote(process.execPath)} --no-env-file -e ${quote(reviewer)} &\nwait\n`
      : `#!${process.execPath}\n${reviewer}`,
  );
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const spawn = Bun.spawn;
    const write = fs.writeFileSync;
    const close = fs.closeSync;
    const kill = process.kill.bind(process);
    const captureError = new Error("ENOSPC: no space left on device");
    let command;
    let reaped = false;
    let reapedAtClose = false;
    let closed = false;
    let timedOut = false;
    let originalError = false;
    let reviewerRunningAtClose = true;
    let reviewerRunningAtFailure = true;
    const signals = [];
    const reviewerRunning = () => {
      const pid = fs.readFileSync(${JSON.stringify(reviewerPid)}, "utf8");
      const stat = Bun.spawnSync(["/usr/bin/ps", "-p", pid, "-o", "stat="]).stdout.toString().trim();
      return stat !== "" && !/^[ZX]/.test(stat);
    };
    const stop = () => {
      if (command) {
        try { kill(-command.pid, "SIGKILL"); } catch {}
        command.kill("SIGKILL");
      }
      if (fs.existsSync(${JSON.stringify(reviewerPid)})) {
        try { kill(Number(fs.readFileSync(${JSON.stringify(reviewerPid)}, "utf8")), "SIGKILL"); } catch {}
      }
    };
    process.kill = (pid, signal) => {
      if (pid === -command?.pid) signals.push(signal);
      return kill(pid, signal);
    };
    Bun.spawn = (...args) => {
      command = spawn(...args);
      command.exited.then(() => { reaped = true; });
      return command;
    };
    mock.module("node:fs", () => ({
      ...fs,
      writeFileSync(file, ...args) {
        if (typeof file === "number") throw captureError;
        return write(file, ...args);
      },
      closeSync(fd) {
        reapedAtClose = reaped;
        reviewerRunningAtClose = reviewerRunning();
        close(fd);
        closed = true;
      },
    }));
    const watchdog = setTimeout(() => {
      timedOut = true;
      stop();
    }, 2000);
    try {
      const { reviewApproval } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/thread-approval.ts"))});
      await reviewApproval(...${JSON.stringify([f.cfg.stateDir, f.key, f.id, f.cwd])});
    } catch (error) {
      originalError = error === captureError;
      reviewerRunningAtFailure = reviewerRunning();
    } finally {
      clearTimeout(watchdog);
      stop();
      if (command) {
        await command.exited;
      }
    }
    console.log(JSON.stringify({ signals, reapedAtClose, reviewerRunningAtClose, reviewerRunningAtFailure, closed, timedOut, originalError }));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: f.cwd,
    env: {
      HOME: f.dir,
      PATH: `${f.dir}:/usr/bin:/bin`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    signals: ignoreTerm ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
    reapedAtClose: true,
    reviewerRunningAtClose: false,
    reviewerRunningAtFailure: false,
    closed: true,
    timedOut: false,
    originalError: true,
  });
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).error).toContain(
    "a CLEAN final review",
  );
  const approval = f.r.snapshot().approvals?.[0];
  const grant = approval?.grants?.at(-1);
  if (!approval || !grant) throw new Error("missing grant");
  expect(readJson(approvalArtifact(f.cfg.stateDir, approval, grant, "review"), null)).toMatchObject(
    {
      clean: false,
    },
  );
});

test("verified approval resumes the same agent to review then merge only its PR, consuming task authority", async () => {
  const f = await fixture();
  const grant = grantCommand(f.r, f.id, f.ref);
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
  expect(JSON.parse(readFileSync(join(f.dir, "gate-args"), "utf8"))).toEqual([
    "--dir",
    f.cwd,
    "--pr",
    f.target,
  ]);
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

test.each([
  false,
  true,
])("a revocation between approval-read and approval-grant rejects the stale receipt snapshot (existing grant=%s)", async (existingGrant) => {
  const f = await fixture();
  const grant = grantCommand(f.r, f.id, f.ref);
  if (existingGrant) f.r.command(f.r.token, grant);
  expect(() => f.r.command(f.r.token, grant.slice(0, 3))).toThrow("receipt snapshot");
  const before = f.r.snapshot();
  f.post("revoked", "Do not merge; I revoke approval.");
  expect(() => f.r.command(f.r.token, grant)).toThrow("receipt snapshot changed");
  expect(f.r.snapshot()).toEqual(before);
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).error).toContain(
    "current resident-verified task grant required",
  );
  expect(f.r.command(f.r.token, ["approval-read", f.id])).toMatchObject({
    receipts: ["revoked", "root"],
    grantCurrent: false,
    messages: expect.arrayContaining([
      expect.objectContaining({ id: "revoked", text: "Do not merge; I revoke approval." }),
    ]),
  });
  f.r.command(f.r.token, ["approval-resolve", f.id, "declined", "Human revoked approval."]);
});

test.each([
  false,
  true,
])("restart resumes the saved grant-only batch after approval-finish (result already collected=%s)", async (collected) => {
  const f = await fixture();
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
  await f.r.tick();
  const thread = f.r.snapshot().threads[0];
  expect(thread?.pending).toEqual([]);
  expect(thread?.inFlight).toEqual([]);
  expect(thread?.inFlightApprovals).toEqual([]);
  const grant = thread?.inFlightGrants?.[0]?.grant;
  expect(grant).toBeString();
  expect((await f.cli(["approval-review", f.id])).code).toBe(0);
  expect((await f.cli(["approval-finish", f.id, f.head, "Merged PR 123."])).code).toBe(0);
  if (collected) f.r.collect();
  await f.r.stop(); // Crash before the granted turn finishes and publishes its final reply.

  const next = f.router();
  await next.tick();
  expect(next.snapshot().approvals?.[0]).toMatchObject({
    resolution: { outcome: "completed", actor: "worker" },
    delivered: true,
  });
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2]?.resume).toBe("saved-session");
  expect(f.calls[2]?.prompt).toContain(
    "Current resident-verified task grants (exceptions to draft-only guidance for these exact workflows):\n[]",
  );
  expect((await f.cli(["approval-check", f.id, f.target, f.head, "merge"])).code).toBe(1);
  f.calls[2]?.end({ ok: true, text: "Merged after CLEAN review." });
  await until(() => next.snapshot().threads[0]?.status === "idle");
  expect(next.snapshot().threads[0]?.inFlight).toBeUndefined();
  expect(next.snapshot().threads[0]?.inFlightApprovals).toBeUndefined();
  expect(next.snapshot().threads[0]?.inFlightGrants).toBeUndefined();
  await next.tick();
  expect(f.calls).toHaveLength(3);
  expect(
    readOutbox(f.cfg.stateDir, f.key).find((item) => item.file === `final-grant-${grant}.json`)
      ?.item,
  ).toMatchObject({ text: "Merged after CLEAN review.", sent: true });
});

test("new human receipts suspend active grants before collection and invalidate an in-flight review", async () => {
  const f = await fixture();
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
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
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
  expect((await f.cli(["approval-review", f.id])).code).toBe(0);
  f.git("commit", "--allow-empty", "-m", "change after final review");
  const changedHead = f.git("rev-parse", "HEAD");
  expect((await f.cli(["approval-check", f.id, f.target, changedHead, "merge"])).code).toBe(1);
  f.post("status", "What is the status?");
  // Resident reads the follow-up and verifies that the existing actual approval still applies.
  f.r.command(f.r.token, grantCommand(f.r, f.id, f.ref));
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
  const grant = grantCommand(f.r, f.id, f.ref);
  const path = join(f.cfg.stateDir, "threads/registry.json");
  const persisted = readJson(path, null);
  const obstruction = `${path}.${process.pid}.tmp`;
  mkdirSync(obstruction);
  try {
    expect(() => f.r.command(f.r.token, grant)).toThrow();
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
