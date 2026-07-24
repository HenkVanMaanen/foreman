// Unit tests for the pure, dependency-free helpers. Run with `bun test`.
// These lock the small bits of logic that the lifecycle test (test/run-lifecycle.sh) does
// not exercise directly: token accounting, stdin framing, CLI arg parsing, the dashboard's
// status heuristic, and the secret-name guard.
import { describe, expect, test } from "bun:test";
import { parseStatus } from "../src/dashboard.ts";
import { parseRun } from "../src/foreman.ts";
import {
  classifyInbox,
  extractInboxLines,
  formatInboxPrompt,
  InboxQueue,
  parseProcTable,
  strayInboxPollerPids,
  takeAnswer,
  waitForInboxLines,
} from "../src/inbox.ts";
import type { StreamEvent } from "../src/protocol.ts";
import { usageTotal, userMessage } from "../src/protocol.ts";
import {
  DEVICE_CODE_RE,
  detectAuthRequired,
  extractDeviceCode,
  extractUrl,
  makeAuthDetector,
  makeReloginBreaker,
  matchComplete,
  URL_RE,
} from "../src/relogin.ts";
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
  // The classifier returns the raw lines; formatInboxPrompt (tested below) turns them into the
  // agent-facing prompt, and the re-login relay reads the human's code straight off the lines.
  const linesOf = (stdout: string): string[] | undefined => {
    const action = classifyInbox(0, stdout);
    expect(action.kind).toBe("messages");
    return action.kind === "messages" ? action.lines : undefined;
  };

  test("exit 0 with MSG lines → messages, carrying the lines verbatim", () => {
    expect(linesOf("MSG abc - hello there\nMSG def abc follow-up\n")).toEqual([
      "MSG abc - hello there",
      "MSG def abc follow-up",
    ]);
  });

  test("exit 0 keeps only MSG lines and drops stray output", () => {
    expect(linesOf("some noise\nMSG p1 - hi\nwait-reply: done\n")).toEqual(["MSG p1 - hi"]);
  });

  test("exit 0 with an ACK line (reaction-ack) → messages, carrying it verbatim", () => {
    expect(linesOf("ACK p9 - +1\n")).toEqual(["ACK p9 - +1"]);
  });

  test("exit 0 with mixed ACK + MSG lines → messages, both pass through verbatim", () => {
    expect(linesOf("MSG abc - hello\nACK def rootX +1\n")).toEqual([
      "MSG abc - hello",
      "ACK def rootX +1",
    ]);
  });

  test("exit 0 drops stray output but keeps ACK lines", () => {
    expect(linesOf("noise\nACK p1 - +1\nwait-reply: done\n")).toEqual(["ACK p1 - +1"]);
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
    const p = formatInboxPrompt(["MSG x - yo"]);
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

describe("waitForInboxLines", () => {
  const beat = () => {
    let n = 0;
    return { touch: () => n++, count: () => n };
  };

  test("returns the lines the poller pushed, and consumes them from the queue", async () => {
    const q = new InboxQueue();
    const hb = beat();
    const p = waitForInboxLines(q, hb, () => {}, Date.now() + 10_000);
    q.push(["MSG a - 1234"]);
    expect(await p).toEqual(["MSG a - 1234"]);
    expect(q.size()).toBe(0); // taken, not copied — the caller now owns the only copy
    expect(hb.count()).toBe(1);
  });

  test("throws once the deadline passes, so the relay can send a fresh sign-in link", async () => {
    const q = new InboxQueue();
    // Already expired: the check happens BEFORE blocking, so this must not wait at all.
    await expect(waitForInboxLines(q, beat(), () => {}, Date.now() - 1)).rejects.toThrow(
      /before the deadline/,
    );
  });

  test("an empty wake refreshes and keeps waiting until the deadline", async () => {
    const q = new InboxQueue();
    const hb = beat();
    let refreshes = 0;
    // A 30ms deadline is several clamped takes: each empty one refreshes and re-blocks, and the
    // last throws rather than overshooting.
    await expect(
      waitForInboxLines(
        q,
        hb,
        () => {
          refreshes++;
        },
        Date.now() + 30,
      ),
    ).rejects.toThrow(/before the deadline/);
    expect(refreshes).toBeGreaterThan(0);
    expect(hb.count()).toBeGreaterThan(0); // a long wait is not a wedge
  });
});

/** A minimal StreamEvent, built the way Session.parse builds one: raw fields spread onto it. */
const ev = (type: string, raw: Record<string, unknown>) => ({ type, ...raw, raw }) as StreamEvent;

describe("detectAuthRequired", () => {
  test("assistant frame carrying error:authentication_failed is the signal", () => {
    expect(detectAuthRequired(ev("assistant", { error: "authentication_failed" }))).toBe(
      "authentication_failed",
    );
  });

  test("the is_error result frame claude emits when logged out", () => {
    const detail = detectAuthRequired(
      ev("result", { is_error: true, result: "Not logged in · Please run /login" }),
    );
    expect(detail).toContain("Not logged in");
  });

  test("an expired-token result frame also matches", () => {
    expect(
      detectAuthRequired(ev("result", { is_error: true, result: "OAuth token has expired" })),
    ).toBeTruthy();
  });

  test("an ordinary failed turn is NOT an auth failure", () => {
    expect(
      detectAuthRequired(ev("result", { is_error: true, result: "Tool use failed: ENOENT" })),
    ).toBeUndefined();
  });

  // An is_error frame carries whatever the failing TOOL said. A loose keyword match would read
  // some other service's logged-out message as claude's own and drag the human through a
  // pointless sign-in against a session that never expired.
  test("another tool's 'not logged in' error is NOT claude's auth failure", () => {
    expect(
      detectAuthRequired(
        ev("result", {
          is_error: true,
          result: "gh: You are not logged in to any GitHub hosts. Run `gh auth login`",
        }),
      ),
    ).toBeUndefined();
  });

  test("a failed turn that merely mentions refresh tokens is NOT an auth failure", () => {
    expect(
      detectAuthRequired(
        ev("result", { is_error: true, result: "test failed: refresh token rotation spec" }),
      ),
    ).toBeUndefined();
  });

  test("an invalid/expired refresh token IS an auth failure", () => {
    expect(
      detectAuthRequired(ev("result", { is_error: true, result: "invalid refresh token" })),
    ).toBeTruthy();
    expect(
      detectAuthRequired(ev("result", { is_error: true, result: "refresh token has expired" })),
    ).toBeTruthy();
  });

  test("a healthy result frame is not a signal", () => {
    expect(detectAuthRequired(ev("result", { is_error: false, result: "done" }))).toBeUndefined();
  });

  test("auth-shaped text on a NON-error frame is ignored (the agent may just be talking)", () => {
    expect(
      detectAuthRequired(ev("result", { is_error: false, result: "tell them to run /login" })),
    ).toBeUndefined();
  });

  test("a frame with no raw payload is safe", () => {
    expect(detectAuthRequired({ type: "system", raw: undefined } as StreamEvent)).toBeUndefined();
  });
});

describe("makeAuthDetector", () => {
  const healthy = ev("result", { is_error: false });

  test("the fake-auth injection fires exactly once, then defers to the real detector", () => {
    const detect = makeAuthDetector(true);
    expect(detect(healthy)).toContain("injected");
    expect(detect(healthy)).toBeUndefined();
  });

  test("without the flag it is a pass-through", () => {
    expect(makeAuthDetector(false)(healthy)).toBeUndefined();
  });
});

describe("makeReloginBreaker", () => {
  test("auth-only lives in a row trip it", () => {
    const breaker = makeReloginBreaker(3);
    expect(breaker(false)).toBe("attempt");
    expect(breaker(false)).toBe("attempt");
    expect(breaker(false)).toBe("give-up");
  });

  test("a life that completed a healthy turn is a genuine expiry and resets the count", () => {
    const breaker = makeReloginBreaker(3);
    breaker(false);
    breaker(false);
    expect(breaker(true)).toBe("attempt");
    expect(breaker(false)).toBe("attempt");
    expect(breaker(false)).toBe("attempt");
    expect(breaker(false)).toBe("give-up");
  });
});

describe("takeAnswer", () => {
  test("returns the text of the LAST MSG line (a correction supersedes a typo)", () => {
    expect(takeAnswer(["MSG 1 - wrongcode", "MSG 2 - rightcode#state"]).text).toBe(
      "rightcode#state",
    );
  });

  test("ignores ACK lines, which carry no text", () => {
    expect(takeAnswer(["MSG 1 - thecode", "ACK 2 - +1"]).text).toBe("thecode");
  });

  test("a code containing spaces is preserved whole", () => {
    expect(takeAnswer(["MSG 1 - abc def"]).text).toBe("abc def");
  });

  test("no MSG lines → undefined (caller retries rather than pasting junk)", () => {
    expect(takeAnswer(["ACK 2 - +1"]).text).toBeUndefined();
    expect(takeAnswer([]).text).toBeUndefined();
  });

  test("rest is every line NOT taken as the answer, in order", () => {
    const { text, rest } = takeAnswer(["ACK 1 - +1", "MSG 2 - old", "MSG 3 - new"]);
    expect(text).toBe("new");
    expect(rest).toEqual(["ACK 1 - +1", "MSG 2 - old"]);
  });

  test("two identical lines: only the one read as the answer is removed", () => {
    // An equality filter would drop both; index-based selection keeps the duplicate as a spare.
    expect(takeAnswer(["MSG 1 - dup", "MSG 1 - dup"]).rest).toEqual(["MSG 1 - dup"]);
  });

  // The human sends the code and then a whitespace-only follow-up; both land in ONE poller batch.
  // Taking the last MSG line unconditionally would read a blank as "no answer", burn an attempt,
  // and echo the still-live code back into the channel instead of pasting it into the login.
  test("a later blank-texted MSG does not hide a real answer in the same batch", () => {
    const { text, rest } = takeAnswer(["MSG 1 - GOODCODE", "MSG 2 -   "]);
    expect(text).toBe("GOODCODE");
    expect(rest).toEqual(["MSG 2 -   "]);
  });

  test("no answer → every line is a spare (nothing is silently eaten)", () => {
    expect(takeAnswer(["ACK 2 - +1"]).rest).toEqual(["ACK 2 - +1"]);
    // A blank-texted MSG line is not an answer, so it stays in rest.
    expect(takeAnswer(["MSG 1 - "]).rest).toEqual(["MSG 1 - "]);
  });
});

describe("extractUrl / extractDeviceCode", () => {
  const URL = "https://claude.com/cai/oauth/authorize?code=true&state=xyz";
  // Shaped like real `script -qec 'claude auth login'` output: an OSC-8 hyperlink wrapping an
  // SGR-coloured copy of the same URL. Both copies must resolve to the bare URL.
  const ptyBanner = `visit: \u001B]8;;${URL}\u0007\u001B[94m${URL}\u001B[39m\u001B]8;;\u0007\r\n`;

  test("pulls the sign-in URL out of pty output wrapped in escape sequences", () => {
    expect(extractUrl(ptyBanner)).toBe(URL);
  });

  test("strips trailing sentence punctuation", () => {
    expect(extractUrl("visit https://example.com/x.")).toBe("https://example.com/x");
  });

  test("no URL → undefined", () => {
    expect(extractUrl("nothing here")).toBeUndefined();
  });

  // CSI sequences with a `?` parameter byte (cursor-hide, alt-screen) are what a TUI emits around
  // its output. ESC is neither whitespace nor excluded by URL_RE, so an unstripped one sitting
  // right after the link gets swallowed into the match and the human is sent a dead URL.
  test("strips private-parameter CSI sequences abutting the URL", () => {
    expect(extractUrl(`\u001B[?25lvisit ${URL}\u001B[?25h`)).toBe(URL);
  });

  // A pty can split an escape sequence across chunks, leaving a lone ESC stripAnsi cannot remove.
  // ESC is not whitespace, so without an explicit exclusion it lands inside the match.
  test("a lone unstrippable ESC is never part of the URL", () => {
    expect(extractUrl(`visit ${URL}\u001B[`)).toBe(URL);
    expect(extractUrl(`visit ${URL}\u001B`)).toBe(URL);
  });

  test("pulls the codex one-time device code", () => {
    expect(extractDeviceCode("Enter this one-time code\n   \u001B[94mKK4S-ADG57\u001B[0m")).toBe(
      "KK4S-ADG57",
    );
  });

  test("no device code → undefined", () => {
    expect(extractDeviceCode("Open this link in your browser")).toBeUndefined();
  });

  // codex prints the URL BEFORE the code. A `\b…\b` code pattern matches an uppercase
  // `ABCD-EFGHI` segment inside the link, which would both satisfy the banner-read early (before
  // the real code arrived) and forward a string that types in but never authorises.
  test("an uppercase segment inside the sign-in URL is not the device code", () => {
    const banner = "https://auth.openai.com/device?state=AB3F-9KD2X\n\n  KK4S-ADG57\n";
    expect(extractDeviceCode(banner)).toBe("KK4S-ADG57");
    expect(matchComplete("https://auth.openai.com/device?state=AB3F-9KD2X\n", DEVICE_CODE_RE)).toBe(
      false,
    );
  });

  // The pty delivers output in chunks; without this the reader stops on the first regex hit and
  // forwards a URL that is still arriving — a dead link the human cannot fix.
  describe("matchComplete", () => {
    const colour = (s: string) => `\u001B[94m${s}\u001B[39m`;

    test("a URL still arriving is NOT complete; one trailing byte proves it is", () => {
      const partial = `visit: ${URL.slice(0, 30)}`;
      expect(matchComplete(partial, URL_RE)).toBe(false);
      expect(matchComplete(`${partial}\r\n`, URL_RE)).toBe(true);
    });

    test("trailing bytes that are only escape sequences do not prove completeness", () => {
      expect(matchComplete(colour(URL), URL_RE)).toBe(false);
      expect(matchComplete(`${colour(URL)}\r\n`, URL_RE)).toBe(true);
    });

    test("no match at all is not complete", () => {
      expect(matchComplete("nothing here\n", URL_RE)).toBe(false);
    });
  });
});

describe("parseProcTable", () => {
  test("parses pid/ppid/args rows and keeps spaces in the command", () => {
    const out =
      "  100   1 bash /home/dev/foreman/bin/wait-reply --inbox\n 101 100 curl -fsS -K -\n";
    expect(parseProcTable(out)).toEqual([
      { pid: 100, ppid: 1, cmd: "bash /home/dev/foreman/bin/wait-reply --inbox" },
      { pid: 101, ppid: 100, cmd: "curl -fsS -K -" },
    ]);
  });

  test("skips blank and malformed lines", () => {
    expect(parseProcTable("\n  garbage\n42 7 real cmd\n")).toEqual([
      { pid: 42, ppid: 7, cmd: "real cmd" },
    ]);
  });
});

describe("strayInboxPollerPids", () => {
  // A leaked poller from a prior life: reparented to init (ppid 1), self-spawned child, and the
  // curl holding getUpdates. The whole tree must be reaped.
  const orphanTree = (): { pid: number; ppid: number; cmd: string }[] => [
    { pid: 200, ppid: 1, cmd: "bash /home/dev/foreman/bin/wait-reply --inbox" },
    { pid: 201, ppid: 200, cmd: "bash /home/dev/foreman/bin/wait-reply --inbox" },
    { pid: 202, ppid: 201, cmd: "curl -fsS -K -" },
  ];

  test("returns the whole orphaned poller tree (roots + child poll + curl)", () => {
    const pids = strayInboxPollerPids(orphanTree(), 999).sort((a, b) => a - b);
    expect(pids).toEqual([200, 201, 202]);
  });

  test("never returns self, even if it somehow matches the pattern", () => {
    const procs = [{ pid: 200, ppid: 1, cmd: "bun ... wait-reply --inbox" }];
    expect(strayInboxPollerPids(procs, 200)).toEqual([]);
  });

  test("ignores single-thread waits (no --inbox) and unrelated processes", () => {
    const procs = [
      { pid: 300, ppid: 5, cmd: "bash /home/dev/foreman/bin/wait-reply abc123" }, // ask-human
      { pid: 301, ppid: 5, cmd: "bun run src/foreman.ts supervise" },
      { pid: 302, ppid: 5, cmd: "claude -p --input-format stream-json" },
    ];
    expect(strayInboxPollerPids(procs, 301)).toEqual([]);
  });

  test("no strays → empty", () => {
    expect(strayInboxPollerPids([], 1)).toEqual([]);
  });

  test("two independent orphan trees are both fully collected", () => {
    const procs = [
      ...orphanTree(),
      { pid: 400, ppid: 1, cmd: "bash bin/wait-reply --inbox" },
      { pid: 401, ppid: 400, cmd: "curl -fsS -K -" },
    ];
    expect(strayInboxPollerPids(procs, 999).sort((a, b) => a - b)).toEqual([
      200, 201, 202, 400, 401,
    ]);
  });
});
