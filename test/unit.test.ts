// Unit tests for the pure, dependency-free helpers. Run with `bun test`.
// These lock the small bits of logic that the lifecycle test (test/run-lifecycle.sh) does
// not exercise directly: token accounting, stdin framing, CLI arg parsing, the dashboard's
// status heuristic, and the secret-name guard.
import { describe, expect, test } from "bun:test";
import { parseStatus } from "../src/dashboard.ts";
import { parseRun } from "../src/foreman.ts";
import { classifyInbox, extractInboxLines, formatInboxPrompt, InboxQueue } from "../src/inbox.ts";
import { usageTotal, userMessage } from "../src/protocol.ts";
import { secretFileName } from "../src/secrets.ts";
import { isStalled, startWatchdog } from "../src/watchdog.ts";

describe("usageTotal", () => {
  test("undefined usage is zero", () => {
    expect(usageTotal(undefined)).toBe(0);
  });

  test("empty usage object is zero", () => {
    expect(usageTotal({})).toBe(0);
  });

  test("sums all four token fields", () => {
    expect(
      usageTotal({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 8,
      }),
    ).toBe(15);
  });

  test("missing fields are treated as zero", () => {
    expect(usageTotal({ input_tokens: 100, cache_read_input_tokens: 5 })).toBe(105);
  });
});

describe("userMessage", () => {
  test("frames text as a user-role stream-json line", () => {
    const parsed = JSON.parse(userMessage("hello"));
    expect(parsed).toEqual({ type: "user", message: { role: "user", content: "hello" } });
  });

  test("is a single line (no embedded newline)", () => {
    expect(userMessage("a\nb").includes("\n")).toBe(false);
  });

  test("preserves special characters via JSON escaping", () => {
    const parsed = JSON.parse(userMessage('quote " and \\ backslash'));
    expect(parsed.message.content).toBe('quote " and \\ backslash');
  });
});

describe("parseRun", () => {
  test("single secret then command", () => {
    expect(parseRun(["--secret", "TOKEN", "--", "glab", "issue", "list"])).toEqual({
      names: ["TOKEN"],
      command: ["glab", "issue", "list"],
    });
  });

  test("comma-separated names are split and trimmed", () => {
    expect(parseRun(["--secret", "A, B ,C", "--", "cmd"])).toEqual({
      names: ["A", "B", "C"],
      command: ["cmd"],
    });
  });

  test("multiple --secret flags accumulate", () => {
    expect(parseRun(["--secret", "A", "--secret", "B", "--", "cmd"])).toEqual({
      names: ["A", "B"],
      command: ["cmd"],
    });
  });

  test("empty command after -- is allowed (caller rejects it)", () => {
    expect(parseRun(["--secret", "A", "--"])).toEqual({ names: ["A"], command: [] });
  });

  test("unknown token before -- is malformed: empty command", () => {
    expect(parseRun(["bogus", "--", "cmd"])).toEqual({ names: [], command: [] });
  });

  test("no -- separator yields no command", () => {
    expect(parseRun(["--secret", "A"])).toEqual({ names: ["A"], command: [] });
  });
});

describe("parseStatus", () => {
  test("explicit status: line wins over body keywords", () => {
    expect(parseStatus("status: running\nthis task is done and merged")).toBe("running");
  });

  test("accepts status= and is case-insensitive, lowercasing the value", () => {
    expect(parseStatus("Status = WAITING")).toBe("waiting");
  });

  test("falls back to done keyword", () => {
    expect(parseStatus("all finished here")).toBe("done");
  });

  test("falls back to waiting keyword", () => {
    expect(parseStatus("currently blocked on a human reply")).toBe("waiting");
  });

  test("defaults to running when nothing matches", () => {
    expect(parseStatus("just some notes")).toBe("running");
  });
});

describe("secretFileName", () => {
  test("valid UPPER_SNAKE_CASE maps to <name>.age", () => {
    expect(secretFileName("GITLAB_TOKEN")).toBe("GITLAB_TOKEN.age");
  });

  test("digits allowed after the first letter", () => {
    expect(secretFileName("KEY_2")).toBe("KEY_2.age");
  });

  test.each([
    ["lowercase", "gitlab_token"],
    ["leading digit", "2FA"],
    ["path traversal", "../etc/passwd"],
    ["slash", "A/B"],
    ["empty", ""],
    ["hyphen", "MY-KEY"],
  ])("rejects %s", (_label, name) => {
    expect(() => secretFileName(name)).toThrow(/invalid secret name/);
  });
});

describe("isStalled", () => {
  test("not stalled below the timeout", () => {
    expect(isStalled(1000, 1000 + 999, 1000)).toBe(false);
  });

  test("stalled at exactly the timeout", () => {
    expect(isStalled(1000, 1000 + 1000, 1000)).toBe(true);
  });

  test("stalled past the timeout", () => {
    expect(isStalled(1000, 5000, 1000)).toBe(true);
  });

  test("zero timeout disables (never stalls)", () => {
    expect(isStalled(0, 1_000_000, 0)).toBe(false);
  });

  test("negative timeout disables (never stalls)", () => {
    expect(isStalled(0, 1_000_000, -1)).toBe(false);
  });
});

describe("startWatchdog", () => {
  // A hand-driven clock lets us test the timer logic without real time. checkMs is small so
  // Bun's fake-free interval fires quickly; we advance `clock` to cross the timeout.
  function harness(timeoutMs: number) {
    let clock = 0;
    const stalls: number[] = [];
    const wd = startWatchdog({
      timeoutMs,
      checkMs: 1,
      now: () => clock,
      onStall: (idle) => stalls.push(idle),
    });
    return { wd, stalls, tick: (ms: number) => (clock += ms) };
  }

  test("fires onStall once after the timeout elapses with no touch", async () => {
    const { wd, stalls, tick } = harness(100);
    tick(150);
    await new Promise((r) => setTimeout(r, 10)); // let the interval run
    wd.stop();
    expect(stalls.length).toBe(1);
    expect(stalls[0]).toBe(150);
  });

  test("touch() resets the idle clock and prevents a stall", async () => {
    const { wd, stalls, tick } = harness(100);
    tick(80);
    wd.touch(); // idle back to 0 at clock=80
    tick(80); // only 80 since touch
    await new Promise((r) => setTimeout(r, 10));
    wd.stop();
    expect(stalls.length).toBe(0);
  });

  test("does not fire twice", async () => {
    const { wd, stalls, tick } = harness(100);
    tick(500);
    await new Promise((r) => setTimeout(r, 15)); // several check intervals
    wd.stop();
    expect(stalls.length).toBe(1);
  });

  test("timeout of 0 disables the watchdog", async () => {
    const { wd, stalls, tick } = harness(0);
    tick(1_000_000);
    await new Promise((r) => setTimeout(r, 10));
    wd.stop();
    expect(stalls.length).toBe(0);
  });
});

describe("classifyInbox", () => {
  test("exit 0 with MSG lines → messages, prompt carries the lines verbatim", () => {
    const stdout = "MSG abc - hello there\nMSG def abc follow-up\n";
    const action = classifyInbox(0, stdout);
    expect(action.kind).toBe("messages");
    if (action.kind === "messages") {
      expect(action.prompt).toContain("MSG abc - hello there");
      expect(action.prompt).toContain("MSG def abc follow-up");
      expect(action.prompt.startsWith("[inbox] New message(s)")).toBe(true);
    }
  });

  test("exit 0 keeps only MSG lines and drops stray output", () => {
    const action = classifyInbox(0, "some noise\nMSG p1 - hi\nwait-reply: done\n");
    expect(action.kind).toBe("messages");
    if (action.kind === "messages") {
      expect(action.prompt).toContain("MSG p1 - hi");
      expect(action.prompt).not.toContain("some noise");
      expect(action.prompt).not.toContain("wait-reply: done");
    }
  });

  test("exit 0 with an ACK line (reaction-ack) → messages, prompt carries it verbatim", () => {
    const action = classifyInbox(0, "ACK p9 - +1\n");
    expect(action.kind).toBe("messages");
    if (action.kind === "messages") {
      expect(action.prompt).toContain("ACK p9 - +1");
      expect(action.prompt.startsWith("[inbox] New message(s)")).toBe(true);
    }
  });

  test("exit 0 with mixed ACK + MSG lines → messages, both pass through verbatim", () => {
    const action = classifyInbox(0, "MSG abc - hello\nACK def rootX +1\n");
    expect(action.kind).toBe("messages");
    if (action.kind === "messages") {
      expect(action.prompt).toContain("MSG abc - hello");
      expect(action.prompt).toContain("ACK def rootX +1");
    }
  });

  test("exit 0 drops stray output but keeps ACK lines", () => {
    const action = classifyInbox(0, "noise\nACK p1 - +1\nwait-reply: done\n");
    expect(action.kind).toBe("messages");
    if (action.kind === "messages") {
      expect(action.prompt).toContain("ACK p1 - +1");
      expect(action.prompt).not.toContain("noise");
      expect(action.prompt).not.toContain("wait-reply: done");
    }
  });

  test("exit 0 with no MSG/ACK lines is unexpected → error (falls back to CONTINUE)", () => {
    expect(classifyInbox(0, "").kind).toBe("error");
    expect(classifyInbox(0, "unrelated output\n").kind).toBe("error");
  });

  test("exit 3 (timeout, nothing new) → keep-polling", () => {
    expect(classifyInbox(3, "").kind).toBe("keep-polling");
  });

  test.each([1, 2, 4, 127])("exit %i (non-{0,3}) → error", (code) => {
    const action = classifyInbox(code, "");
    expect(action.kind).toBe("error");
    if (action.kind === "error") expect(action.reason).toContain(String(code));
  });
});

describe("formatInboxPrompt", () => {
  test("wraps raw MSG lines with the [inbox] preamble and handling guidance", () => {
    const p = formatInboxPrompt("MSG x - yo");
    expect(p.startsWith("[inbox] New message(s)")).toBe(true);
    expect(p).toContain("MSG x - yo");
    expect(p).toContain("new root");
  });
});

describe("extractInboxLines", () => {
  test("keeps only MSG/ACK lines and trims trailing whitespace", () => {
    expect(extractInboxLines("noise\nMSG p1 - hi  \nwait-reply: done\nACK p2 - +1")).toEqual([
      "MSG p1 - hi",
      "ACK p2 - +1",
    ]);
  });
  test("returns [] when nothing recognized", () => {
    expect(extractInboxLines("")).toEqual([]);
    expect(extractInboxLines("just chatter\n")).toEqual([]);
  });
});

describe("InboxQueue", () => {
  test("drain returns and clears buffered lines", () => {
    const q = new InboxQueue();
    q.push(["MSG a - 1", "MSG b - 2"]);
    expect(q.size()).toBe(2);
    expect(q.drain()).toEqual(["MSG a - 1", "MSG b - 2"]);
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  test("push([]) is a no-op", () => {
    const q = new InboxQueue();
    q.push([]);
    expect(q.size()).toBe(0);
  });

  test("take resolves immediately when lines are already buffered", async () => {
    const q = new InboxQueue();
    q.push(["MSG a - 1"]);
    expect(await q.take(10_000)).toEqual(["MSG a - 1"]);
    expect(q.size()).toBe(0);
  });

  test("a batch push delivers all its lines to a blocked waiter at once", async () => {
    const q = new InboxQueue();
    const p = q.take(10_000);
    q.push(["MSG a - 1", "MSG b - 2"]);
    expect(await p).toEqual(["MSG a - 1", "MSG b - 2"]);
  });

  test("a push after the waiter resolved is buffered, not lost", async () => {
    const q = new InboxQueue();
    const p = q.take(10_000);
    q.push(["MSG a - 1"]); // resolves the pending waiter
    q.push(["MSG b - 2"]); // no waiter now → stays buffered for the next take
    expect(await p).toEqual(["MSG a - 1"]);
    expect(await q.take(10_000)).toEqual(["MSG b - 2"]);
  });

  test("take returns [] on timeout with nothing pending", async () => {
    const q = new InboxQueue();
    expect(await q.take(5)).toEqual([]);
  });
});
