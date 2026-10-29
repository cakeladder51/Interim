import type { StepRequest, Move } from "@/contracts";
import { createRequestRunner, type RunnerDeps } from "./request-runner";
import type { InterviewAction } from "./interview-model";
import { mapBackgroundAction } from "./interview-model";

export function createBackgroundRunner(
  deps: RunnerDeps & { onSettled: (move: Move | null) => void }
): {
  run(request: StepRequest): void;
  abort(): void;
  inFlight(): boolean;
} {
  let active = false;
  let lastMove: Move | null = null;

  const wrapped = (action: InterviewAction): void => {
    if (action.type === "move") {
      lastMove = action.move;
    }
    const m = mapBackgroundAction(action);
    if (m !== null) {
      deps.dispatch(m);
    }
    if (action.type === "done") {
      settle(lastMove);
    } else if (action.type === "failed") {
      settle(null);
    }
  };

  const inner = createRequestRunner({
    ...deps,
    dispatch: wrapped,
  });

  function settle(move: Move | null): void {
    if (!active) return;
    active = false;
    deps.onSettled(move);
  }

  function run(request: StepRequest): void {
    lastMove = null;
    active = true;
    inner.run(request, null);
  }

  function abort(): void {
    if (!active) return;
    inner.abort();
    settle(null);
  }

  function inFlight(): boolean {
    return active;
  }

  return { run, abort, inFlight };
}
