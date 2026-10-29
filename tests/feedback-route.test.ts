import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFeedbackHandler } from "../src/server/feedback-handler";
import { MetaError } from "../src/lib/meta";
import { getConfig } from "../src/config/load";
import { toFeedbackView, noAnswerView } from "../src/server/feedback";
import type { EngineState, Report } from "@/contracts";

const maths = getConfig("maths-oxbridge");

// F1 transcript and state
const T = [
  { id: "e1", at: 0, speaker: "interviewer" as const, kind: "utterance" as const, text: "Welcome. Let's begin." },
  { id: "e2", at: 5000, speaker: "student" as const, kind: "typed" as const, text: "I think   the answer is\nroot two" },
  { id: "e3", at: 5000, speaker: "interviewer" as const, kind: "utterance" as const, text: "Why is that?" },
  { id: "e4", at: 9000, speaker: "student" as const, kind: "typed" as const, text: "Because it can't be a fraction." },
];

const state: EngineState = {
  version: 1,
  configId: "maths-oxbridge",
  styleId: "supportive",
  startedAt: 1000,
  phase: "done",
  problemIdx: 0,
  hintRung: -1,
  checkpointsHit: [],
  lastInterjectAt: null,
  turnWordBaseline: 0,
  probesAsked: 0,
  transcript: T,
};

const R: Report = {
  summary: "  Good start.  ",
  criteria: [
    { id: "rigour", score: 3, justification: "Mostly right." },
    { id: "approach", score: 2, justification: " Needed a hint. " },
    { id: "responsiveness", score: 4, justification: "Quick." },
    { id: "communication", score: 1, justification: "Quiet." },
  ],
  strengths: ["Clear.", "  ", "Kept going."],
  improvements: ["i1", "i2", "i3", "i4", "i5", "i6"],
  keyMoments: [
    { at: 9000, quote: "can't be a fraction", note: "Good insight." },
    { at: 5000, quote: "the answer is  root two", note: "First idea." },
    { at: 5000, quote: "Why is that", note: "Interviewer line." },
    { at: 1234, quote: "root two", note: "Wrong time." },
    { at: 9000, quote: "   ", note: "Empty quote." },
    { at: 9000, quote: "fraction", note: "  " },
  ],
};

const F1view = toFeedbackView(maths, state, R);

function makeHandler(
  generate: ReturnType<typeof vi.fn>,
  opts?: { modelLabel?: string; sleep?: ReturnType<typeof vi.fn> }
) {
  return createFeedbackHandler({
    generate,
    modelLabel: opts?.modelLabel,
    sleep: opts?.sleep ?? vi.fn(async () => {}),
  });
}

async function callHandler(
  handler: ReturnType<typeof createFeedbackHandler>,
  body: unknown
) {
  const request = new Request("http://test/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handler(request);
}

async function getResponseBody(res: Response) {
  return res.json();
}

describe("feedback-route", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("1. generate resolves R → 200 with F1 view", async () => {
    const generate = vi.fn().mockResolvedValue(R);
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await getResponseBody(res);
    expect(body).toEqual(F1view);

    expect(generate).toHaveBeenCalledTimes(1);
    const callArg = generate.mock.calls[0][0];
    expect(callArg.config.id).toBe("maths-oxbridge");
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("2. modelLabel=fake with R → 200 with modelLabel", async () => {
    const generate = vi.fn().mockResolvedValue(R);
    const handler = makeHandler(generate, { modelLabel: "fake" });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(200);

    const body = await getResponseBody(res);
    expect(body).toEqual({ ...F1view, modelLabel: "fake" });
  });

  it("3. invalid then valid → 200 after retry", async () => {
    const invalidCriteria = R.criteria.slice(1); // Missing rigour
    const invalidReport = { ...R, criteria: invalidCriteria };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(invalidReport)
      .mockResolvedValueOnce(R);
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(200);

    const body = await getResponseBody(res);
    expect(body).toEqual(F1view);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(400);
  });

  it("4. always invalid → 502 with retryable true", async () => {
    const invalidReport = { ...R, criteria: R.criteria.slice(1) };
    const generate = vi.fn().mockResolvedValue(invalidReport);
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(502);

    const body = await getResponseBody(res);
    expect(body).toEqual({
      error: {
        code: "feedback_failed",
        message: "We couldn't prepare your feedback.",
        retryable: true,
      },
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Interim: feedback failed", {
      attempts: 2,
      code: "invalid",
    });
  });

  it("5. MetaError timeout then R → 200 after retry", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new MetaError("timeout", "t", true))
      .mockResolvedValueOnce(R);
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(200);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("6. MetaError upstream retryable=false → 502 no retry", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new MetaError("upstream", "u", false));
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(502);

    const body = await getResponseBody(res);
    expect(body.error.retryable).toBe(false);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledWith("Interim: feedback failed", {
      attempts: 1,
      code: "upstream",
    });
  });

  it("7. plain Error → 502 with retryable false, no secrets logged", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new Error("MODEL_API_KEY is required"));
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(502);

    const body = await getResponseBody(res);
    expect(body.error.retryable).toBe(false);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Check no console.* call's arguments contain transcript text, quote or key name
    for (const call of warnSpy.mock.calls) {
      const str = JSON.stringify(call);
      expect(str).not.toContain("MODEL_API_KEY");
      expect(str).not.toContain("the answer is");
      expect(str).not.toContain("fraction");
    }
  });

  it("8. No student entries → 200 with noAnswerView", async () => {
    const stateNoStudent: EngineState = {
      ...state,
      transcript: [T[0]], // Only e1 (interviewer)
    };
    const generate = vi.fn();
    const handler = makeHandler(generate);

    const res = await callHandler(handler, { state: stateNoStudent });
    expect(res.status).toBe(200);

    const body = await getResponseBody(res);
    expect(body).toEqual(noAnswerView(maths));
    expect(generate).not.toHaveBeenCalled();
  });

  it("9. No student entries with modelLabel → 200 with modelLabel", async () => {
    const stateNoStudent: EngineState = {
      ...state,
      transcript: [T[0]],
    };
    const generate = vi.fn();
    const handler = makeHandler(generate, { modelLabel: "fake" });

    const res = await callHandler(handler, { state: stateNoStudent });
    expect(res.status).toBe(200);

    const body = await getResponseBody(res);
    expect(body).toEqual({ ...noAnswerView(maths), modelLabel: "fake" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("10. phase=problem → 400 not_finished", async () => {
    const stateProblem: EngineState = { ...state, phase: "problem" as const };
    const generate = vi.fn();
    const handler = makeHandler(generate);

    const res = await callHandler(handler, { state: stateProblem });
    expect(res.status).toBe(400);

    const body = await getResponseBody(res);
    expect(body).toEqual({
      error: {
        code: "not_finished",
        message: "The interview hasn't finished yet.",
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("11. Invalid JSON → 400 bad_request", async () => {
    const handler = makeHandler(vi.fn());

    const request = new Request("http://test/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const res = await handler(request);
    expect(res.status).toBe(400);

    const body = await getResponseBody(res);
    expect(body).toEqual({
      error: {
        code: "bad_request",
        message: "Invalid feedback request.",
      },
    });
  });

  it("12. state with wrong type → 400 bad_request", async () => {
    const handler = makeHandler(vi.fn());

    const res = await callHandler(handler, { state: 5 });
    expect(res.status).toBe(400);

    const body = await getResponseBody(res);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("Invalid feedback request.");
  });

  it("13. unknown configId → 400 bad_request", async () => {
    const stateBad: EngineState = { ...state, configId: "nope" };
    const generate = vi.fn();
    const handler = makeHandler(generate);

    const res = await callHandler(handler, { state: stateBad });
    expect(res.status).toBe(400);

    const body = await getResponseBody(res);
    expect(body.error.code).toBe("bad_request");
    expect(generate).not.toHaveBeenCalled();
  });

  it("14. unknown styleId → 400 bad_request", async () => {
    const stateBad: EngineState = { ...state, styleId: "nope" };
    const generate = vi.fn();
    const handler = makeHandler(generate);

    const res = await callHandler(handler, { state: stateBad });
    expect(res.status).toBe(400);

    const body = await getResponseBody(res);
    expect(body.error.code).toBe("bad_request");
    expect(generate).not.toHaveBeenCalled();
  });

  it("15. content-length > limit → 413 payload_too_large", async () => {
    const generate = vi.fn();
    const handler = makeHandler(generate);

    const request = new Request("http://test/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "content-length": "1000001",
      },
      body: JSON.stringify({ state }),
    });
    const res = await handler(request);
    expect(res.status).toBe(413);

    const body = await getResponseBody(res);
    expect(body).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body too large.",
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("16. content-length == limit with valid body → not 413", async () => {
    const generate = vi.fn().mockResolvedValue(R);
    const handler = makeHandler(generate);

    const request = new Request("http://test/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "content-length": "1000000",
      },
      body: JSON.stringify({ state }),
    });
    const res = await handler(request);
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
  });

  it("17. AbortError from generate → 502, no retry", async () => {
    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    const generate = vi.fn().mockRejectedValue(abortErr);
    const sleep = vi.fn(async () => {});
    const handler = makeHandler(generate, { sleep });

    const res = await callHandler(handler, { state });
    expect(res.status).toBe(502);

    const body = await getResponseBody(res);
    expect(body.error.retryable).toBe(false);

    // Only called once (no retry)
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledWith("Interim: feedback failed", {
      attempts: 1,
      code: "error",
    });
  });
});
