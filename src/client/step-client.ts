import type { StepRequest, EngineState, Move } from "@/contracts";
import { parseSSE } from "@/contracts/step-protocol";

export class StepHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "StepHttpError";
  }
}

export class StepStreamError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "StepStreamError";
  }
}

export class StepProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepProtocolError";
  }
}

export interface StepCallbacks {
  onMove?: (move: Move, interrupt: boolean) => void;
  onToken?: (text: string) => void;
  onModelLabel?: (label: string) => void;
}

/**
 * Execute a step request and handle the SSE stream.
 * Throws StepHttpError for HTTP errors, StepStreamError for stream errors,
 * and StepProtocolError for protocol violations.
 */
export async function runStepRequest(
  request: StepRequest,
  opts?: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    endpoint?: string;
    callbacks?: StepCallbacks;
  }
): Promise<{
  state: EngineState;
  utterance: string;
  move: Move;
  interrupt: boolean;
}> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const endpoint = opts?.endpoint ?? "/api/step";

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: opts?.signal,
    });
  } catch (err) {
    // Rethrow AbortError unchanged
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new StepHttpError(0, "network", "Network error");
  }

  // Handle non-2xx responses
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StepHttpError(
        response.status,
        "http_error",
        `HTTP ${response.status}`
      );
    }
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as Record<string, unknown>).error === "object" &&
      (body as Record<string, unknown>).error !== null
    ) {
      const error = (body as Record<string, unknown>).error as Record<string, unknown>;
      const code = typeof error.code === "string" ? error.code : "http_error";
      const message = typeof error.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new StepHttpError(response.status, code, message);
    }
    throw new StepHttpError(
      response.status,
      "http_error",
      `HTTP ${response.status}`
    );
  }

  // Call onModelLabel if header present
  const modelLabel = response.headers.get("x-interim-model");
  if (modelLabel !== null) {
    opts?.callbacks?.onModelLabel?.(modelLabel);
  }

  // Parse SSE stream
  let move: Move | null = null;
  let interrupt = false;
  const tokens: string[] = [];
  let state: EngineState | null = null;
  let utterance = "";
  let streamEnded = false;

  try {
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      // Check for early events
      if (event.event === "token" || event.event === "done") {
        if (move === null) {
          throw new StepProtocolError("token or done before move");
        }
      }

      // Check for events after done
      if (streamEnded && event.event !== "error") {
        throw new StepProtocolError("event after done");
      }

      switch (event.event) {
        case "move":
          move = event.data.move;
          interrupt = event.data.interrupt;
          opts?.callbacks?.onMove?.(move, interrupt);
          break;
        case "token":
          tokens.push(event.data.text);
          opts?.callbacks?.onToken?.(event.data.text);
          break;
        case "done":
          streamEnded = true;
          state = event.data.state;
          utterance = event.data.utterance;
          // Verify token concatenation
          if (tokens.join("") !== utterance) {
            throw new StepProtocolError(
              "joined tokens do not equal utterance"
            );
          }
          // Check stream ends here (no more events allowed)
          break;
        case "error":
          // If we already got done events, this is a protocol error
          if (streamEnded) {
            throw new StepProtocolError("error after done");
          }
          throw new StepStreamError(
            event.data.code,
            event.data.retryable,
            event.data.message
          );
      }
    }
  } catch (err) {
    // Rethrow AbortError unchanged
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    // Rethrow our own errors
    if (
      err instanceof StepStreamError ||
      err instanceof StepProtocolError
    ) {
      throw err;
    }
    // Wrap parse errors
    throw new StepProtocolError(
      err instanceof Error ? err.message : "Stream parse error"
    );
  }

  // Check stream ended properly
  if (!streamEnded) {
    throw new StepProtocolError("Stream ended early");
  }

  // move should exist at this point
  if (move === null) {
    throw new StepProtocolError("No move received");
  }

  return {
    state: state!,
    utterance,
    move,
    interrupt,
  };
}
