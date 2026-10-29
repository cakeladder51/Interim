import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseSSE } from "../src/contracts/step-protocol";
import type { StepStreamEvent, EngineState, Assessment } from "@/contracts";
import { createStepHandler } from "../src/server/step-handler";
import { getConfig, getStyle } from "../src/config/load";

// Mock env
vi.mock("../src/lib/env", () => ({
  getServerEnv: vi.fn(() => ({
    MODEL_API_KEY: "test-key",
    META_MODEL: "muse-spark-1.3",
  })),
}));

const config = getConfig("maths-oxbridge");
const style = getStyle(config, "supportive");

function createRequest(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

/**
 * Helper to validate stream invariant:
 * One move first, then tokens, then exactly one terminal done or error.
 * Tokens joined === done utterance.
 */
function expectValidStream(events: StepStreamEvent[]) {
  expect(events.length, "Stream must have at least one event").toBeGreaterThan(0);

  // First event must be move
  expect(events[0].event).toBe("move");

  // Find terminal event (done or error)
  const terminalIdx = events.findIndex((e) => e.event === "done" || e.event === "error");
  expect(terminalIdx, "Must have a terminal event").toBeGreaterThan(-1);

  // Exactly one terminal (it should be the last)
  expect(terminalIdx).toBe(events.length - 1);

  const terminal = events[terminalIdx];

  if (terminal.event === "done") {
    // Check tokens concatenated === utterance
    const tokens = events
      .filter((e) => e.event === "token")
      .map((e) => (e as { event: "token"; data: { text: string } }).data.text);
    const utterance = terminal.data.utterance;
    expect(tokens.join("")).toBe(utterance);

    // Between move and done, all events must be tokens
    for (let i = 1; i < terminalIdx; i++) {
      expect(events[i].event).toBe("token");
    }
  }
}

function makeState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1,
    configId: config.id,
    styleId: style.id,
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

describe("step-handler", () => {
  it("start: move intro, chunks as utterance, phase problem, transcript has interviewer at 0", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
      yield " there";
    });
    const now = vi.fn(() => 1000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("X-Interim-Stub")).toBeNull();

    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    expect(events[0]).toEqual({
      event: "move",
      data: { move: { type: "intro" }, interrupt: false },
    });

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    if (done?.event === "done") {
      expect(done.data.state.phase).toBe("problem");
      expect(done.data.utterance).toBe("Hello there");
      expect(done.data.state.transcript).toHaveLength(1);
      expect(done.data.state.transcript[0].speaker).toBe("interviewer");
      expect(done.data.state.transcript[0].at).toBe(0);
    }

    // assess shouldn't be called for start
    expect(fakeAssess).not.toHaveBeenCalled();
    // speak should be called with reason "intro"
    expect(fakeSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "intro" })
    );
  });

  // T4.1: Non-zero at values
  it("turn_complete (typed): student and interviewer have correct non-zero at values", async () => {
    const startedAt = 1_000_000;
    const nowTime = 1_007_500;
    const now = vi.fn(() => nowTime);

    const fakeAssess = vi.fn().mockResolvedValue({
      status: "progressing",
      confidence: 0.5,
      checkpointsHit: [] as string[],
      misconceptionId: null,
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      yield "Good";
      yield " work";
    });

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState({ startedAt });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "My answer", source: "typed" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    if (done?.event === "done") {
      const transcript = done.data.state.transcript;
      // Student entry
      const studentEntry = transcript.find((e) => e.speaker === "student");
      expect(studentEntry).toBeDefined();
      expect(studentEntry?.kind).toBe("typed");
      expect(studentEntry?.text).toBe("My answer");
      expect(studentEntry?.at).toBe(7500); // now - startedAt

      // Interviewer entry
      const interviewerEntry = transcript.find((e) => e.speaker === "interviewer");
      expect(interviewerEntry).toBeDefined();
      expect(interviewerEntry?.at).toBe(7500); // now - startedAt
    }

    // assess should be called with pre-append state
    expect(fakeAssess).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ transcript: [] }),
      })
    );

    // speak should get studentText
    expect(fakeSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ studentText: "My answer" })
    );
  });

  it("turn_complete (voice): student entry has kind utterance", async () => {
    const fakeAssess = vi.fn().mockResolvedValue({
      status: "progressing",
      confidence: 0.5,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      yield "Good";
    });

    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState();
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "My answer", source: "voice" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const done = events.find((e) => e.event === "done");
    if (done?.event === "done") {
      const studentEntry = done.data.state.transcript.find((e) => e.speaker === "student");
      expect(studentEntry?.kind).toBe("utterance");
    }
  });

  it("gated partial: assess not called, move silent, done utterance empty, speak not called, transcript unchanged", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn();
    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    // Too few words for minNewWords (12)
    const state = makeState({ turnWordBaseline: 0 });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "partial", text: "thinking" }, // 1 word, less than 12
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    expect(events[0]).toEqual({
      event: "move",
      data: { move: { type: "silent" }, interrupt: false },
    });

    const done = events.find((e) => e.event === "done");
    if (done?.event === "done") {
      expect(done.data.utterance).toBe("");
      expect(done.data.state.transcript).toHaveLength(0);
    }

    expect(fakeAssess).not.toHaveBeenCalled();
    expect(fakeSpeak).not.toHaveBeenCalled();
  });

  // T4.2: Check studentText for partials
  it("interjection partial: enough words, assess returns off_track at 0.9, speak gets studentText equal to partial's text", async () => {
    const fakeAssess = vi.fn().mockResolvedValue({
      status: "off_track",
      confidence: 0.9,
      checkpointsHit: [],
      misconceptionId: "lowest-terms-missing",
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      yield "Hold on";
    });

    const now = vi.fn(() => 1000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    // Enough words, cooldown elapsed
    const partialText = "one two three four five six seven eight nine ten eleven twelve thirteen";
    const state = makeState({
      startedAt: 0,
      lastInterjectAt: null,
      turnWordBaseline: 0,
    });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "partial", text: partialText },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    // Move should be realign with interrupt
    const moveEvent = events[0];
    expect(moveEvent.event).toBe("move");
    if (moveEvent.event === "move") {
      expect(moveEvent.data.move.type).toBe("realign");
      expect(moveEvent.data.interrupt).toBe(true);
    }

    // Interviewer entry should be kind interjection
    const done = events.find((e) => e.event === "done");
    if (done?.event === "done") {
      const interviewerEntry = done.data.state.transcript.find(
        (e) => e.speaker === "interviewer"
      );
      expect(interviewerEntry?.kind).toBe("interjection");
    }

    // speak should be called with interrupt: true and studentText equals partial's text
    expect(fakeSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ interrupt: true, studentText: partialText })
    );
  });

  // T4.2: Check studentText: null for silence
  it("silence >= threshold: hint given, assess not called, speak gets studentText: null", async () => {
    const startedAt = 1_000_000;
    const nowTime = 1_010_000; // 10 seconds later, under 25 minute limit
    const now = vi.fn(() => nowTime);

    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hint";
    });

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState({ startedAt });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "silence", ms: 25000 }, // > silenceStuckMs (20000)
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const moveEvent = events[0];
    expect(moveEvent.event).toBe("move");
    if (moveEvent.event === "move") {
      expect(moveEvent.data.move.type).toBe("hint");
    }

    expect(fakeAssess).not.toHaveBeenCalled();

    // speak should get studentText: null for silence
    expect(fakeSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ studentText: null })
    );
  });

  it("assess returns null on turn_complete: move acknowledge with reason assessor_unavailable", async () => {
    const startedAt = 1_000_000;
    const nowTime = 1_010_000; // Under 25 minute limit
    const now = vi.fn(() => nowTime);

    const fakeAssess = vi.fn().mockResolvedValue(null);
    const fakeSpeak = vi.fn(async function* () {
      yield "Fallback";
    });

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState({ startedAt });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "My answer", source: "voice" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const moveEvent = events[0];
    expect(moveEvent.event).toBe("move");
    if (moveEvent.event === "move") {
      expect(moveEvent.data.move.type).toBe("acknowledge");
    }

    // speak should be called with reason "assessor_unavailable"
    expect(fakeSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "assessor_unavailable" })
    );
  });

  it("end in problem phase: wrap_up, phase becomes done", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Thank you";
    });
    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState();
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "end" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const moveEvent = events[0];
    expect(moveEvent.event).toBe("move");
    if (moveEvent.event === "move") {
      expect(moveEvent.data.move.type).toBe("wrap_up");
    }

    const done = events.find((e) => e.event === "done");
    if (done?.event === "done") {
      expect(done.data.state.phase).toBe("done");
    }
  });

  describe("400 cases", () => {
    const makeHandler = () => {
      const fakeAssess = vi.fn();
      const fakeSpeak = vi.fn();
      const now = vi.fn(() => Date.now());
      return createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });
    };

    it("invalid JSON returns 400", async () => {
      const handler = makeHandler();
      const request = new Request("http://localhost/api/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }) as NextRequest;

      const response = await handler(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("bad_request");
    });

    it("schema failure returns 400", async () => {
      const handler = makeHandler();
      const request = createRequest("http://localhost/api/step", {
        state: null,
        event: { type: "partial" }, // missing text
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("unknown configId on start returns 400", async () => {
      const handler = makeHandler();
      const request = createRequest("http://localhost/api/step", {
        state: null,
        event: { type: "start", configId: "unknown", styleId: style.id },
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("bad_request");
    });

    it("unknown styleId on start returns 400", async () => {
      const handler = makeHandler();
      const request = createRequest("http://localhost/api/step", {
        state: null,
        event: { type: "start", configId: config.id, styleId: "unknown" },
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("unknown configId in state returns 400", async () => {
      const handler = makeHandler();
      const state = makeState({ configId: "unknown" });
      const request = createRequest("http://localhost/api/step", {
        state,
        event: { type: "partial", text: "test" },
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("problemIdx out of range returns 400", async () => {
      const handler = makeHandler();
      const state = makeState({ problemIdx: 999 });
      const request = createRequest("http://localhost/api/step", {
        state,
        event: { type: "partial", text: "test" },
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("content-length > 2MB returns 413", async () => {
      const handler = makeHandler();
      const request = new Request("http://localhost/api/step", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-length": "3000000",
        },
        body: JSON.stringify({ state: null, event: { type: "start", configId: config.id, styleId: style.id } }),
      }) as NextRequest;

      const response = await handler(request);
      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.error.code).toBe("payload_too_large");
    });
  });

  it("speak throws after one chunk: stream ends with error internal, raw message not in client, console.error called", async () => {
    const fakeAssess = vi.fn().mockResolvedValue({
      status: "progressing",
      confidence: 0.5,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      yield "First";
      throw new Error("Secret internal error");
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const now = vi.fn(() => Date.now());
    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState();
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "test", source: "voice" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    // Should have move, token, then error
    expect(events[0].event).toBe("move");
    expect(events.some((e) => e.event === "token")).toBe(true);
    
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.event === "error") {
      expect(errorEvent.data.code).toBe("internal");
      expect(errorEvent.data.message).toBe("Step failed");
      expect(errorEvent.data.message).not.toContain("Secret internal error");
    }

    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("assess throws before move: stream is exactly error internal", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const startedAt = 1_000_000;
    const nowTime = 1_010_000;
    const now = vi.fn(() => nowTime);

    const fakeAssess = vi.fn().mockRejectedValue(new Error("Assess error"));
    const fakeSpeak = vi.fn();

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState({ startedAt });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "test", source: "voice" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    if (events[0].event === "error") {
      expect(events[0].data.code).toBe("internal");
    }

    consoleErrorSpy.mockRestore();
  });

  it("abort mid-speak: no events after abort, no unhandled rejection", async () => {
    const controller = new AbortController();

    const fakeAssess = vi.fn().mockResolvedValue({
      status: "progressing",
      confidence: 0.5,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      yield "First";
      // Wait a bit then abort
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      yield "Second";
    });

    const now = vi.fn(() => Date.now());
    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState();

    // Stage 11 H2: a Request stand-in whose signal IS the test's own signal. A real Request follows its
    // creator's abort only weakly (undici), which made this test fail about 1 run in 300 under load.
    const requestBody = { state, event: { type: "turn_complete", text: "test", source: "voice" } };
    const responsePromise = handler({
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => requestBody,
      signal: controller.signal,
    } as unknown as NextRequest);

    const response = await responsePromise;
    const events: StepStreamEvent[] = [];
    try {
      for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
        events.push(event);
        if (events.length > 5) break; // Safety limit
      }
    } catch {
      // Stream may be interrupted
    }

    // Should have no unhandled rejections (test passes if no error thrown)
    // The stream should have stopped after abort
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.map((e) => e.event)).toEqual(["move", "token"]);
  });

  it("no stub header in response", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
    });
    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    expect(response.headers.get("X-Interim-Stub")).toBeNull();
  });

  it('modelLabel: "fake" → 200 response has x-interim-model: fake', async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
    });
    const now = vi.fn(() => 1000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
      modelLabel: "fake",
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-interim-model")).toBe("fake");
  });

  it("modelLabel unset → header is absent on 200 response", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
    });
    const now = vi.fn(() => 1000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-interim-model")).toBeNull();
  });

  it("modelLabel unset → 400 response never has the header", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
    });
    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
      modelLabel: "fake",
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: "unknown", styleId: style.id },
    });

    const response = await handler(request);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-interim-model")).toBeNull();
  });

  // T4.4: Assert Cache-Control header
  it("Cache-Control header is no-cache, no-transform", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      yield "Hello";
    });
    const now = vi.fn(() => Date.now());

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
  });

  // T4.3: Empty utterance rule - start event
  it("start with speak yielding nothing: done.utterance empty, no interviewer entry appended, phase still problem", async () => {
    const fakeAssess = vi.fn();
    const fakeSpeak = vi.fn(async function* () {
      // Yields nothing
    });
    const now = vi.fn(() => 1000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const request = createRequest("http://localhost/api/step", {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    if (done?.event === "done") {
      expect(done.data.utterance).toBe("");
      expect(done.data.state.phase).toBe("problem");
      // No interviewer entry appended because utterance was empty
      expect(done.data.state.transcript).toHaveLength(0);
    }
  });

  // T4.3: Empty utterance rule - turn_complete event
  it("turn_complete with speak yielding nothing: done.utterance empty, no interviewer entry appended", async () => {
    const fakeAssess = vi.fn().mockResolvedValue({
      status: "progressing",
      confidence: 0.5,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "test",
    } as Assessment);

    const fakeSpeak = vi.fn(async function* () {
      // Yields nothing
    });
    const now = vi.fn(() => 10000);

    const handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const state = makeState({ startedAt: 1000 });
    const request = createRequest("http://localhost/api/step", {
      state,
      event: { type: "turn_complete", text: "My answer", source: "voice" },
    });

    const response = await handler(request);
    const events: StepStreamEvent[] = [];
    for await (const event of parseSSE(response.body as ReadableStream<Uint8Array>)) {
      events.push(event);
    }

    expectValidStream(events);

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    if (done?.event === "done") {
      expect(done.data.utterance).toBe("");
      // Only student entry, no interviewer entry
      expect(done.data.state.transcript).toHaveLength(1);
      expect(done.data.state.transcript[0].speaker).toBe("student");
    }
  });
});
