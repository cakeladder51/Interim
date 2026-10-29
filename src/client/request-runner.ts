import type { StepRequest } from "@/contracts";
import type { InterviewAction } from "./interview-model";
import { SLOW_FIRST_TOKEN_MS } from "./interview-model";

export interface RunnerDeps {
  dispatch: (a: InterviewAction) => void;
  runStepRequest: typeof import("./step-client").runStepRequest;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  describeError: (err: unknown) => { message: string; retryable: boolean };
}

interface RunContext {
  token: symbol;
  controller: AbortController;
  slowTimerHandle: unknown;
}

export function createRequestRunner(deps: RunnerDeps): {
  run(request: StepRequest, studentText: string | null): void;
  abort(): void;
  inFlight(): boolean;
} {
  let current: RunContext | null = null;

  function abort(): void {
    if (current === null) return;
    current.controller.abort();
    deps.clearTimer(current.slowTimerHandle);
    // Mark as superseded so no further dispatches happen
    current = null;
  }

  function run(request: StepRequest, studentText: string | null): void {
    // Abort any existing request
    abort();
    current = null;

    // Create new context with unique token
    const token = Symbol("request");
    const controller = new AbortController();
    const slowTimerHandle = deps.setTimer(() => {
      // Only dispatch slow if this run is still current
      if (current?.token === token) {
        deps.dispatch({ type: "slow" });
      }
    }, SLOW_FIRST_TOKEN_MS);

    const ctx: RunContext = { token, controller, slowTimerHandle };
    current = ctx;

    // Dispatch request action
    deps.dispatch({ type: "request", request, studentText });

    // Run the request
    deps.runStepRequest(request, {
      signal: controller.signal,
      callbacks: {
        onMove: (move, interrupt) => {
          void interrupt; // callback signature requires it but not used here
          if (current?.token === token) {
            deps.dispatch({ type: "move", move });
          }
        },
        onToken: (text) => {
          if (current?.token === token) {
            deps.dispatch({ type: "token", text });
          }
        },
        onModelLabel: (label) => {
          if (current?.token === token) {
            deps.dispatch({ type: "model_label", label });
          }
        },
      },
    })
      .then((result) => {
        if (current?.token === token) {
          deps.dispatch({ type: "done", state: result.state });
        }
      })
      .catch((err) => {
        // Only dispatch if this run is still current
        if (current?.token === token) {
          // Ignore AbortError
          if (err instanceof Error && err.name === "AbortError") {
            return;
          }
          const { message, retryable } = deps.describeError(err);
          deps.dispatch({ type: "failed", message, retryable });
        }
      })
      .finally(() => {
        // Only clear timer and reset if this run is still current
        if (current?.token === token) {
          deps.clearTimer(slowTimerHandle);
          current = null;
        }
      });
  }

  function inFlight(): boolean {
    return current !== null;
  }

  return { run, abort, inFlight };
}
