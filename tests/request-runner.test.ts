import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequestRunner } from "../src/client/request-runner";
import { SLOW_FIRST_TOKEN_MS } from "../src/client/interview-model";
import type { StepRequest, EngineState, Move } from "@/contracts";
import type { StepCallbacks } from "../src/client/step-client";

function sampleEngineState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1 as const,
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

// Helper to flush all microtasks
async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("request-runner", () => {
  let dispatch: ReturnType<typeof vi.fn>;
  let setTimer: ReturnType<typeof vi.fn>;
  let clearTimer: ReturnType<typeof vi.fn>;
  let describeError: ReturnType<typeof vi.fn>;
  let deferreds: {
    resolve: (value: { state: EngineState; utterance: string; move: Move; interrupt: boolean }) => void;
    reject: (reason: unknown) => void;
  }[];
  let slowTimerCallback: (() => void) | null;

  beforeEach(() => {
    dispatch = vi.fn();
    slowTimerCallback = null;

    setTimer = vi.fn((fn: () => void, ms: number) => {
      void ms; // param required by type signature but unused in mock
      slowTimerCallback = fn;
      return "timer-handle";
    });

    clearTimer = vi.fn();

    describeError = vi.fn((err: unknown) => {
      if (err instanceof Error && err.message === "test-error") {
        return { message: "Test error", retryable: true };
      }
      return { message: "Unknown error", retryable: false };
    });

    deferreds = [];
  });

  function createFakeRunStepRequest() {
    return vi.fn(async (request: StepRequest, opts?: { signal?: AbortSignal; callbacks?: StepCallbacks }) => {
      void request;
      void opts;
      return new Promise<{ state: EngineState; utterance: string; move: Move; interrupt: boolean }>((resolve, reject) => {
        deferreds.push({ resolve, reject });
      });
    });
  }

  // Test 1: Normal run - dispatch order is request, move, token(s), done. Timer cleared on success.
  it("normal run: dispatch order is request, move, token(s), done; timer cleared on success", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };

    expect(runner.inFlight()).toBe(false);
    runner.run(request, null);
    expect(runner.inFlight()).toBe(true);

    // Check request action dispatched
    expect(dispatch).toHaveBeenCalledWith({ type: "request", request, studentText: null });

    // Check timer started
    expect(setTimer).toHaveBeenCalled();

    // Simulate callbacks from runStepRequest
    const opts = fakeRunStepRequest.mock.calls[0][1];
    opts?.callbacks?.onMove?.({ type: "intro" }, false);
    opts?.callbacks?.onToken?.("Hello");
    opts?.callbacks?.onModelLabel?.("fake");

    expect(dispatch).toHaveBeenCalledWith({ type: "move", move: { type: "intro" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "token", text: "Hello" });
    expect(dispatch).toHaveBeenCalledWith({ type: "model_label", label: "fake" });

    // Resolve the promise
    const state = sampleEngineState();
    deferreds[0].resolve({ state, utterance: "Hello", move: { type: "intro" }, interrupt: false });

    // Wait for promise to settle
    await flush();

    expect(dispatch).toHaveBeenCalledWith({ type: "done", state });
    expect(clearTimer).toHaveBeenCalledWith("timer-handle");
    expect(runner.inFlight()).toBe(false);
  });

  // Test 2: Slow - no token before SLOW_FIRST_TOKEN_MS, slow is dispatched once
  it("slow: with no token before SLOW_FIRST_TOKEN_MS, slow is dispatched once", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    // Fire slow timer callback
    expect(slowTimerCallback).not.toBeNull();
    slowTimerCallback!();

    expect(dispatch).toHaveBeenCalledWith({ type: "slow" });

    // Resolve
    const state = sampleEngineState();
    deferreds[0].resolve({ state, utterance: "", move: { type: "intro" }, interrupt: false });
    await flush();

    expect(clearTimer).toHaveBeenCalled();
  });

  // Test 3: Failure - failed is dispatched with describeError's output. AbortError dispatches nothing.
  it("failure: failed is dispatched with describeError's output", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    // Reject with a non-abort error
    const testError = new Error("test-error");
    deferreds[0].reject(testError);

    await flush();

    expect(describeError).toHaveBeenCalledWith(testError);
    expect(dispatch).toHaveBeenCalledWith({ type: "failed", message: "Test error", retryable: true });
    expect(clearTimer).toHaveBeenCalled();
    expect(runner.inFlight()).toBe(false);
  });

  it("AbortError dispatches nothing", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    // Clear dispatch calls from the run
    dispatch.mockClear();

    // Reject with AbortError
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    deferreds[0].reject(abortError);

    await flush();

    // Only clearTimer should be called, no failed dispatch
    expect(dispatch).not.toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalled();
  });

  // Test 4: Supersede - start run A, then run B. A later resolves/rejects/fires callbacks. Nothing from A dispatched.
  it("supersede: A's callbacks dispatch nothing after B starts", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    // Run A
    const requestA: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(requestA, null);

    expect(fakeRunStepRequest).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(runner.inFlight()).toBe(true);

    // Run B (supersedes A)
    const requestB: StepRequest = { state: sampleEngineState(), event: { type: "turn_complete", text: "test", source: "typed" } };
    runner.run(requestB, "test");

    // A's abort was called, clearing its timer
    expect(clearTimer).toHaveBeenCalledWith("timer-handle");

    expect(fakeRunStepRequest).toHaveBeenCalledTimes(2);
    expect(setTimer).toHaveBeenCalledTimes(2); // timer for both runs
    expect(runner.inFlight()).toBe(true);

    // Clear dispatch so we can check A's callbacks specifically
    dispatch.mockClear();

    // Fire A's callbacks - should dispatch nothing
    const optsA = fakeRunStepRequest.mock.calls[0][1];
    optsA?.callbacks?.onMove?.({ type: "intro" }, false);
    optsA?.callbacks?.onToken?.("A");
    optsA?.callbacks?.onModelLabel?.("A");

    expect(dispatch).not.toHaveBeenCalled();

    // B's slow timer should still work (the second timer)
    slowTimerCallback!();
    expect(dispatch).toHaveBeenCalledWith({ type: "slow" });

    // Resolve A - should dispatch nothing
    const stateA = sampleEngineState({ phase: "done" });
    deferreds[0].resolve({ state: stateA, utterance: "A", move: { type: "intro" }, interrupt: false });

    await flush();

    // Should not dispatch done for A
    expect(dispatch).not.toHaveBeenCalledWith({ type: "done", state: stateA });

    // B should still be in flight
    expect(runner.inFlight()).toBe(true);

    // Resolve B
    const stateB = sampleEngineState();
    deferreds[1].resolve({ state: stateB, utterance: "", move: { type: "acknowledge" }, interrupt: false });

    await flush();

    expect(dispatch).toHaveBeenCalledWith({ type: "done", state: stateB });
    expect(runner.inFlight()).toBe(false);
  });

  it("supersede: A rejects - nothing dispatched", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    // Run A
    const requestA: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(requestA, null);

    // Run B (supersedes A)
    const requestB: StepRequest = { state: sampleEngineState(), event: { type: "turn_complete", text: "test", source: "typed" } };
    runner.run(requestB, "test");

    dispatch.mockClear();

    // Reject A (not AbortError)
    deferreds[0].reject(new Error("test-error"));

    await flush();

    // A's rejection should not dispatch
    expect(dispatch).not.toHaveBeenCalled();

    // Resolve B to clean up
    deferreds[1].resolve({ state: sampleEngineState(), utterance: "", move: { type: "acknowledge" }, interrupt: false });
    await flush();
  });

  // Test 5: abort() - clears the current timer, and the aborted run dispatches nothing afterwards
  it("abort(): clears current timer and aborted run dispatches nothing", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    // Check signal is passed
    const opts = fakeRunStepRequest.mock.calls[0][1];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.signal?.aborted).toBe(false);

    // Clear previous calls
    dispatch.mockClear();
    clearTimer.mockClear();

    // Abort
    runner.abort();

    expect(clearTimer).toHaveBeenCalledWith("timer-handle");
    
    // Try to dispatch callbacks after abort - should do nothing since current is null
    opts?.callbacks?.onMove?.({ type: "intro" }, false);
    opts?.callbacks?.onToken?.("after");
    opts?.callbacks?.onModelLabel?.("after");

    expect(dispatch).not.toHaveBeenCalled();

    // Resolve - should dispatch nothing
    deferreds[0].resolve({ state: sampleEngineState(), utterance: "", move: { type: "intro" }, interrupt: false });

    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    expect(runner.inFlight()).toBe(false);
  });

  it("inFlight() is true during run and false after", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    expect(runner.inFlight()).toBe(false);

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    expect(runner.inFlight()).toBe(true);

    // Resolve
    deferreds[0].resolve({ state: sampleEngineState(), utterance: "", move: { type: "intro" }, interrupt: false });
    await flush();

    expect(runner.inFlight()).toBe(false);
  });

  // R1: Superseded and aborted requests must have their signals cancelled
  it("R1: supersede aborts previous request's signal", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    // Run A - capture its signal
    const requestA: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(requestA, null);
    const optsA = fakeRunStepRequest.mock.calls[0][1];
    const signalA = optsA?.signal;
    expect(signalA).toBeInstanceOf(AbortSignal);
    expect(signalA?.aborted).toBe(false);

    // Run B (supersedes A) - capture its signal
    const requestB: StepRequest = { state: sampleEngineState(), event: { type: "turn_complete", text: "test", source: "typed" } };
    runner.run(requestB, "test");
    const optsB = fakeRunStepRequest.mock.calls[1][1];
    const signalB = optsB?.signal;

    // R1: A's signal must be aborted, B's must not
    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);

    // Cleanup
    deferreds[1].resolve({ state: sampleEngineState(), utterance: "", move: { type: "acknowledge" }, interrupt: false });
    await flush();
  });

  it("R1: abort() cancels current request's signal", async () => {
    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    // Run a request - capture its signal
    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);
    const opts = fakeRunStepRequest.mock.calls[0][1];
    const signal = opts?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    // Abort
    runner.abort();

    // R1: The signal must be aborted
    expect(signal?.aborted).toBe(true);
  });

  // R2: The slow timer threshold must be pinned to 6000ms
  it("R2: setTimer is called with exactly 6000ms (SLOW_FIRST_TOKEN_MS)", async () => {
    // Pin the constant value
    expect(SLOW_FIRST_TOKEN_MS).toBe(6000);

    const fakeRunStepRequest = createFakeRunStepRequest();

    const runner = createRequestRunner({
      dispatch,
      runStepRequest: fakeRunStepRequest,
      setTimer,
      clearTimer,
      describeError,
    });

    const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
    runner.run(request, null);

    // R2: setTimer must be called with exactly 6000ms, not any other value
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 6000);

    // Cleanup
    deferreds[0].resolve({ state: sampleEngineState(), utterance: "", move: { type: "intro" }, interrupt: false });
    await flush();
  });
});
