import { z } from "zod";
import { EngineStateSchema, EngineEventSchema, MoveSchema } from "./engine";

export const StepRequestSchema = z
  .object({
    state: EngineStateSchema.nullable(),
    event: EngineEventSchema,
  })
  .superRefine((data, ctx) => {
    // state === null exactly when event.type === "start"
    if (data.state === null && data.event.type !== "start") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "state must be null only when event.type is 'start'",
        path: ["state"],
      });
    }
    if (data.state !== null && data.event.type === "start") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "state must be null when event.type is 'start'",
        path: ["state"],
      });
    }
  });

export type StepRequest = z.infer<typeof StepRequestSchema>;

/**
 * SSE stream events for the step endpoint.
 * 
 * Invariant: concatenating every token.text in order must exactly equal the done utterance.
 * Real model deltas already include their spaces; stub tokens must preserve whitespace.
 * An `error` event may also be the first and only event, if the step fails before a move is decided.
 */
export const StepStreamEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("move"),
    data: z.object({
      move: MoveSchema,
      interrupt: z.boolean(),
    }),
  }),
  z.object({
    event: z.literal("token"),
    data: z.object({
      text: z.string(),
    }),
  }),
  z.object({
    event: z.literal("done"),
    data: z.object({
      state: EngineStateSchema,
      utterance: z.string(),
    }),
  }),
  z.object({
    event: z.literal("error"),
    data: z.object({
      code: z.enum(["bad_request", "model_timeout", "model_error", "internal"]),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);

export type StepStreamEvent = z.infer<typeof StepStreamEventSchema>;

export function encodeSSE(e: StepStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/**
 * Parse a single SSE block (event + data lines) into a StepStreamEvent.
 */
function parseSSEBlock(block: string): StepStreamEvent {
  const lines = block.split(/\r?\n/);
  let eventType: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      // Strip only one optional leading space after "event:"
      const rest = line.substring(6);
      eventType = rest.startsWith(" ") ? rest.substring(1) : rest;
    } else if (line.startsWith("data:")) {
      // Strip only one optional leading space after "data:"
      const rest = line.substring(5);
      dataLines.push(rest.startsWith(" ") ? rest.substring(1) : rest);
    }
  }

  if (eventType === null) {
    throw new Error("Malformed SSE: missing event type");
  }

  if (dataLines.length === 0) {
    throw new Error("Malformed SSE: missing data");
  }

  // Join multi-line data with newline per SSE spec
  const dataStr = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    throw new Error(`Malformed SSE: invalid JSON in data`);
  }

  const event = StepStreamEventSchema.safeParse({
    event: eventType,
    data,
  });

  if (!event.success) {
    throw new Error(
      `Malformed SSE: ${event.error.issues[0]?.message ?? "validation failed"}`
    );
  }

  return event.data;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<StepStreamEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events
      // Events are separated by \n\n and can have \r\n line endings
      const parts = buffer.split(/\r?\n\r?\n/);

      // Keep last incomplete part in buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        yield parseSSEBlock(part);
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      yield parseSSEBlock(buffer);
    }
  } finally {
    // Cancel the reader if we're exiting early (generator return)
    // This prevents memory leaks when consumer stops iteration
    // cancel() returns a promise that rejects if the stream already errored; swallow it.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
