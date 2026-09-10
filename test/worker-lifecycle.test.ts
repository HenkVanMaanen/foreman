// Real shell helpers, but an empty environment, controlled PATH, and disposable stub-only cwd.
// No supervisor, service, poller, real engine, or host-wide signal is used.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InboxQueue, waitForWakeup } from "../src/inbox.ts";
import { workerNeedsAttention } from "../src/workers.ts";

const scripts = resolve(import.meta.dir, "../examples/agent-bin");
const fixtures: ReturnType<typeof fixture>[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "foreman-worker-stub-"));
  const state = join(dir, "state with spaces");
  const bin = join(dir, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    FOREMAN_STATE_DIR: state,
    FOREMAN_WORKER_ENGINE: "claude",
  };
  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Both names are always stubbed, including when a case changes the selected engine.
  shim("claude", "echo harmless-stub; exit 0");
  shim("codex", "cat >/dev/null; echo harmless-stub; exit 0");
  writeFileSync(join(dir, "brief"), "harmless test fixture only\n");
  const run = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["/usr/bin/bash", join(scripts, `${script}.sh`), ...args], {
      cwd: dir,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8000,
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const launch = (name: string, extra: Record<string, string> = {}) =>
    run("spawn-worker", [name, join(dir, "brief")], extra);
  const f = { dir, state, bin, env, shim, run, launch };
  fixtures.push(f);
  return f;
}
async function until(check: () => boolean, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("stub barrier timed out");
}
const read = (f: ReturnType<typeof fixture>, file: string) =>
  readFileSync(join(f.state, file), "utf8");
const pid = (f: ReturnType<typeof fixture>, name: string) =>
  Number(read(f, `${name}.launch`).split(" ")[1]);
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // Stop only verified wrapper identities in our own disposable state; never search host PIDs.
    for (const file of new Bun.Glob("*.launch").scanSync(f.state)) {
      f.run("worker-stop", [file.slice(0, -7)]);
    }
    await Bun.sleep(20);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("done is published after result and exit record, including nonzero engine exits", async () => {
  const f = fixture();
  f.shim("claude", "exit 7");
  // Hold the result's atomic rename: .done must remain absent while finalization is incomplete.
  // Launch acknowledgement uses mv too, so release only that rename.
  f.shim(
    "mv",
    'case "$1" in *.result.json.tmp.*) touch "$FOREMAN_STATE_DIR/moving"; while [ ! -e "$FOREMAN_STATE_DIR/release" ]; do sleep .01; done;; esac; exec /usr/bin/mv "$@"',
  );
  expect(f.launch("order").code).toBe(0);
  await until(() => existsSync(join(f.state, "moving")));
  expect(existsSync(join(f.state, "order.done"))).toBe(false);
  expect(workerNeedsAttention(f.state, "order")).toBe(false);
  writeFileSync(join(f.state, "release"), "");
  await until(() => existsSync(join(f.state, "order.done")));
  expect(JSON.parse(read(f, "order.result.json")).status).toBe("needs-verify");
  expect(read(f, "workers.jsonl")).toContain('"exit":7');
  expect(read(f, "order-worker.log")).toContain("WORKER_EXIT=7");
  expect(workerNeedsAttention(f.state, "order")).toBe(true);
});

test("TERM forwards to the stub and finalizes an interrupted result", async () => {
  const f = fixture();
  f.shim("claude", 'echo $$ > "$FOREMAN_STATE_DIR/child"; exec sleep 20');
  expect(f.launch("term").code).toBe(0);
  await until(() => existsSync(join(f.state, "child")));
  expect(f.run("worker-status", ["term"]).out).toContain("RUNNING");
  expect(f.run("worker-stop", ["term"]).code).toBe(0);
  await until(() => existsSync(join(f.state, "term.done")));
  expect(read(f, "term-worker.log")).toContain("WORKER_EXIT=143");
  expect(JSON.parse(read(f, "term.result.json")).summary).toContain("interrupted by TERM");
  expect(() => process.kill(Number(read(f, "child")), 0)).toThrow();
});

test.each([
  "default",
  "signal-ignoring",
])("foreground SIGINT stops the %s engine within the deadline", async (engine) => {
  const f = fixture();
  f.shim(
    "claude",
    `${engine === "signal-ignoring" ? "trap '' INT TERM; " : ""}echo $$ > "$FOREMAN_STATE_DIR/child"; exec sleep 30`,
  );
  const runner = Bun.spawn(
    ["/usr/bin/bash", join(scripts, "spawn-worker.sh"), "int", join(f.dir, "brief")],
    {
      cwd: f.dir,
      env: { ...f.env, FOREMAN_WORKER_LAUNCH: "foreground" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let child = 0;
  try {
    await until(() => existsSync(join(f.state, "child")) && existsSync(join(f.state, "int.child")));
    child = Number(read(f, "child"));
    process.kill(runner.pid, "SIGINT");
    await until(() => existsSync(join(f.state, "int.done")), 300);
    expect(await runner.exited).toBe(130);
    expect(read(f, "int-worker.log")).toContain("WORKER_EXIT=130");
    expect(JSON.parse(read(f, "int.result.json")).summary).toContain("interrupted by INT");
    expect(() => process.kill(child, 0)).toThrow();
  } finally {
    // Bound cleanup even against the regression, whose interrupt handler never returns.
    for (const target of [child, runner.pid]) {
      if (target > 0) {
        try {
          process.kill(target, "SIGKILL");
        } catch {}
      }
    }
    await runner.exited;
  }
});

test.each([
  "foreground",
  "nohup",
  "setsid",
])("TERM waits for resistant descendants before DONE in %s mode", async (mode) => {
  const f = fixture();
  f.shim(
    "claude",
    `trap 'exit 0' TERM
bash -c '
  trap "" TERM
  sleep 30 &
  echo "$!" > "$FOREMAN_STATE_DIR/grandchild"
  echo "$BASHPID" > "$FOREMAN_STATE_DIR/descendant"
  wait
' &
echo "$$" > "$FOREMAN_STATE_DIR/engine"
wait`,
  );
  const launcher = Bun.spawn(
    ["/usr/bin/bash", join(scripts, "spawn-worker.sh"), "tree", join(f.dir, "brief")],
    {
      cwd: f.dir,
      env: { ...f.env, FOREMAN_WORKER_LAUNCH: mode, FOREMAN_MAX_WORKERS: "1" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const running = (target: number) => {
    const r = Bun.spawnSync(["/usr/bin/ps", "-p", String(target), "-o", "stat="]);
    const stat = r.stdout.toString().trim();
    return stat !== "" && !/^[ZX]/.test(stat);
  };
  const owned: number[] = [];
  try {
    await until(() =>
      ["engine", "descendant", "grandchild", "tree.child"].every((file) =>
        existsSync(join(f.state, file)),
      ),
    );
    owned.push(
      pid(f, "tree"),
      ...["engine", "descendant", "grandchild"].map((file) => Number(read(f, file))),
    );
    expect(f.run("worker-stop", ["tree"]).code).toBe(0);
    await until(() => !running(owned[1] as number));
    expect(existsSync(join(f.state, "tree.done"))).toBe(false);
    expect(f.launch("still-capped", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(3);
    await until(() => existsSync(join(f.state, "tree.done")), 300);
    for (const target of owned.slice(1)) expect(running(target)).toBe(false);
    expect(read(f, "tree-worker.log")).toContain("WORKER_EXIT=143");
    expect(JSON.parse(read(f, "tree.result.json")).summary).toContain("interrupted by TERM");
    f.shim("claude", "exit 0");
    expect(f.launch("next", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(0);
    await until(() => existsSync(join(f.state, "next.done")));
  } finally {
    for (const target of [...owned, launcher.pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
    await launcher.exited;
  }
});

test("SIGKILL loses the wrapper, frees capacity, and wakes without a done marker", async () => {
  const f = fixture();
  f.shim("claude", 'echo $$ > "$FOREMAN_STATE_DIR/child"; exec sleep 20');
  expect(f.launch("lost", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(0);
  await until(() => existsSync(join(f.state, "child")));
  expect(f.launch("capped", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(3);
  const child = Number(read(f, "child"));
  await until(() => existsSync(join(f.state, "lost.child")));
  process.kill(pid(f, "lost"), "SIGKILL");
  await until(() => f.run("worker-status", ["lost"]).out.includes("ORPHANED"));
  expect(f.launch("still-capped", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(3);
  process.kill(child, "SIGTERM");
  await until(() => workerNeedsAttention(f.state, "lost"));
  expect(existsSync(join(f.state, "lost.done"))).toBe(false);
  expect(f.run("worker-status", ["lost"]).out).toContain("LOST");
  expect(f.run("worker-list", []).out).toContain("LOST");
  const q = new InboxQueue();
  expect(
    await waitForWakeup(
      q,
      { touch() {} },
      () => {},
      (n) => workerNeedsAttention(f.state, n),
      ["lost"],
    ),
  ).toEqual({ kind: "worker", done: ["lost"] });
  f.shim("claude", "exit 0");
  expect(f.launch("next", { FOREMAN_MAX_WORKERS: "1" }).code).toBe(0);
  await until(() => existsSync(join(f.state, "next.done")));
});

test("stale identities, missing legacy PIDs and old pending launches cannot report running", () => {
  const f = fixture();
  writeFileSync(join(f.state, "stale.launch"), `1 ${process.pid} linux:wrong-start\n`);
  writeFileSync(join(f.state, "pending.launch"), "1 pending\n");
  writeFileSync(
    join(f.state, "workers.jsonl"),
    `{"name":"legacy","pid":2147483647}\n{"name":"stale","pid":${process.pid}}\n`,
  );
  expect(f.run("worker-status", ["legacy"]).out).toContain("LOST");
  expect(f.run("worker-status", ["stale"]).out).toContain("LOST");
  expect(f.run("worker-stop", ["stale"]).code).toBe(1);
  expect(workerNeedsAttention(f.state, "pending")).toBe(true);
  expect(workerNeedsAttention(f.state, "missing")).toBe(true);
});

test("quoted sandbox docs plus actual artifact and missing result never claim no execution", async () => {
  const f = fixture();
  f.shim(
    "codex",
    'cat >/dev/null; echo "warning: Codex\'s Linux sandbox uses bubblewrap"; echo "bwrap: quoted from docs"; echo actual-output > artifact; exit 0',
  );
  expect(f.launch("quoted", { FOREMAN_WORKER_ENGINE: "codex" }).code).toBe(0);
  await until(() => existsSync(join(f.state, "quoted.done")));
  expect(readFileSync(join(f.dir, "artifact"), "utf8")).toBe("actual-output\n");
  expect(read(f, "quoted-worker.log")).toContain("WORKER_EXIT=0");
  expect(read(f, "quoted-worker.log")).not.toContain("DID NOT RUN");
  expect(JSON.parse(read(f, "quoted.result.json")).status).toBe("needs-verify");
});

test("foreground and nohup modes preserve completion; duplicate names preserve old artifacts", async () => {
  const f = fixture();
  for (const mode of ["foreground", "nohup", "setsid"]) {
    expect(f.launch(mode, { FOREMAN_WORKER_LAUNCH: mode }).code).toBe(0);
    await until(() => existsSync(join(f.state, `${mode}.done`)));
    const registry = read(f, "workers.jsonl");
    expect(f.launch(mode).code).toBe(2);
    expect(read(f, "workers.jsonl")).toBe(registry);
    expect(JSON.parse(read(f, `${mode}.result.json`)).status).toBe("needs-verify");
  }
});

test("failed launcher returns failure and durable pending evidence instead of false success", () => {
  const f = fixture();
  f.shim("nohup", "echo stub-launch-failed >&2; exit 9");
  const r = f.launch("failed", { FOREMAN_WORKER_LAUNCH: "nohup" });
  expect(r.code).toBe(1);
  expect(r.out).not.toContain("spawned worker");
  expect(read(f, "failed-worker.log")).toContain("stub-launch-failed");
  expect(read(f, "failed.launch")).toContain("pending");
}, 10000);

test("no-jq/no-setsid fallback and weighted review load retain the cap and force override", async () => {
  const f = fixture();
  // Only these tools exist on PATH: both optional tools are genuinely absent.
  for (const command of [
    "bash",
    "env",
    "nohup",
    "cat",
    "date",
    "ps",
    "readlink",
    "dirname",
    "mkdir",
    "sort",
    "sed",
    "grep",
    "awk",
    "tail",
    "mv",
    "touch",
    "sleep",
  ]) {
    symlinkSync(`/usr/bin/${command}`, join(f.bin, command));
  }
  const fallback = { PATH: f.bin };
  mkdirSync(join(f.state, "review-loops"));
  writeFileSync(join(f.state, "review-loops", String(process.pid)), "");
  expect(f.launch("capped", fallback).code).toBe(3);
  const forced = f.run("spawn-worker", ["--force", "forced", join(f.dir, "brief")], fallback);
  expect(forced.code).toBe(0);
  expect(forced.out).toContain("nohup");
  await until(() => existsSync(join(f.state, "forced.done")));
  expect(f.run("worker-list", [], fallback).out).toContain("exit 0");
  expect(f.run("worker-status", ["forced"], fallback).out).toContain("DONE");
});

test("default setsid runner survives cleanup of its disposable caller process group", async () => {
  const f = fixture();
  f.shim(
    "claude",
    'while [ ! -e "$FOREMAN_STATE_DIR/release" ]; do sleep .01; done; echo survived',
  );
  const r = Bun.spawnSync(
    [
      "/usr/bin/python3",
      "-c",
      `
import os, signal, subprocess, time
from pathlib import Path
state = Path(os.environ['FOREMAN_STATE_DIR'])
p = subprocess.Popen(['/usr/bin/bash', '-c', 'bash "$1" group "$2"; exec sleep 20', 'fixture', ${JSON.stringify(join(scripts, "spawn-worker.sh"))}, ${JSON.stringify(join(f.dir, "brief"))}], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for _ in range(200):
        if (state / 'group.child').exists(): break
        time.sleep(.01)
    assert (state / 'group.child').exists(), 'stub never started'
    runner = int((state / 'group.launch').read_text().split()[1])
    assert os.getpgid(runner) == runner
    assert p.poll() is None
    os.killpg(p.pid, signal.SIGTERM)
    p.wait(timeout=2)
    os.kill(runner, 0)
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=2)
`,
    ],
    { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 6000 },
  );
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  expect(workerNeedsAttention(f.state, "group")).toBe(false);
  writeFileSync(join(f.state, "release"), "");
  await until(() => existsSync(join(f.state, "group.done")));
  expect(read(f, "group-worker.log")).toContain("survived");
});
