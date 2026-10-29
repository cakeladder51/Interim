import "server-only";

import type { OpenAI } from "openai";
import type {
  EngineState,
  EngineEvent,
  InterviewConfig,
  Style,
  StepStreamEvent,
} from "@/contracts";
import { StepRequestSchema } from "@/contracts";
import { getConfig, getStyle, ConfigError } from "@/config/load";
import { createInitialState, appendTranscript } from "@/engine/state";
import { decide, shouldAssess } from "@/engine/fsm";
import type { DecideEvent, SpeakReason } from "@/engine/types";
import { encodeSSE } from "@/contracts/step-protocol";

export interface StepDeps {
  assess: (args: {
    config: InterviewConfig;
    style: Style;
    state: EngineState;
    event: Extract<DecideEvent, { type: "partial" | "turn_complete" | "canvas" }>;
    signal?: AbortSignal;
    client?: OpenAI;
  }) => Promise<import("@/contracts").Assessment | null>;
  speak: (args: {
    config: InterviewConfig;
    style: Style;
    state: EngineState;
    move: Exclude<import("@/contracts").Move, { type: "silent" }>;
    interrupt: boolean;
    reason: SpeakReason;
    studentText: string | null;
    signal?: AbortSignal;
    client?: OpenAI;
  }) => AsyncIterable<string>;
  now: () => number;
  modelLabel?: string;
}

export const MAX_BODY_BYTES = 2_000_000;

/**
 * Create a step handler that can be used as a Next.js route POST handler.
 */
export function createStepHandler(deps: StepDeps): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    // Check content-length first
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({
          error: {
            code: "payload_too_large",
            message: `Request body too large (max ${MAX_BODY_BYTES} bytes)`,
          },
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Parse JSON body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "Invalid JSON" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate request schema
    const parseResult = StepRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            message: parseResult.error.issues[0]?.message ?? "Invalid request",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const { state, event } = parseResult.data;
    const signal = request.signal;

    // For non-start events, state must be non-null (validated by schema)
    // We use a type assertion after the schema check
    const currentState = state as EngineState | null;

    // Resolve config and style
    let config: InterviewConfig;
    let style: Style;

    try {
      if (event.type === "start") {
        config = getConfig(event.configId);
        style = getStyle(config, event.styleId);
      } else {
        // state is non-null for non-start events (enforced by schema)
        config = getConfig(currentState!.configId);
        style = getStyle(config, currentState!.styleId);

        // Check problemIdx range
        if (currentState!.problemIdx >= config.problems.length) {
          return new Response(
            JSON.stringify({
              error: {
                code: "bad_request",
                message: `problemIdx out of range: ${currentState!.problemIdx}`,
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        return new Response(
          JSON.stringify({
            error: { code: "bad_request", message: err.message },
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      throw err;
    }

    // Track closed state for stream
    let closed = false;

    // Create SSE stream
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (e: StepStreamEvent): boolean => {
          if (closed || signal.aborted) return false;
          try {
            controller.enqueue(encoder.encode(encodeSSE(e)));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

        // Handle abort
        signal.addEventListener("abort", () => {
          close();
        });

        try {
          for await (const streamEvent of runStep(
            { state, event, config, style },
            deps,
            signal
          )) {
            if (closed || signal.aborted) break;
            if (!sendEvent(streamEvent)) break;
          }
        } catch (err) {
          // Log error server-side
          console.error("Step error:", err);

          // Send error event if no event was sent yet, or after move but before done
          if (!closed && !signal.aborted) {
            sendEvent({
              event: "error",
              data: {
                code: "internal",
                message: "Step failed",
                retryable: true,
              },
            });
          }
        } finally {
          close();
        }
      },
      cancel() {
        closed = true;
      },
    });

    const headers: HeadersInit = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    };
    if (deps.modelLabel !== undefined) {
      headers["X-Interim-Model"] = deps.modelLabel;
    }

    return new Response(stream, { headers });
  };
}

/**
 * Run a step and yield stream events.
 */
export async function* runStep(
  input: {
    state: EngineState | null;
    event: EngineEvent;
    config: InterviewConfig;
    style: Style;
  },
  deps: StepDeps,
  signal: AbortSignal
): AsyncGenerator<StepStreamEvent> {
  const { event, config, style } = input;
  const now = deps.now();

  // === START EVENT ===
  if (event.type === "start") {
    let state = createInitialState(config.id, style.id, now);

    // Yield move
    yield {
      event: "move",
      data: { move: { type: "intro" }, interrupt: false },
    };

    // Stream speak
    const chunks: string[] = [];
    for await (const chunk of deps.speak({
      config,
      style,
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
      signal,
    })) {
      if (signal.aborted) return;
      chunks.push(chunk);
      yield { event: "token", data: { text: chunk } };
    }

    const utterance = chunks.join("");

    // Append interviewer entry (only if non-empty)
    if (utterance) {
      state = appendTranscript(state, {
        at: 0,
        speaker: "interviewer",
        kind: "utterance",
        text: utterance,
      });
    }

    // Update phase to problem
    state = { ...state, phase: "problem" };

    // Yield done
    yield { event: "done", data: { state, utterance } };
    return;
  }

  // === NON-START EVENTS ===
  let state = input.state!;

  // Keep pre state for assess
  const pre = state;

  // Append student entry for turn_complete
  if (event.type === "turn_complete") {
    const kind = event.source === "typed" ? "typed" : "utterance";
    const at = now - state.startedAt;
    state = appendTranscript(state, {
      at,
      speaker: "student",
      kind,
      text: event.text,
    });
  }

  // Calculate assessment
  let assessment: import("@/contracts").Assessment | null = null;

  // Check if we should assess
  const shouldCallAssess = shouldAssess(pre, event as DecideEvent, config, style, now);

  if (shouldCallAssess) {
    // Only partial, turn_complete, canvas events pass shouldAssess
    if (
      event.type === "partial" ||
      event.type === "turn_complete" ||
      event.type === "canvas"
    ) {
      assessment = await deps.assess({
        config,
        style,
        state: pre,
        event,
        signal,
      });
      if (signal.aborted) return;
    }
  }

  // Decide
  const result = decide({
    state,
    event: event as DecideEvent,
    assessment,
    config,
    style,
    now,
  });

  // Yield move
  yield {
    event: "move",
    data: { move: result.move, interrupt: result.interrupt },
  };

  // Handle silent move
  if (result.move.type === "silent") {
    yield { event: "done", data: { state: result.state, utterance: "" } };
    return;
  }

  // Stream speak
  const studentText =
    event.type === "turn_complete" || event.type === "partial" ? event.text : null;

  const chunks: string[] = [];
  for await (const chunk of deps.speak({
    config,
    style,
    state: result.state,
    move: result.move,
    interrupt: result.interrupt,
    reason: result.reason,
    studentText,
    signal,
  })) {
    if (signal.aborted) return;
    chunks.push(chunk);
    yield { event: "token", data: { text: chunk } };
  }

  const utterance = chunks.join("");

  // Append interviewer entry (only if non-empty)
  let finalState = result.state;
  if (utterance) {
    const kind = result.interrupt ? "interjection" : "utterance";
    const at = now - result.state.startedAt;
    finalState = appendTranscript(finalState, {
      at,
      speaker: "interviewer",
      kind,
      text: utterance,
    });
  }

  // Yield done
  yield { event: "done", data: { state: finalState, utterance } };
}
