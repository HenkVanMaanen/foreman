// stream-json protocol types.
//
// The harness drives claude in headless streaming mode:
//   claude -p --input-format stream-json --output-format stream-json --verbose
// Each side exchanges newline-delimited JSON objects. These types capture the
// subset foreman needs; unknown fields are ignored.

export type EventType = "system" | "assistant" | "user" | "result" | "control_response";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamEvent {
  type: EventType;
  session_id?: string;
  subtype?: string;
  /** present on `result` frames (CUMULATIVE across the session — never use as occupancy) */
  usage?: Usage;
  /** `assistant` frames carry per-turn usage nested here; this IS the current window occupancy */
  message?: { usage?: Usage };
  /** present on `result` frames: the turn failed, with `result` carrying the message */
  is_error?: boolean;
  result?: string;
  /** set on the synthetic frame claude emits when the OAuth session is dead */
  error?: string;
  /** echoed on a `control_response` frame — the request_id of the control_request it answers */
  request_id?: string;
  /** the full raw frame, for anything not modelled here */
  raw: unknown;
}

/**
 * Sum of every usage counter. Kept for callers that want a raw total, but NOT a measure of context
 * occupancy: on a `result` frame these counters are cumulative across the whole session, so the sum
 * balloons far past the window. Use promptTokens() on an `assistant` frame for occupancy instead.
 */
export function usageTotal(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Context-window OCCUPANCY: the size of the prompt that goes into the next turn — the fresh input
 * plus the cached conversation prefix (cache_read + cache_creation). Output tokens are excluded:
 * they are not part of the prompt, and next turn they reappear folded into the cache counters.
 * Taken from an `assistant` frame's per-turn `message.usage`, this is the true current fill of the
 * window. (A `result` frame's usage is CUMULATIVE and must never be used here — see the supervisor,
 * which also clamps any reading above the window as a counting artifact.)
 */
export function promptTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  );
}

/** Build a user-turn line to write to the subprocess stdin. */
export function userMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

/**
 * Build a control-request line that interrupts the in-flight turn. The CLI answers with a
 * `control_response` carrying the same request_id, then ends the current turn with an
 * `error_during_execution` result — after which a plain user message starts a fresh turn. This is
 * the stdin control protocol the claude CLI (>= 2.1.205) speaks in stream-json mode; it is how a
 * human message can preempt a long turn instead of waiting for it to finish.
 */
export function interruptMessage(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}
