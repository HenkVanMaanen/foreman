// Watchdog: recover a silently-wedged harness.
//
// keeper.sh only respawns the harness when the process EXITS. If the supervisor's event loop
// stalls — e.g. the `claude` subprocess stops emitting yet never closes its stdout, or an
// awaited promise never resolves — the process stays alive forever and keeper never steps in.
// This watchdog gives the supervisor a wall-clock heartbeat: supervise() calls touch() on
// every sign of progress, and if no progress is seen for `timeoutMs`, we force-exit so keeper
// respawns a fresh harness. Durable state lives in notes/ and detached workers, so a bounce
// loses nothing.
//
// The check runs on a setInterval, which keeps firing even while the main flow is parked on a
// never-resolving await (timers run on the event loop; a pending promise does not block it) —
// exactly the class of stall keeper's exit-only respawn cannot see.

/** Pure predicate: has progress stalled at/past the timeout? A zero/negative timeout disables. */
export function isStalled(lastProgressMs: number, nowMs: number, timeoutMs: number): boolean {
  if (timeoutMs <= 0) return false;
  return nowMs - lastProgressMs >= timeoutMs;
}

/**
 * What a long-running helper needs from the watchdog: somewhere to report progress. Taking this
 * instead of the full Watchdog keeps callers that have no stall detection to run (the `foreman
 * relogin` CLI, tests) from having to fabricate a deliberately-disabled timer just to make a call.
 */
export interface Heartbeat {
  /** Record a sign of life. Call on every stream event, send, and loop turn. */
  touch(): void;
}

/** No-op heartbeat for flows that are legitimately human-paced and must never be stall-killed. */
export const NO_HEARTBEAT: Heartbeat = { touch() {} };

export interface Watchdog extends Heartbeat {
  /** Stop the timer (graceful shutdown / test cleanup). */
  stop(): void;
}

export interface WatchdogOptions {
  /** Idle time before the harness is considered wedged. <= 0 disables the watchdog. */
  timeoutMs: number;
  /** How often to test for a stall. */
  checkMs: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Called once when a stall is detected. In production this logs + force-exits. */
  onStall: (idleMs: number) => void;
}

export function startWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? Date.now;
  let last = now();
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return; // onStall fires at most once (it force-exits in production)
    const t = now();
    if (isStalled(last, t, opts.timeoutMs)) {
      fired = true;
      opts.onStall(t - last);
    }
  }, opts.checkMs);

  // Never let the watchdog timer alone keep the process alive on a legitimate exit.
  const maybeUnref = timer as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();

  return {
    touch() {
      last = now();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
