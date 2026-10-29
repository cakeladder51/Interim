import type { EngineState } from "@/contracts";
import { FeedbackViewSchema, type FeedbackView } from "@/shared/feedback-protocol";

export class FeedbackError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryable: boolean
  ) {
    super(code);
    this.name = "FeedbackError";
  }
}

/**
 * Fetch feedback from the server.
 */
export async function fetchFeedback(
  state: EngineState,
  opts?: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    endpoint?: string;
  }
): Promise<FeedbackView> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const endpoint = opts?.endpoint ?? "/api/feedback";

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
      signal: opts?.signal,
    });
  } catch (err) {
    // C1: Rethrow abort errors unchanged
    if (opts?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
    // C1: Network error
    throw new FeedbackError(0, "network", true);
  }

  // C2: Non-OK response
  if (!response.ok) {
    let code = "http";
    try {
      const body = (await response.json()) as unknown;
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as Record<string, unknown>).error === "object" &&
        (body as Record<string, unknown>).error !== null
      ) {
        const error = (body as Record<string, unknown>).error as Record<string, unknown>;
        if (typeof error.code === "string") {
          code = error.code;
        }
      }
    } catch {
      // Can't read body, use default code
    }
    throw new FeedbackError(response.status, code, response.status >= 500);
  }

  // C3: Parse body
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FeedbackError(response.status, "protocol", true);
  }

  const result = FeedbackViewSchema.safeParse(body);
  if (!result.success) {
    throw new FeedbackError(response.status, "protocol", true);
  }

  return result.data;
}

/**
 * Describe a feedback error to the user.
 */
export function describeFeedbackError(err: unknown): {
  message: string;
  retryable: boolean;
} {
  if (err instanceof FeedbackError) {
    if (err.status === 400 || err.status === 413) {
      return {
        message: "This interview can't be scored.",
        retryable: false,
      };
    }
  }
  return {
    message: "We couldn't prepare your feedback. Please try again.",
    retryable: true,
  };
}

/**
 * Format milliseconds to a minutes:seconds string.
 */
export function formatAt(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type FeedbackSnapshot =
  | { status: "loading" }
  | { status: "ready"; view: FeedbackView }
  | { status: "failed"; message: string; retryable: boolean };

/**
 * Create a feedback runner to manage the feedback fetch lifecycle.
 */
export function createFeedbackRunner(deps: {
  fetchFeedback: (state: EngineState, signal: AbortSignal) => Promise<FeedbackView>;
  onChange: (s: FeedbackSnapshot) => void;
}): { start(state: EngineState): void; retry(): void; abort(): void } {
  let lastState: EngineState | null = null;
  let currentRun: { controller: AbortController; token: symbol } | null = null;

  const start = (state: EngineState) => {
    // R3: Abort any current run first
    if (currentRun !== null) {
      currentRun.controller.abort();
      currentRun = null;
    }

    // R1: Store state and start new run
    lastState = state;
    const controller = new AbortController();
    const token = Symbol();
    currentRun = { controller, token };

    // R1: Don't call onChange here - component starts in loading
    // R6: Attach rejection handler immediately
    deps.fetchFeedback(state, controller.signal).then(
      (view) => {
        // R2: Only if still current
        if (currentRun?.token !== token) return;
        currentRun = null;
        deps.onChange({ status: "ready", view });
      },
      (err) => {
        // R4: Only if still current
        if (currentRun?.token !== token) return;
        currentRun = null;

        // R4: Ignore abort
        if (err instanceof Error && err.name === "AbortError") return;

        const { message, retryable } = describeFeedbackError(err);
        deps.onChange({ status: "failed", message, retryable });
      }
    );
  };

  const abort = () => {
    // R3: Abort if running
    if (currentRun !== null) {
      currentRun.controller.abort();
      currentRun = null;
    }
  };

  const retry = () => {
    // R5: Need state and no current run
    if (lastState === null || currentRun !== null) return;

    deps.onChange({ status: "loading" });
    start(lastState);
  };

  return { start, retry, abort };
}
