import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { boundedText, notesContext, reviewContext } from "../src/agent-context.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(import.meta.dir, ".context-test-"));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

test("bounded notes preserve beginning/end and UTF-8 without changing durable memory", () => {
  const root = fixture();
  const text = `important beginning\n${"😀".repeat(40_000)}\ncurrent task at end`;
  writeFileSync(join(root, "INDEX.md"), text);
  const result = notesContext(root);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(15_000);
  expect(result).toStartWith("important beginning");
  expect(result).toEndWith("current task at end");
  expect(result).toContain("Full durable notes remain");
  expect(result).not.toContain("�");
  expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(text);
  expect(boundedText("small", 100, "unused")).toBe("small");
});

test("bounded-run preserves the full artifact and failing command status with bounded memory/output", async () => {
  const root = fixture();
  const child = Bun.spawn(
    [
      "bun",
      "run",
      resolve("src/agent-context-cli.ts"),
      "bounded-run",
      "--",
      "bun",
      "-e",
      'process.stdout.write("start\\n" + "x".repeat(200000)); process.stderr.write("\\nfinal failure\\n"); process.exitCode=7;',
    ],
    { env: { ...process.env, FOREMAN_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(7);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(10_000);
  expect(text).toContain("Full artifact:");
  expect(text).toContain("exit=7");
  const file = join(root, "tool-results", readdirSync(join(root, "tool-results"))[0] ?? "");
  expect(readFileSync(file, "utf8")).toContain("final failure");
  expect(statSync(file).size).toBeGreaterThan(200_000);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("review evidence reuses unchanged content and invalidates on tracked, untracked, and head changes", () => {
  const root = fixture();
  const repo = join(root, "repo");
  const cache = join(root, "cache");
  mkdirSync(repo);
  git(repo, "init", "-b", "task");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "source.ts"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "source.ts"), "changed\n");
  const a = reviewContext(repo, base, cache);
  expect(reviewContext(repo, base, cache)).toBe(a);
  expect(readdirSync(cache)).toHaveLength(1);
  expect(a).toContain("Run every required phase");
  writeFileSync(join(repo, "new.ts"), "new\n");
  const b = reviewContext(repo, base, cache);
  expect(b).not.toBe(a);
  writeFileSync(join(repo, "new.ts"), "different\n");
  const c = reviewContext(repo, base, cache);
  expect(c).not.toBe(b);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "new head");
  const d = reviewContext(repo, base, cache);
  expect(d).not.toBe(c);
  expect(readdirSync(cache)).toHaveLength(4);
  for (const directory of readdirSync(cache)) {
    expect(statSync(join(cache, directory, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cache, directory, "changes.diff"), "utf8")).toContain("+changed");
  }
});
