// Unit tests for the pure, dependency-free helpers. Run with `bun test`.
// These lock the small bits of logic that the lifecycle test (test/run-lifecycle.sh) does
// not exercise directly: token accounting, stdin framing, CLI arg parsing, the dashboard's
// status heuristic, and the secret-name guard.
import { describe, expect, test } from "bun:test";
import { parseStatus } from "../src/dashboard.ts";
import { parseRun } from "../src/foreman.ts";
import { usageTotal, userMessage } from "../src/protocol.ts";
import { secretFileName } from "../src/secrets.ts";

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
