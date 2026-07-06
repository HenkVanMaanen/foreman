// stream-json protocol types.
//
// The harness drives claude in headless streaming mode:
//   claude -p --input-format stream-json --output-format stream-json --verbose
// Each side exchanges newline-delimited JSON objects. These types capture the
// subset foreman needs; unknown fields are ignored.

export type EventType = "system" | "assistant" | "user" | "result";

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
  /** present on `result` frames */
  usage?: Usage;
  /** the full raw frame, for anything not modelled here */
  raw: unknown;
}

/** Effective context size after a turn — what the watchdog compares to the window. */
export function usageTotal(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** Build a user-turn line to write to the subprocess stdin. */
export function userMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}
