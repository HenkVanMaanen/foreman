// Telegram-mediated re-login relay.
//
// When claude's OAuth token dies, the MODEL IS DOWN — it cannot ask for help. The supervisor
// (plain TS, always up) therefore owns recovery end to end: it spots the auth-required frame in
// the stream-json it is already reading, drives `claude auth login` under a pty, sends the
// sign-in URL to the human over the existing channel (bin/reply, falling back to bin/ask-human —
// the one script that posts to EVERY configured channel), blocks on the SAME InboxQueue — and so the
// same watermark — the idle-wait consumes from until the human replies with the code, pastes it
// in, and verifies with `claude auth status` before letting the loop relaunch.
//
// It does NOT poll the channel itself: the always-on poller in inbox.ts stays the single
// `wait-reply --inbox` consumer, and the relay is simply the queue's reader for the duration of
// the lockout. Whatever it reads and does not use as the code it hands back to the human, since
// the watermark has already moved past it (see inbox.ts invariant 3).
//
// codex needs no code relay at all: `codex login --device-auth` prints a URL + one-time code and
// polls by itself, so we only have to forward those two strings and wait.
//
// See notes/tasks/telegram-login-relay.md for the captured observable signals this matches on.

import type { Config } from "./config.ts";
import { type InboxQueue, takeAnswer, waitForInboxLines } from "./inbox.ts";
import type { StreamEvent } from "./protocol.ts";
import type { Heartbeat } from "./watchdog.ts";
import { binPath, harnessChildEnv } from "./workspace.ts";

/** How long to wait for the login command to print its sign-in URL before giving up. */
const URL_TIMEOUT_MS = 60_000;
/** How long the login command gets to finish (exit) after the code is pasted in. */
const EXIT_TIMEOUT_MS = 60_000;
/**
 * How long one attempt waits for the human to relay the code back. The sign-in link the human was
 * sent EXPIRES, so an unbounded wait would sit on a dead URL forever; on expiry we fail the
 * attempt and the next one sends a fresh link. This deadline is the link's own lifetime, and
 * every bound inside the wait loop below is derived from it.
 */
const HUMAN_TIMEOUT_MS = 10 * 60_000;
/** Cap on the whole codex device-auth wait — the one-time code expires in 15 min anyway. */
const CODEX_TIMEOUT_MS = 16 * 60_000;
/**
 * Say the quiet part out loud on EVERY failed codex attempt: device-auth cleared ~/.codex/auth.json
 * the moment it started, so an attempt that did not finish leaves codex LOGGED OUT rather than as
 * it was found. A human told only "did not complete" would reasonably assume the old session
 * survived.
 */
const SIGNED_OUT_NOTICE =
  "[harness] codex re-authentication did not complete — codex is now signed OUT " +
  "(device-auth clears its credentials when it starts). Run `foreman relogin codex` to try again.";
/** Bad-code retries before we give up and let the keeper respawn us. */
const MAX_ATTEMPTS = 3;
/** Inbox wakes carrying no text (👍 reaction-acks) to sit through before failing an attempt. */
const MAX_TEXTLESS_WAKES = 5;
/** Auth-only agent lives in a row before the breaker (makeReloginBreaker) gives up. */
const MAX_AUTH_LIVES = 3;
/**
 * Cap on any short-lived helper child (bin/reply, bin/ask-human, `claude auth status`). None of
 * them has an internal timeout — bin/reply's curl runs without --max-time — so a blackholed TCP
 * connection hangs them indefinitely. Under supervise() the watchdog eventually force-exits, but
 * `foreman relogin` runs with NO_HEARTBEAT: without this bound the one command a locked-out human
 * is told to run would block forever with no output.
 */
const CHILD_TIMEOUT_MS = 30_000;
/**
 * Longest a bounded wait on a child may go without touching the heartbeat. Both login commands
 * are awaited for far longer than this (codex device-auth polls for up to 16 min), and a single
 * `withTimeout(proc.exited, …)` would be heartbeat-silent for the whole window — so a box with a
 * tightened FOREMAN_WATCHDOG_TIMEOUT_MS would force-exit the harness mid-flow, which for codex
 * leaves it signed OUT (see SIGNED_OUT_NOTICE).
 */
const HEARTBEAT_SLICE_MS = 30_000;

/**
 * Terminal escape sequences (colours, OSC-8 hyperlinks) that wrap the URL under a pty.
 *
 * The CSI arm follows the full ECMA-48 grammar — parameter bytes 0x30-0x3F, intermediate bytes
 * 0x20-0x2F, one final byte 0x40-0x7E — not just `[0-9;]*[A-Za-z]`. A TUI's cursor-hide
 * (`ESC[?25l`) and alt-screen (`ESC[?1049h`) carry a `?` parameter byte, which the narrower
 * pattern did not match and so left in the text; ESC is not whitespace, so one emitted
 * immediately after the sign-in link would be swallowed INTO the match and the human would be
 * sent an unusable URL. (URL_RE bars ESC too, as a second line of defence for sequences that
 * arrive split across pty chunks and so can never be stripped here.)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real terminal escapes
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Exported so the matchComplete tests exercise the SAME pattern the relay matches on.
 *
 * ESC is excluded explicitly: it is neither whitespace nor otherwise barred, so a lone escape
 * byte that stripAnsi could not remove (a sequence split across pty chunks and never completed)
 * would be swallowed INTO the match and sent to the human as part of the link.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC must not be part of a URL
export const URL_RE = /https:\/\/[^\s"'<>)\]\u001B]+/;
/**
 * Anchored on a line start or whitespace, not just a word boundary: codex prints the sign-in URL
 * BEFORE the code, and an uppercase `ABCD-EFGHI` segment inside that URL (a `state=`/`user_code=`
 * value) satisfies a bare `\b…\b`. That would both stop the banner read early — matchComplete()
 * would be satisfied by the URL alone, before the real code has arrived — and forward the URL
 * fragment to the human as the one-time code, which types in but never authorises. Every real
 * occurrence sits on its own indented line, so the anchor costs nothing.
 */
export const DEVICE_CODE_RE = /(?:^|\s)([A-Z0-9]{4}-[A-Z0-9]{5,6})\b/;

/**
 * Pull the first https URL out of (pty) output. Trailing punctuation and the terminal's own
 * escape bytes are stripped, so both the plain and the OSC-8-hyperlinked copy resolve the same.
 */
export function extractUrl(text: string): string | undefined {
  const m = stripAnsi(text).match(URL_RE);
  return m ? m[0].replace(/[.,]+$/, "") : undefined;
}

/** codex device-auth prints a one-time code like `KK4S-ADG57` under "Enter this one-time code". */
export function extractDeviceCode(text: string): string | undefined {
  // [1], not [0]: the match includes the anchoring whitespace (see DEVICE_CODE_RE).
  return stripAnsi(text).match(DEVICE_CODE_RE)?.[1];
}

/**
 * True once EVERY `re` matches AND each match is provably WHOLE — i.e. at least one more character
 * follows it. The pty hands us output in chunks, so a bare regex hit can be the prefix of a URL
 * (or code) still in flight, and a truncated sign-in link is one the human cannot recover from.
 * Since the patterns are greedy, any following character is enough proof: had it belonged to the
 * URL/code the match would have swallowed it.
 *
 * Variadic because a caller may need several patterns to be complete before it acts: codex must
 * have BOTH the URL and the device code in hand, and both are matched against the same buffer.
 */
export function matchComplete(text: string, ...res: RegExp[]): boolean {
  const s = stripAnsi(text);
  return res.every((re) => {
    const m = s.match(re);
    if (!m || m.index === undefined) return false;
    return s.length > m.index + m[0].length;
  });
}

/**
 * The wording of a result frame that means "the OAuth session is dead", as opposed to a turn that
 * merely FAILED. Each alternative is pinned to claude's own phrasing rather than to a loose
 * keyword: an `is_error` frame carries whatever the failing tool said, so a bare `not logged in`
 * matches `gh: You are not logged in to any GitHub hosts` and a bare `refresh token` matches any
 * turn that died while touching OAuth code. Either one would tear down a healthy session and drag
 * the human through a pointless sign-in — the exact outcome the claudeAuthStatus() guard exists to
 * prevent, except this one fires before the guard can help.
 */
const AUTH_TEXT_RE =
  /^\s*not logged in\b|please run \/login|oauth token (has )?expired|refresh token (has )?(expired|is invalid)|invalid refresh token/i;

/**
 * The observable "auth required" signal from a driven `claude -p --output-format stream-json`.
 * Reproduced against an empty CLAUDE_CONFIG_DIR (see the notes): the child does NOT die — it
 * emits a synthetic assistant frame carrying `error: "authentication_failed"`, then a `result`
 * frame with `is_error: true` and the text "Not logged in · Please run /login". Without this
 * detector the supervisor happily `continue`s into that forever, which is the lockout henk hit.
 *
 * Returns a short human-readable detail when the frame means "re-auth needed", else undefined.
 */
export function detectAuthRequired(ev: StreamEvent): string | undefined {
  if (ev.error === "authentication_failed") return "authentication_failed";

  if (ev.type === "result" && ev.is_error === true) {
    // Frames are parsed, not validated, so a non-string `result` is possible on a hostile frame.
    const text = typeof ev.result === "string" ? ev.result : "";
    if (AUTH_TEXT_RE.test(text)) {
      return text.trim().slice(0, 200);
    }
  }
  return undefined;
}

/**
 * The detail an INJECTED detection reports. Exported as a constant because it is the whole
 * coupling between the detector and the recovery: makeAuthRecovery forces the login flow for
 * exactly this detail, so the one-shot lives in ONE place (the detector) instead of being latched
 * a second time next to the recovery and kept in step by prose.
 */
export const INJECTED_AUTH_DETAIL = "injected (FOREMAN_FAKE_AUTH_REQUIRED)";

/**
 * Wrap detectAuthRequired with the test seam: with `injectFirst` (cfg.fakeAuthRequired, from
 * FOREMAN_FAKE_AUTH_REQUIRED) the FIRST frame is reported as an auth failure, so the whole relay
 * (Telegram send, inbox wait, login command) can be exercised end to end without logging anyone
 * out. One-shot per detector instance — so the caller must build the detector ONCE for the whole
 * run, not per agent life, or a successful relogin re-arms the injection on the next life and the
 * harness spins forever (see supervisor.ts).
 */
export function makeAuthDetector(injectFirst: boolean) {
  let injected = injectFirst;
  return (ev: StreamEvent): string | undefined => {
    if (injected) {
      injected = false;
      return INJECTED_AUTH_DETAIL;
    }
    return detectAuthRequired(ev);
  };
}

/**
 * Circuit breaker for the auth-required path, fed one verdict per agent life.
 *
 * reloginClaude returns true WITHOUT contacting anyone when the session already looks live, so a
 * false-positive detection would otherwise relaunch instantly, re-detect, and spin — spawning
 * claude processes as fast as they start. A life that completed at least one healthy turn before
 * the token died is a genuine expiry and resets the count; `maxLives` auth-only lives in a row is
 * the hot-loop signature, and "give-up" hands the backoff to the keeper.
 */
export function makeReloginBreaker(maxLives = MAX_AUTH_LIVES) {
  let consecutive = 0;
  return (sawHealthyTurn: boolean): "attempt" | "give-up" => {
    consecutive = sawHealthyTurn ? 0 : consecutive + 1;
    return consecutive >= maxLives ? "give-up" : "attempt";
  };
}

/**
 * `script` gives the child a pty, but when OUR stdout is a pipe there is no window size to copy,
 * so the pty is created 0x0 and the CLI falls back to 80 columns and HARD-WRAPS its output. A
 * sign-in URL is far longer than that, and a newline inside it ends the URL match — the human
 * would get a truncated, unusable link. Widen the pty from inside the shell before the CLI starts.
 * Failure is tolerated (`;`, not `&&`): a box without stty should still get a login attempt.
 */
const WIDEN_PTY = "stty cols 400 rows 100 2>/dev/null;";

/**
 * POSIX single-quote a string for the `sh -c` that `script -qec` runs its command under. The
 * binary name is a single argv element everywhere else (see session.ts), so it can never
 * legitimately carry shell words — quoting it changes nothing except denying a FOREMAN_CLAUDE_BIN
 * value containing `;`/backticks/`$()` the chance to execute as a command.
 */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Run a short-lived helper child to completion under CHILD_TIMEOUT_MS, capturing stdout when
 * `capture` is set. The single place this module's spawn hygiene lives: bound the wait, kill and
 * reap on overrun, and turn a Bun.spawn that THREW (a missing bin/ script, an unrunnable binary)
 * into a value rather than an exception — every caller is either a pre-flight guard outside its
 * own try/catch or a best-effort notify, so a throw here would escape as an unhandled rejection
 * in supervise() instead of a plain failure.
 *
 * A timeout reports 124 and an unrunnable binary 127 (the shell's own conventions); neither is 0,
 * so every caller reads both as failure without having to distinguish them.
 *
 * CHILD_TIMEOUT_MS is ONE budget for the whole call, not one per await: the capture path waits for
 * stdout and then for exit, and charging each its own full timeout would let a child that dribbles
 * output and then hangs block for twice the bound its own doc comment promises.
 */
async function runBounded(
  cmd: string[],
  opts: { stdin?: Uint8Array | "ignore"; capture?: boolean; env: Record<string, string> },
): Promise<{ out: string; code: number }> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  const left = () => Math.max(0, deadline - Date.now());
  try {
    const proc = Bun.spawn(cmd, {
      stdin: opts.stdin ?? "ignore",
      stdout: opts.capture ? "pipe" : "ignore",
      // Captured runs are status probes whose stderr is noise; the rest are bin/ scripts whose
      // stderr is the only diagnostic a human gets when a channel misbehaves.
      stderr: opts.capture ? "ignore" : "inherit",
      env: opts.env,
    });
    let out = "";
    if (opts.capture) {
      const text = await withTimeout(new Response(proc.stdout).text(), left());
      if (text === undefined) {
        console.error(`[relogin] ${cmd[0]} did not respond within ${CHILD_TIMEOUT_MS}ms`);
        await killAndReap(proc);
        return { out: "", code: 124 };
      }
      out = text;
    }
    const code = await withTimeout(proc.exited, left());
    if (code === undefined) {
      console.error(`[relogin] ${cmd[0]} did not exit within ${CHILD_TIMEOUT_MS}ms — killing it`);
      await killAndReap(proc);
      return { out, code: 124 };
    }
    return { out, code };
  } catch (e) {
    console.error(`[relogin] ${cmd[0]} could not be run: ${e}`);
    return { out: "", code: 127 };
  }
}

/** Spawn a bin/ script and report success. A missing script (Bun.spawn throws) is just a `false`. */
async function ran(
  cmd: string[],
  stdin: Uint8Array | "ignore",
  env: Record<string, string>,
): Promise<boolean> {
  return (await runBounded(cmd, { stdin, env })).code === 0;
}

/**
 * Post a message to the human. `bin/reply` first — it threads the message correctly — but it posts
 * to ONE channel (Mattermost, or Telegram when Mattermost is unconfigured) and the agent may have
 * replaced the reference script with one that is narrower still, so a box it cannot reach exits
 * non-zero and this "Telegram-mediated" relay would never land. `bin/ask-human` posts to EVERY
 * channel that is configured, so it is the fallback that makes the relay actually deliverable.
 * Throws only when BOTH fail: the sign-in URL is the one message that must land.
 */
async function notify(childEnv: Record<string, string>, text: string): Promise<void> {
  if (await ran([binPath("reply"), "-"], new TextEncoder().encode(text), childEnv)) return;
  // ask-human takes the text as an argument (no shell involved, so newlines/quotes are safe) and
  // --urgency background keeps it from appending the "I'm blocked" nudge to an already-loud alert.
  if (await ran([binPath("ask-human"), text, "--urgency", "background"], "ignore", childEnv))
    return;
  throw new Error("neither bin/reply nor bin/ask-human could reach the human");
}

/**
 * Best-effort notify: used for the messages that only INFORM the human ("you're back in").
 * A channel hiccup on one of those must never be read as "the re-login failed" — that would
 * drag the human through a second, pointless sign-in against an account that is already live.
 */
async function notifyQuietly(childEnv: Record<string, string>, text: string) {
  try {
    await notify(childEnv, text);
  } catch (e) {
    console.error(`[relogin] could not deliver notice (${e}): ${text}`);
  }
}

/**
 * The above, for callers outside this module that hold the raw workspace env (the supervisor's
 * give-up path, which has its own consumed-but-unused inbox lines to hand back). Exported rather
 * than left to sendTelegramAck(): that helper is a no-op unless TELEGRAM_* is in the harness's own
 * env, so on a Mattermost-only box it would silently DROP lines the watermark has already moved
 * past — the one thing inbox.ts invariant 3 forbids.
 */
export async function notifyHuman(
  cfg: Config,
  env: Record<string, string>,
  text: string,
): Promise<void> {
  await notifyQuietly(harnessChildEnv(cfg, env), text);
}

/**
 * `p`, or `undefined` if `timeoutMs` passes first. The timer is always cleared, so a race won by
 * `p` cannot leave a pending timeout holding the event loop open (a 16-minute one would keep
 * `foreman relogin codex` "running" long after it finished).
 */
async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keep reading `stream` in the background and throw the bytes away. Once readBanner() has the
 * banner nobody wants the rest, but nobody may STOP reading it either: an undrained pipe fills
 * its ~64K OS buffer and the child blocks in write() forever. codex device-auth chatters for up
 * to 16 minutes, so without this it can wedge before it ever writes ~/.codex/auth.json.
 *
 * A default WritableStream discards everything written to it, so piping into one IS the drain.
 * The rejection when the stream closes with the process is expected — there is nothing to recover.
 */
function drain(stream: ReadableStream<Uint8Array>): void {
  void stream.pipeTo(new WritableStream()).catch(() => {});
}

/** SIGTERM `proc` and reap it, so a failed attempt never leaves a zombie behind. */
async function killAndReap(proc: { kill: () => void; exited: Promise<number> }): Promise<void> {
  proc.kill();
  await proc.exited.catch(() => {});
}

/**
 * Await `p` for up to `timeoutMs`, reporting life every HEARTBEAT_SLICE_MS meanwhile — `undefined`
 * if the deadline passes first. The single shared bounded-wait: both waits in this module are
 * minutes long, and a bare withTimeout() would be heartbeat-silent for the whole window (see
 * HEARTBEAT_SLICE_MS for what that costs).
 *
 * The SAME promise is re-awaited across slices, never re-issued: for a stream read() an expired
 * slice leaves the request queued, so abandoning it and reading again would let the abandoned
 * promise resolve with a chunk nobody is awaiting — silently losing part of the URL.
 */
async function awaitSliced<T>(
  p: Promise<T>,
  watchdog: Heartbeat,
  timeoutMs: number,
  onTick: () => void | Promise<void> = () => {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (let left = timeoutMs; left > 0; left = deadline - Date.now()) {
    const v = await withTimeout(p, Math.min(HEARTBEAT_SLICE_MS, left));
    if (v !== undefined) return v;
    watchdog.touch();
    // A status write that fails must never abort a login in progress — the whole point of the
    // re-stamp is cosmetic (keeping the dashboard from reading "quiet"), and for codex an
    // aborted attempt leaves it signed OUT.
    try {
      await onTick();
    } catch (e) {
      console.error(`[relogin] status refresh failed: ${e}`);
    }
  }
  return undefined;
}

/**
 * How much of the banner to keep. Under `script -qec` the CLI runs its interactive TUI, so
 * spinner/redraw frames can arrive for the full URL_TIMEOUT_MS — without a cap `seen` grows
 * unbounded and every chunk re-strips and re-scans all of it (quadratic). The sign-in URL and
 * codex's one-time code are printed together at the END of the banner and are well under 1 KB,
 * so keeping the last 64 KB cannot lose them.
 */
const BANNER_TAIL_MAX = 65_536;

/**
 * Read a login command's banner until every `res` has arrived WHOLE — or "" if nothing complete
 * showed up in time. Returned as the raw pty text: normalising is the extractors' job, and they
 * strip it themselves (they are public and take raw text from their tests), so stripping here too
 * only bought a second pass over the buffer.
 *
 * The `complete` flag, rather than re-testing `seen` after the loop, is what makes the three
 * non-match exits (URL_TIMEOUT_MS expired, the child closed its stdout, no bytes at all) return
 * "" and only a genuine match return text. Extracting from a half-arrived banner regardless would
 * send the human a truncated, unusable link and then block for ten minutes on a code that cannot
 * arrive.
 *
 * "" rather than undefined so callers extract unconditionally: the extractors already answer
 * undefined for text with no match, and every call site's next line is a `if (!url) throw`. An
 * `undefined` return only bought each of them a second, separately-maintained guard.
 */
async function readBanner(
  stream: ReadableStream<Uint8Array>,
  watchdog: Heartbeat,
  ...res: RegExp[]
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Date.now() + URL_TIMEOUT_MS;
  let seen = "";
  let complete = false;
  try {
    for (let left = deadline - Date.now(); left > 0 && !complete; left = deadline - Date.now()) {
      const step = await awaitSliced(reader.read(), watchdog, left);
      if (!step || step.done) break; // deadline, or the child closed its stdout
      seen += decoder.decode(step.value, { stream: true });
      if (seen.length > BANNER_TAIL_MAX) seen = seen.slice(-BANNER_TAIL_MAX);
      complete = matchComplete(seen, ...res);
    }
  } finally {
    reader.releaseLock();
  }
  return complete ? seen : "";
}

/**
 * What `claude auth status` said. THREE-valued, not a boolean: "unknown" means the command told
 * us nothing we could read — it is missing, it was renamed, it timed out, it printed no
 * `{"loggedIn":…}` at all. Collapsing that into `false` is what makes a CLI without the
 * subcommand unrecoverable: every correct sign-in would be verified as a failure, the human
 * would be asked to paste a code MAX_ATTEMPTS times, and the loop would exit "failed" against an
 * account that is in fact live. Callers distinguish the two (see reloginClaude).
 */
type AuthStatus = "in" | "out" | "unknown";

/**
 * Ask `claude auth status` whether the session is live (it prints `{"loggedIn":…}`). Runs under
 * the same child env the login does: verifying in a different environment than the one we just
 * authenticated in would read a different credential location and report failure after a good
 * sign-in.
 *
 * The FIELD is matched directly rather than the stdout parsed as JSON: CLIs routinely prepend an
 * update-available banner or a config warning, and a bare JSON.parse of that throws. Read after a
 * SUCCESSFUL sign-in that verdict burns every remaining attempt and drags the human through three
 * more pointless logins against an account that is already live. Matching the one field we care
 * about is immune to surrounding noise — including a banner that itself contains braces
 * (`Update available {2.1.0}`) or a second JSON line printed after the verdict.
 */
async function claudeAuthStatus(
  cfg: Config,
  childEnv: Record<string, string>,
): Promise<AuthStatus> {
  const { out } = await runBounded([cfg.claudeBin, "auth", "status"], {
    capture: true,
    env: childEnv,
  });
  const m = stripAnsi(out).match(/"loggedIn"\s*:\s*(true|false)/);
  if (!m) return "unknown";
  return m[1] === "true" ? "in" : "out";
}

/**
 * True when `codex login status` reports a live session. It prints "Logged in using ChatGPT" and
 * exits 0, versus "Not logged in" / exit 1 (measured on v0.144.6); we require BOTH so a future
 * wording change or a config-load failure (which also exits 1) can't be read as success.
 *
 * Same child env as the login, for the reason claudeAuthStatus() gives.
 */
async function codexLoggedIn(cfg: Config, childEnv: Record<string, string>): Promise<boolean> {
  const { out, code } = await runBounded([cfg.codexBin, "login", "status"], {
    capture: true,
    env: childEnv,
  });
  return code === 0 && /^\s*Logged in/im.test(stripAnsi(out));
}

/**
 * Re-authenticate claude with the human relaying the code over Telegram.
 *
 * `claude auth login` reads the pasted code from /dev/tty, not stdin — a plain pipe is ignored
 * (verified: it hangs at the prompt). So it must run under a pty; `script -qec` is the dependency
 * -free way to get one. Returns true once `claude auth status` confirms the new session.
 */
export async function reloginClaude(
  cfg: Config,
  watchdog: Heartbeat,
  inbox: InboxQueue,
  env: Record<string, string>,
  force = false,
  refresh: () => void | Promise<void> = () => {},
): Promise<boolean> {
  // One child env for the whole flow: every step (login, notify, verify) must run against the
  // same FOREMAN_STATE_DIR and credential location.
  const childEnv = harnessChildEnv(cfg, env);
  // Never start a login flow against a session that is still good — the detector can fire on a
  // transient frame, and dragging the human out of bed to re-auth a working account is worse
  // than the lockout itself. `force` is what makes a manual rehearsal more than a no-op.
  // Only a definite "in" short-circuits: "unknown" (no readable verdict) must fall through to the
  // login, since the alternative is refusing to recover a box we cannot interrogate.
  if (!force && (await claudeAuthStatus(cfg, childEnv)) === "in") return true;

  const spawnLogin = () =>
    Bun.spawn(
      ["script", "-qec", `${WIDEN_PTY} ${shQuote(cfg.claudeBin)} auth login`, "/dev/null"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: childEnv,
      },
    );

  // Every inbox line we consumed and did NOT use as the code, across ALL attempts. We drain the
  // SAME watermark the agent's idle-wait does, so anything we read is gone from it the moment we
  // read it and this is its only remaining copy — including `ACK` reaction-acks, which carry no
  // text for us but ARE the human's 👍 approval of one of the agent's own posts. Accumulated
  // outside the attempt loop (and echoed on the give-up path below) because an attempt that ends
  // by THROWING — the deadline expired, MAX_TEXTLESS_WAKES of 👍s — would otherwise drop
  // everything it had consumed on the floor with nothing echoed to anyone.
  const spare: string[] = [];
  /**
   * Hand back everything consumed-but-unused so far, appended to `lead`. splice() so each line is
   * echoed exactly once no matter which of the three exits gets here first. Best-effort delivery:
   * every caller is on a path where a failed notify must not change the outcome.
   */
  const handBackSpare = async (lead: string, trailer: string) => {
    const consumed = spare.splice(0);
    await notifyQuietly(
      childEnv,
      lead + (consumed.length ? `${trailer}\n${consumed.join("\n")}` : ""),
    );
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Spawn INSIDE the try: a box without util-linux `script` makes Bun.spawn throw
    // synchronously, and from outside the try that escapes reloginClaude() altogether — an
    // unhandled rejection in supervise() instead of the plain `false` every caller is written
    // for. Same reasoning as runBounded()'s 127.
    let proc: ReturnType<typeof spawnLogin> | undefined;
    try {
      proc = spawnLogin();
      const banner = await readBanner(proc.stdout, watchdog, URL_RE);
      watchdog.touch();
      const url = extractUrl(banner);
      if (!url) throw new Error("claude auth login printed no complete sign-in URL");
      drain(proc.stdout); // the human wait below can be long — never let the child block on stdout

      await notify(
        childEnv,
        `[harness] claude needs re-authentication — the agent is DOWN until this is done` +
          `${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ""}.\n\n` +
          `1. Open: ${url}\n` +
          `2. Sign in, copy the code the page shows.\n` +
          `3. Reply to this message with JUST the code.`,
      );

      // Everything the poller queued between the supervisor's pre-lockout drain and the send
      // above was written BEFORE the human was ever asked for a code — the banner read alone can
      // take URL_TIMEOUT_MS, so that window is minutes wide, not instants. Sweep it into `spare`
      // here rather than letting the wait below read it: takeAnswer() would hand the last of
      // those ordinary messages to the login prompt as the sign-in code. Only lines that arrive
      // after this point can be the answer.
      spare.push(...inbox.drain());

      // Wait for the code on the SAME queue — and so the same watermark
      // (state/wait-reply/inbox.tg.offset) — the idle-wait drains, so it can never be
      // double-consumed by the agent's own poll. The always-on poller keeps filling that queue
      // while we block here; we are simply the reader for the duration (see inbox.ts invariants).
      //
      // The governing cost below: ending this wait early kills the login child and with it the
      // live URL the human may be signing in with RIGHT NOW. Hence the wake counter bounds
      // text-less wakes only — 👍-ing the "needs re-authentication" message is the most natural
      // thing a human does and arrives as an ACK line with no text, so it must not read as a bad
      // answer, while a channel that somehow streams reaction-acks still has to fall through.
      const deadline = Date.now() + HUMAN_TIMEOUT_MS;
      let code: string | undefined;
      let textlessWakes = 0;
      while (!code && textlessWakes < MAX_TEXTLESS_WAKES && Date.now() < deadline) {
        // Throws once the deadline passes — caught by the attempt's own catch, which kills the
        // login child so the next attempt can send a fresh (non-expired) link. Nothing else here
        // can fail: reading the queue is in-memory, and the poller absorbs channel errors itself
        // rather than surfacing them to its readers.
        const lines = await waitForInboxLines(inbox, watchdog, refresh, deadline);
        // Everything we consumed except the ONE line taken as the code is a spare — ACK lines
        // included. takeAnswer() splits both halves in inbox.ts, so the "which line was the
        // answer" rule is not restated here.
        const { text, rest } = takeAnswer(lines);
        code = text;
        spare.push(...rest);
        if (!code) textlessWakes++;
      }
      // The OTHER way out of the loop: nothing but reaction-acks. (The deadline never surfaces
      // here — waitForInboxLines() THROWS on it, naming itself, so the loop cannot fall out that
      // way. The `Date.now() < deadline` guard above is belt-and-braces.) Named rather than
      // reported as a bare "no code", because it calls for a different response from whoever
      // reads the log after a lockout: stop replying with a bare 👍.
      if (!code) {
        throw new Error(`${textlessWakes} inbox wake(s) carried no text (reaction-acks only)`);
      }

      proc.stdin.write(`${code}\n`);
      await proc.stdin.flush();
      // Bounded because a WRONG code makes the CLI re-prompt instead of exiting: unbounded, the
      // watchdog-less `foreman relogin` path would hang there forever. That same re-prompt can
      // burn the full EXIT_TIMEOUT_MS, so `refresh` rides the slices (see awaitSliced).
      const loginExit = await awaitSliced(proc.exited, watchdog, EXIT_TIMEOUT_MS, refresh);
      if (loginExit === undefined) await killAndReap(proc);
      watchdog.touch();

      // `claude auth status` is the verification we WANT, but it is not the only evidence we
      // have: the login command itself exited, and a wrong code makes it re-prompt rather than
      // exit 0 (which is why the wait is bounded at all). So when status returns no readable
      // verdict — subcommand missing, renamed, timed out — fall back to that exit code instead of
      // reporting failure. Without this an installed CLI without `auth status` is unrecoverable:
      // every correct code the human pastes is verified as a failure, all MAX_ATTEMPTS are burned
      // asking them to do it again, and the loop exits "failed" against a live account.
      const status = await claudeAuthStatus(cfg, childEnv);
      if (status === "unknown") {
        console.error(
          `[relogin] ${cfg.claudeBin} auth status gave no readable verdict — ` +
            `falling back to the login command's exit code (${loginExit})`,
        );
      }
      if (status === "in" || (status === "unknown" && loginExit === 0)) {
        await handBackSpare(
          "[harness] claude re-authenticated — resuming the loop.",
          "\n\nYou also sent this while I was signing in; I consumed it off the inbox, " +
            "so please re-send anything that still needs an answer:",
        );
        return true;
      }
      // The code itself is NOT echoed. It is an OAuth authorization code: quoting it back writes
      // a possibly still-live credential into the channel's permanent history (and this branch is
      // reached whenever verification failed for ANY reason, including a good code the login
      // child was killed before it could redeem). The human knows what they just sent.
      await handBackSpare(
        "[harness] that did not work — I read your last reply as the sign-in code. " +
          "If that was an ordinary message, please send it again once we are back in.",
        "\n\nI also consumed these off the inbox:",
      );
    } catch (e) {
      console.error(`[relogin] claude attempt ${attempt} failed: ${e}`);
      if (proc) await killAndReap(proc);
    }
  }
  // Out of attempts. Anything still buffered was consumed off the SHARED watermark by an attempt
  // that ended by throwing (deadline expired, or nothing but 👍 reaction-acks) and so was never
  // echoed — this is the last chance to hand it back before the loop exits for the keeper. Sent
  // ONLY when there is something to return: a bare "giving up" notice adds nothing the human
  // cannot already see, and they are mid-lockout.
  if (spare.length) {
    await handBackSpare(
      "[harness] giving up on re-authenticating claude for now.",
      " I consumed these off the inbox while trying, so please re-send anything that still " +
        "needs an answer:",
    );
  }
  return false;
}

/**
 * Re-authenticate codex. `codex login --device-auth` prints a URL and a one-time code and then
 * polls by itself, so there is nothing to relay back — we forward both strings and wait for the
 * process to exit. No pty needed (verified with stdin=/dev/null).
 *
 * CAUTION (measured): starting device-auth CLEARS ~/.codex/auth.json immediately (see
 * SIGNED_OUT_NOTICE). Hence the guard below — never start it against a session that is still good.
 */
async function reloginCodex(
  cfg: Config,
  watchdog: Heartbeat,
  // Unused: device-auth polls by itself, so there is no code to relay back off the inbox. Taken
  // anyway so both flows share the Relogin shape the CLI and the supervisor dispatch through.
  _inbox: InboxQueue,
  env: Record<string, string>,
  force = false,
  refresh: () => void | Promise<void> = () => {},
): Promise<boolean> {
  const childEnv = harnessChildEnv(cfg, env);
  if (!force && (await codexLoggedIn(cfg, childEnv))) return true;
  // Spawn inside the try — a missing/unrunnable codexBin makes Bun.spawn throw synchronously,
  // and from outside it that escapes as an unhandled rejection instead of returning false.
  let proc: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
  try {
    proc = Bun.spawn([cfg.codexBin, "login", "--device-auth"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: childEnv,
    });
    // Both patterns must be complete before we forward either: a truncated device code is as
    // unusable as a truncated link, and codex gives the human only 15 minutes to type it.
    const banner = await readBanner(proc.stdout, watchdog, URL_RE, DEVICE_CODE_RE);
    watchdog.touch();
    const url = extractUrl(banner);
    const code = extractDeviceCode(banner);
    if (!url || !code) throw new Error("codex login printed no complete device URL/code");
    drain(proc.stdout); // codex chatters while it polls; an undrained pipe would wedge it

    await notify(
      childEnv,
      `[harness] codex needs re-authentication.\n\n1. Open: ${url}\n2. Enter this code: ${code}\n` +
        `Nothing to reply here — I am polling and will confirm when it lands.`,
    );

    // codex polls on its own; just bound the wait. 16 min of silence would read as both a wedge
    // (watchdog) and "quiet" (dashboard), so heartbeat and `refresh` ride the slices — see
    // awaitSliced.
    const done = await awaitSliced(proc.exited, watchdog, CODEX_TIMEOUT_MS, refresh);
    watchdog.touch();
    if (done === undefined) await killAndReap(proc);

    if (await codexLoggedIn(cfg, childEnv)) {
      await notifyQuietly(childEnv, "[harness] codex re-authenticated.");
      return true;
    }
    // We just asked, and the answer was no.
    await notifyQuietly(childEnv, SIGNED_OUT_NOTICE);
    return false;
  } catch (e) {
    console.error(`[relogin] codex failed: ${e}`);
    if (proc) {
      await killAndReap(proc);
      // Every way OUT of the try after the spawn leaves codex signed out just as surely as a
      // completed-but-failed attempt does, so the human hears the same warning. Guarded on `proc`
      // because a Bun.spawn that THREW never started device-auth; re-checked because this path has
      // not asked yet, and a failure that left the credentials intact must not raise a false alarm.
      if (!(await codexLoggedIn(cfg, childEnv))) await notifyQuietly(childEnv, SIGNED_OUT_NOTICE);
    }
    return false;
  }
}

/**
 * What every re-login flow looks like from the outside: drive whatever the CLI needs, keep the
 * heartbeat fed, and answer "are we logged in?". Named rather than written as
 * `typeof reloginClaude` so the contract is the shared shape, not whatever the claude flow's
 * signature happens to be today.
 */
export type Relogin = (
  cfg: Config,
  watchdog: Heartbeat,
  /**
   * The shared inbox the always-on poller fills. Passed in rather than polled for directly so the
   * relay reads the human's reply off the SAME queue as everything else — one Telegram consumer,
   * and no line consumable twice. See the invariants at the top of inbox.ts.
   */
  inbox: InboxQueue,
  env: Record<string, string>,
  force?: boolean,
  /**
   * Called between inbox polls so the caller can re-stamp its dashboard status. The relay blocks
   * on a human for up to MAX_ATTEMPTS × HUMAN_TIMEOUT_MS; without this the last status write is
   * half an hour old by the end and the dashboard reports the harness "quiet" — indistinguishable
   * from wedged, at exactly the moment the human is being asked to fix it.
   */
  refresh?: () => void | Promise<void>,
) => Promise<boolean>;

/**
 * The agents this module can re-authenticate, so the `foreman relogin` CLI looks one up instead
 * of hardcoding the set (and its usage string) in the dispatcher. The two flows stay separate
 * functions on purpose: pty + code relay vs self-polling device-auth are genuinely different.
 */
export const RELOGIN_AGENTS = new Map<string, Relogin>([
  ["claude", reloginClaude],
  ["codex", reloginCodex],
]);

/** What became of a life that ended on auth. Recorded verbatim as the `relogin` event detail. */
type AuthRecoveryOutcome = "recovered" | "disabled" | "breaker-tripped" | "failed";

/**
 * The supervisor's whole interface to this module's recovery path: one call per agent life that
 * ended on an auth frame, answering "can the loop continue?".
 *
 * Everything the decision needs — whether the relay is enabled at all, the hot-loop breaker and
 * its state across lives, and which agent the loop actually runs — is relay policy and lives
 * here. The supervisor only has to know that "recovered" means relaunch and anything else means
 * exit for the keeper.
 */
export function makeAuthRecovery(cfg: Config) {
  const breaker = makeReloginBreaker();
  return async (
    watchdog: Heartbeat,
    inbox: InboxQueue,
    env: Record<string, string>,
    sawHealthyTurn: boolean,
    /** The detector's own verdict for this life — see the `force` derivation below. */
    detail: string,
    refresh: () => void | Promise<void> = () => {},
  ): Promise<AuthRecoveryOutcome> => {
    // Force the flow when the failure was INJECTED: the session is still live by construction, so
    // the "already logged in?" guard would short-circuit to true and the rehearsal would exercise
    // nothing but the detector — no Telegram send, no inbox wait, no login command. `claude auth
    // login` does not drop the existing session while it runs, so forcing it here is safe (unlike
    // codex device-auth, which clears its credentials the moment it starts).
    //
    // Derived from the detection itself rather than from a second one-shot latched off cfg: the
    // detector's injection is already one-shot, so reading its verdict makes "this was the
    // rehearsal" structurally true for exactly the life it fired on. A separate latch had to be
    // spent in lockstep with the detector's, an invariant nothing but a comment could enforce.
    const force = detail === INJECTED_AUTH_DETAIL;
    if (!cfg.reloginEnabled) return "disabled";
    if (breaker(sawHealthyTurn) === "give-up") return "breaker-tripped";
    return (await reloginClaude(cfg, watchdog, inbox, env, force, refresh))
      ? "recovered"
      : "failed";
  };
}
