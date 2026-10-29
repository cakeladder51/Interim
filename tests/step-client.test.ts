import { describe, it, expect, vi } from "vitest";
import { runStepRequest, StepProtocolError } from "../src/client/step-client";
import { encodeSSE } from "../src/contracts/step-protocol";
import type { StepStreamEvent, EngineState, Move } from "@/contracts";

function createResponse(
  events: StepStreamEvent[],
  status = 200,
  headers: Record<string, string> = {}
): Response {
  const body = events.map((e) => encodeSSE(e)).join("");
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      ...headers,
    },
  });
}

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

describe("runStepRequest", () => {
  it("success: returns state, utterance, move, interrupt; callbacks fire in order", async () => {
    const state = sampleEngineState();
    const move: Move = { type: "intro" };
    const utterance = "Hello, I'm your interviewer today. Let's begin.";

    const events: StepStreamEvent[] = [
      { event: "move", data: { move, interrupt: false } },
      { event: "token", data: { text: "Hello, " } },
      { event: "token", data: { text: "I'm your interviewer today. " } },
      { event: "token", data: { text: "Let's begin." } },
      { event: "done", data: { state, utterance } },
    ];

    const onMove = vi.fn();
    const onToken = vi.fn();
    const onModelLabel = vi.fn();

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const request = { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } };
    const result = await runStepRequest(request, {
      fetchImpl: fakeFetch,
      callbacks: { onMove, onToken, onModelLabel },
    });

    expect(result.state).toEqual(state);
    expect(result.utterance).toBe(utterance);
    expect(result.move).toEqual(move);
    expect(result.interrupt).toBe(false);

    // Callback order: move before tokens
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(move, false);
    expect(onToken).toHaveBeenCalledTimes(3);
    expect(onToken).toHaveBeenNthCalledWith(1, "Hello, ");
    expect(onToken).toHaveBeenCalledWith("I'm your interviewer today. ");
    expect(onToken).toHaveBeenCalledWith("Let's begin.");
    expect(onModelLabel).not.toHaveBeenCalled();

    // Verify request body
    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/step",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify(request),
      })
    );
  });

  // G10: interrupt is correctly returned and passed to onMove
  it("move with interrupt: true → result.interrupt === true and onMove receives true", async () => {
    const state = sampleEngineState();
    const move: Move = { type: "realign", misconceptionId: null };
    const utterance = "Let me realign you.";

    const events: StepStreamEvent[] = [
      { event: "move", data: { move, interrupt: true } },
      { event: "token", data: { text: utterance } },
      { event: "done", data: { state, utterance } },
    ];

    const onMove = vi.fn();
    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const result = await runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, callbacks: { onMove } }
    );

    expect(result.interrupt).toBe(true);
    expect(onMove).toHaveBeenCalledWith(move, true);
  });

  it("x-interim-model header triggers onModelLabel", async () => {
    const state = sampleEngineState();
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "token", data: { text: "Hello" } },
      { event: "done", data: { state, utterance: "Hello" } },
    ];

    const onModelLabel = vi.fn();
    const fakeFetch = vi.fn().mockResolvedValue(
      createResponse(events, 200, { "x-interim-model": "fake" })
    );

    await runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, callbacks: { onModelLabel } }
    );

    expect(onModelLabel).toHaveBeenCalledWith("fake");
  });

  it("uses custom endpoint", async () => {
    const state = sampleEngineState();
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "done", data: { state, utterance: "" } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    await runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, endpoint: "/custom/endpoint" }
    );

    expect(fakeFetch).toHaveBeenCalledWith(
      "/custom/endpoint",
      expect.any(Object)
    );
  });

  // HTTP errors
  it("400 JSON → StepHttpError(400, bad_request, message)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "bad_request", message: "Invalid request" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
      message: "Invalid request",
    });
  });

  it("413 → code payload_too_large", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "payload_too_large", message: "Too large" } }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      )
    );

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  it("500 with non-JSON body → code http_error", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      status: 500,
      code: "http_error",
    });
  });

  it("fetch rejecting with TypeError → StepHttpError(0, network)", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      status: 0,
      code: "network",
    });
  });

  it("fetch rejecting with AbortError → rethrown unchanged", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    const fakeFetch = vi.fn().mockRejectedValue(abortError);

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  // Stream errors
  it("error event first → StepStreamError with code and retryable", async () => {
    const events: StepStreamEvent[] = [
      { event: "error", data: { code: "model_error", message: "Model failed", retryable: true } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      code: "model_error",
      retryable: true,
    });
  });

  // G8: retryable is correctly passed through
  it("error event with retryable: false → StepStreamError.retryable === false", async () => {
    const events: StepStreamEvent[] = [
      { event: "error", data: { code: "bad_request", message: "Bad", retryable: false } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      code: "bad_request",
      retryable: false,
    });
  });

  it("error event with retryable: true → StepStreamError.retryable === true", async () => {
    const events: StepStreamEvent[] = [
      { event: "error", data: { code: "model_error", message: "Model", retryable: true } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      code: "model_error",
      retryable: true,
    });
  });

  it("error after move and tokens → StepStreamError", async () => {
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "token", data: { text: "Hello" } },
      { event: "error", data: { code: "internal", message: "Something went wrong", retryable: true } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toMatchObject({
      code: "internal",
      retryable: true,
    });
  });

  // Protocol violations
  it("token before move → StepProtocolError", async () => {
    const events: StepStreamEvent[] = [
      { event: "token", data: { text: "Hello" } },
    ];

    const onMove = vi.fn();
    const onToken = vi.fn();
    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, callbacks: { onMove, onToken } }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
    // G6: onToken and onMove should never have been called
    expect(onToken).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("done before move → StepProtocolError", async () => {
    const events: StepStreamEvent[] = [
      { event: "done", data: { state: sampleEngineState(), utterance: "" } },
    ];

    const onMove = vi.fn();
    const onToken = vi.fn();
    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, callbacks: { onMove, onToken } }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
    // G6: onToken and onMove should never have been called
    expect(onToken).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("event after done → StepProtocolError", async () => {
    const state = sampleEngineState();
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "done", data: { state, utterance: "" } },
      { event: "token", data: { text: "Extra" } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
  });

  // G7: error after done → StepProtocolError, not StepStreamError
  it("error after done → StepProtocolError, not StepStreamError", async () => {
    const state = sampleEngineState();
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "done", data: { state, utterance: "" } },
      { event: "error", data: { code: "internal", message: "late error", retryable: true } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
  });

  it("stream ends after move with no terminal event → StepProtocolError", async () => {
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("early") });
  });

  it("joined tokens ≠ utterance → StepProtocolError", async () => {
    const state = sampleEngineState();
    const events: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "token", data: { text: "Hello" } },
      { event: "done", data: { state, utterance: "Goodbye" } },
    ];

    const fakeFetch = vi.fn().mockResolvedValue(createResponse(events));

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("utterance") });
  });

  it("malformed SSE data → StepProtocolError", async () => {
    const body = "event: move\ndata: { malformed\n\n";
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    await expect(promise).rejects.toBeInstanceOf(StepProtocolError);
  });

  it("AbortError during reading propagates unchanged", async () => {
    // Simulate abort via signal
    const controller = new AbortController();
    const fakeFetch = vi.fn().mockImplementation(async () => {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      // Throw abort error immediately
      throw abortErr;
    });

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch, signal: controller.signal }
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  // G9: AbortError mid-read propagates unchanged (not wrapped in StepProtocolError)
  it("AbortError from body stream propagates unchanged", async () => {
    // Create a body stream that errors with AbortError
    const abortErr = new Error("Aborted mid-stream");
    abortErr.name = "AbortError";
    
    const bodyStream = new ReadableStream({
      start(controller) {
        // Error immediately when stream is read
        controller.error(abortErr);
      }
    });

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(bodyStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );

    const promise = runStepRequest(
      { state: null, event: { type: "start" as const, configId: "maths-oxbridge", styleId: "supportive" } },
      { fetchImpl: fakeFetch }
    );

    const rejection = await promise.catch((e) => e);
    expect(rejection.name).toBe("AbortError");
    // Verify it's not a StepProtocolError
    expect(rejection).not.toBeInstanceOf(StepProtocolError);
  });
});
