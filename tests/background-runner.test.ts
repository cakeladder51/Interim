import { describe, it, expect } from "vitest";
import { createBackgroundRunner } from "../src/client/background-runner";
import type { RunnerDeps } from "../src/client/request-runner";
import type { StepCallbacks } from "../src/client/step-client";
import type { InterviewAction } from "../src/client/interview-model";
import type { EngineState, StepRequest, Move } from "@/contracts";

function engineState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1,
    configId: "maths-oxbridge",
    styleId: "supportive",
    startedAt: 1000,
    phase: "problem",
    problemIdx: 0,
    hintRung: -1,
    checkpointsHit: [],
    lastInterjectAt: null,
    turnWordBaseline: 0,
    probesAsked: 0,
    transcript: [],
    ...overrides,
  };
}

type Result = { state: EngineState; utterance: string; move: Move; interrupt: boolean };
interface Call {
  request: StepRequest;
  signal: AbortSignal | undefined;
  callbacks: StepCallbacks;
  resolve: (r: Result) => void;
  reject: (e: unknown) => void;
}

// Manually resolved fake runStepRequest + an injected fake timer queue.
function setup(onSettled?: (move: Move | null) => void) {
  const actions: InterviewAction[] = [];
  const settled: (Move | null)[] = [];
  const calls: Call[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let nextId = 0;
  const runStepRequest = ((request: StepRequest, opts?: { signal?: AbortSignal; callbacks?: StepCallbacks }) =>
    new Promise<Result>((resolve, reject) => {
      calls.push({ request, signal: opts?.signal, callbacks: opts?.callbacks ?? {}, resolve, reject });
    })) as RunnerDeps["runStepRequest"];
  const deps: RunnerDeps & { onSettled: (move: Move | null) => void } = {
    dispatch: (a) => actions.push(a),
    runStepRequest,
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    describeError: () => ({ message: "error", retryable: true }),
    onSettled: (m) => {
      settled.push(m);
      onSettled?.(m);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { deps, actions, settled, calls, timers, advance };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const req = (text: string): StepRequest => ({ state: engineState(), event: { type: "partial", text } });
const result = (move: Move, state = engineState()): Result => ({ state, utterance: "", move, interrupt: false });

describe("background-runner", () => {
  it("1. Silent run: bg_request, bg_move{silent}, done, onSettled once with silent", async () => {
    let seen: { actions: string[]; inFlight: boolean } | null = null;
    const s = setup(() => {
      seen = { actions: s.actions.map((a) => a.type), inFlight: runner.inFlight() };
    });
    const runner = createBackgroundRunner(s.deps);
    const request = req("first");
    runner.run(request);
    expect(s.actions).toEqual([{ type: "bg_request", request }]);
    expect(runner.inFlight()).toBe(true);

    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    const finalState = engineState({ checkpointsHit: ["c1"] });
    s.calls[0].resolve(result({ type: "silent" }, finalState));
    await flush();

    expect(s.actions).toEqual([
      { type: "bg_request", request },
      { type: "bg_move", move: { type: "silent" } },
      { type: "done", state: finalState },
    ]);
    expect(s.settled).toEqual([{ type: "silent" }]);
    // onSettled runs after `done` was dispatched, with inFlight() already false.
    expect(seen).toEqual({ actions: ["bg_request", "bg_move", "done"], inFlight: false });
    expect(runner.inFlight()).toBe(false);
  });

  it("2. Spoken run: bg_request, bg_move{realign}, 2 tokens, done, onSettled gets realign", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("x"));
    const move: Move = { type: "realign", misconceptionId: "m1" };
    s.calls[0].callbacks.onMove?.(move, true);
    s.calls[0].callbacks.onToken?.("Hold ");
    s.calls[0].callbacks.onToken?.("on.");
    s.calls[0].resolve(result(move));
    await flush();

    expect(s.actions.map((a) => a.type)).toEqual(["bg_request", "bg_move", "token", "token", "done"]);
    expect(s.actions[1]).toEqual({ type: "bg_move", move });
    expect(s.actions.slice(2, 4)).toEqual([
      { type: "token", text: "Hold " },
      { type: "token", text: "on." },
    ]);
    expect(s.settled).toEqual([move]);
  });

  it("3. slow is never dispatched (advance timer past 6000 ms)", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("x"));
    expect(s.timers.size).toBe(1);
    s.advance(7000);
    expect(s.actions.map((a) => a.type)).toEqual(["bg_request"]);
    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    s.calls[0].resolve(result({ type: "silent" }));
    await flush();
    expect(s.actions.map((a) => a.type)).toEqual(["bg_request", "bg_move", "done"]);
    expect(s.timers.size).toBe(0);
  });

  it("4. Rejection: bg_failed dispatched, onSettled(null) called once", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("x"));
    s.calls[0].reject(new Error("Network error"));
    await flush();

    expect(s.actions.map((a) => a.type)).toEqual(["bg_request", "bg_failed"]);
    expect(s.actions[1]).toEqual({ type: "bg_failed" });
    expect(s.settled).toEqual([null]);
    expect(runner.inFlight()).toBe(false);
  });

  it("5. abort() mid-flight: onSettled(null) called, resolving dispatches nothing more, signal.aborted true", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("x"));
    expect(runner.inFlight()).toBe(true);

    runner.abort();
    expect(s.settled).toEqual([null]);
    expect(runner.inFlight()).toBe(false);
    expect(s.calls[0].signal?.aborted).toBe(true);

    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    s.calls[0].callbacks.onToken?.("late");
    s.calls[0].resolve(result({ type: "silent" }));
    await flush();

    expect(s.actions.map((a) => a.type)).toEqual(["bg_request"]);
    expect(s.settled).toEqual([null]);

    runner.abort();
    expect(s.settled).toEqual([null]);
  });

  it("6. abort() when idle does nothing (no onSettled)", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.abort();
    expect(s.settled).toEqual([]);
    expect(s.actions).toEqual([]);

    runner.run(req("x"));
    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    s.calls[0].resolve(result({ type: "silent" }));
    await flush();
    runner.abort();
    expect(s.settled).toEqual([{ type: "silent" }]);
  });

  it("7. onSettled calling run() synchronously starts second run", async () => {
    let afterRun: boolean | null = null;
    const second = req("second");
    const s = setup((m) => {
      if (m !== null && s.settled.length === 1) {
        runner.run(second);
        afterRun = runner.inFlight();
      }
    });
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("first"));
    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    s.calls[0].resolve(result({ type: "silent" }));
    await flush();

    expect(s.calls).toHaveLength(2);
    expect(afterRun).toBe(true);
    expect(runner.inFlight()).toBe(true);
    expect(s.actions.map((a) => a.type)).toEqual(["bg_request", "bg_move", "done", "bg_request"]);
    expect(s.actions[3]).toEqual({ type: "bg_request", request: second });

    // The first run's late callbacks dispatch nothing.
    s.calls[0].callbacks.onToken?.("late");
    s.calls[0].callbacks.onMove?.({ type: "hint", rung: 0 }, false);
    await flush();
    expect(s.actions).toHaveLength(4);
    expect(s.settled).toEqual([{ type: "silent" }]);

    // The second run settles normally, exactly once.
    s.calls[1].callbacks.onMove?.({ type: "hint", rung: 0 }, false);
    s.calls[1].resolve(result({ type: "hint", rung: 0 }));
    await flush();
    expect(s.settled).toEqual([{ type: "silent" }, { type: "hint", rung: 0 }]);
    expect(runner.inFlight()).toBe(false);
  });

  it("8. model_label action passes through unchanged", async () => {
    const s = setup();
    const runner = createBackgroundRunner(s.deps);
    runner.run(req("x"));
    s.calls[0].callbacks.onMove?.({ type: "silent" }, false);
    s.calls[0].callbacks.onModelLabel?.("fake");
    s.calls[0].resolve(result({ type: "silent" }));
    await flush();

    expect(s.actions.map((a) => a.type)).toEqual(["bg_request", "bg_move", "model_label", "done"]);
    expect(s.actions[2]).toEqual({ type: "model_label", label: "fake" });
  });
});
