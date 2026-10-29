import { describe, it, expect } from "vitest";
import {
  interviewReducer,
  initialView,
  canSend,
  buildTurnRequest,
  buildEndRequest,
  buildStartRequest,
  buildBackgroundRequest,
  mapBackgroundAction,
  visibleTranscript,
  isThinking,
  describeError,
} from "../src/client/interview-model";
import { StepHttpError, StepStreamError, StepProtocolError } from "../src/client/step-client";
import type { InterviewView, InterviewAction } from "../src/client/interview-model";
import type { EngineState, Move, StepRequest } from "@/contracts";

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

describe("interviewReducer", () => {
  describe("request action", () => {
    it("sets status to starting on start event", () => {
      const request: StepRequest = { state: null, event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" } };
      const action: InterviewAction = { type: "request", request, studentText: null };
      const result = interviewReducer(initialView, action);

      expect(result.status).toBe("starting");
      expect(result.pendingStudentText).toBe(null);
      expect(result.streamingText).toBe("");
      expect(result.lastMove).toBe(null);
      expect(result.error).toBe(null);
      expect(result.slow).toBe(false);
      expect(result.lastRequest).toEqual({ request, studentText: null });
    });

    it("sets status to sending on turn_complete event", () => {
      const state = engineState();
      const request: StepRequest = { state, event: { type: "turn_complete", text: "Hello", source: "typed" } };
      const action: InterviewAction = { type: "request", request, studentText: "Hello" };
      const result = interviewReducer({ ...initialView, engine: state }, action);

      expect(result.status).toBe("sending");
      expect(result.pendingStudentText).toBe("Hello");
    });

    it("clears streamingText and lastMove on request", () => {
      const viewWithStream: InterviewView = {
        ...initialView,
        engine: engineState(),
        streamingText: "old stream",
        lastMove: { type: "intro" },
      };
      const request: StepRequest = { state: viewWithStream.engine, event: { type: "turn_complete", text: "test", source: "typed" } };
      const action: InterviewAction = { type: "request", request, studentText: "test" };
      const result = interviewReducer(viewWithStream, action);

      expect(result.streamingText).toBe("");
      expect(result.lastMove).toBe(null);
    });

    it("G1: request clears error", () => {
      const state = engineState();
      const viewWithError: InterviewView = {
        ...initialView,
        engine: state,
        status: "error",
        error: { message: "Previous error", retryable: true },
      };
      const request: StepRequest = { state, event: { type: "turn_complete", text: "test", source: "typed" } };
      const action: InterviewAction = { type: "request", request, studentText: "test" };
      const result = interviewReducer(viewWithError, action);

      expect(result.error).toBe(null);
    });

    it("G2: request resets slow to false", () => {
      const state = engineState();
      const viewWithSlow: InterviewView = {
        ...initialView,
        engine: state,
        slow: true,
      };
      const request: StepRequest = { state, event: { type: "turn_complete", text: "test", source: "typed" } };
      const action: InterviewAction = { type: "request", request, studentText: "test" };
      const result = interviewReducer(viewWithSlow, action);

      expect(result.slow).toBe(false);
    });
  });

  describe("move action", () => {
    it("sets lastMove", () => {
      const move: Move = { type: "hint", rung: 0 };
      const action: InterviewAction = { type: "move", move };
      const result = interviewReducer(initialView, action);

      expect(result.lastMove).toEqual(move);
    });

    it("does not change other fields", () => {
      const view: InterviewView = { ...initialView, status: "sending", streamingText: "some text" };
      const move: Move = { type: "acknowledge" };
      const action: InterviewAction = { type: "move", move };
      const result = interviewReducer(view, action);

      expect(result.status).toBe("sending");
      expect(result.streamingText).toBe("some text");
    });
  });

  describe("token action", () => {
    it("appends to streamingText", () => {
      const view: InterviewView = { ...initialView, streamingText: "Hello" };
      const action: InterviewAction = { type: "token", text: " world" };
      const result = interviewReducer(view, action);

      expect(result.streamingText).toBe("Hello world");
    });

    it("clears slow flag", () => {
      const view: InterviewView = { ...initialView, slow: true, streamingText: "" };
      const action: InterviewAction = { type: "token", text: "text" };
      const result = interviewReducer(view, action);

      expect(result.slow).toBe(false);
    });
  });

  describe("slow action", () => {
    it("sets slow=true when status is starting and streamingText empty", () => {
      const view: InterviewView = { ...initialView, status: "starting", streamingText: "" };
      const action: InterviewAction = { type: "slow" };
      const result = interviewReducer(view, action);

      expect(result.slow).toBe(true);
    });

    it("sets slow=true when status is sending and streamingText empty", () => {
      const view: InterviewView = { ...initialView, status: "sending", streamingText: "" };
      const action: InterviewAction = { type: "slow" };
      const result = interviewReducer(view, action);

      expect(result.slow).toBe(true);
    });

    it("does not change slow when streamingText has content", () => {
      const view: InterviewView = { ...initialView, status: "starting", streamingText: "text" };
      const action: InterviewAction = { type: "slow" };
      const result = interviewReducer(view, action);

      expect(result.slow).toBe(false);
    });

    it("does not change slow when not in flight (status ready)", () => {
      const view: InterviewView = { ...initialView, status: "ready", engine: engineState(), streamingText: "" };
      const action: InterviewAction = { type: "slow" };
      const result = interviewReducer(view, action);

      expect(result.slow).toBe(false);
    });
  });

  describe("done action", () => {
    it("sets engine, clears pending and streaming, status ready if phase is problem", () => {
      const state = engineState({ phase: "problem" });
      const view: InterviewView = {
        ...initialView,
        pendingStudentText: "pending",
        streamingText: "streaming",
      };
      const action: InterviewAction = { type: "done", state };
      const result = interviewReducer(view, action);

      expect(result.engine).toEqual(state);
      expect(result.pendingStudentText).toBe(null);
      expect(result.streamingText).toBe("");
      expect(result.slow).toBe(false);
      expect(result.error).toBe(null);
      expect(result.status).toBe("ready");
    });

    it("sets status ended if phase is done", () => {
      const state = engineState({ phase: "done" });
      const action: InterviewAction = { type: "done", state };
      const result = interviewReducer(initialView, action);

      expect(result.status).toBe("ended");
    });

    it("sets status ready if phase is wrap_up", () => {
      const state = engineState({ phase: "wrap_up" });
      const action: InterviewAction = { type: "done", state };
      const result = interviewReducer(initialView, action);

      expect(result.status).toBe("ready");
    });

    it("G3: done clears error", () => {
      const state = engineState();
      const viewWithError: InterviewView = {
        ...initialView,
        engine: state,
        status: "sending",
        error: { message: "Previous error", retryable: true },
      };
      const action: InterviewAction = { type: "done", state };
      const result = interviewReducer(viewWithError, action);

      expect(result.error).toBe(null);
    });
  });

  describe("failed action", () => {
    it("sets status error, error, clears streamingText and slow", () => {
      const state = engineState();
      const view: InterviewView = {
        ...initialView,
        engine: state,
        status: "sending",
        pendingStudentText: "my answer",
        streamingText: "partial",
        slow: true,
      };
      const action: InterviewAction = { type: "failed", message: "Something went wrong", retryable: true };
      const result = interviewReducer(view, action);

      expect(result.status).toBe("error");
      expect(result.error).toEqual({ message: "Something went wrong", retryable: true });
      expect(result.streamingText).toBe("");
      expect(result.slow).toBe(false);
    });

    it("keeps engine and pendingStudentText", () => {
      const state = engineState();
      const view: InterviewView = {
        ...initialView,
        engine: state,
        pendingStudentText: "my answer",
      };
      const action: InterviewAction = { type: "failed", message: "error", retryable: false };
      const result = interviewReducer(view, action);

      expect(result.engine).toEqual(state);
      expect(result.pendingStudentText).toBe("my answer");
    });

    it("G4: failed with retryable: false keeps retryable as false", () => {
      const state = engineState();
      const view: InterviewView = {
        ...initialView,
        engine: state,
        status: "sending",
      };
      const action: InterviewAction = { type: "failed", message: "error", retryable: false };
      const result = interviewReducer(view, action);

      expect(result.error?.retryable).toBe(false);
    });
  });

  describe("model_label action", () => {
    it("sets modelLabel", () => {
      const action: InterviewAction = { type: "model_label", label: "fake" };
      const result = interviewReducer(initialView, action);

      expect(result.modelLabel).toBe("fake");
    });
  });

  describe("purity", () => {
    it("does not mutate input view", () => {
      const view: InterviewView = { ...initialView };
      const action: InterviewAction = { type: "token", text: "test" };
      interviewReducer(view, action);
      expect(view.streamingText).toBe("");
    });
  });
});

describe("canSend", () => {
  it("returns true when status ready, engine exists, phase not done, text non-empty", () => {
    const view: InterviewView = {
      ...initialView,
      status: "ready",
      engine: engineState({ phase: "problem" }),
    };
    expect(canSend(view, "Hello")).toBe(true);
  });

  it("returns false when status is starting", () => {
    const view: InterviewView = { ...initialView, status: "starting" };
    expect(canSend(view, "Hello")).toBe(false);
  });

  it("returns false when status is sending", () => {
    const view: InterviewView = { ...initialView, status: "sending" };
    expect(canSend(view, "Hello")).toBe(false);
  });

  it("G5: returns false when status is starting, sending, ended, or error", () => {
    const engine = engineState({ phase: "problem" });
    
    // starting
    expect(canSend({ ...initialView, status: "starting", engine }, "Hello")).toBe(false);
    
    // sending
    expect(canSend({ ...initialView, status: "sending", engine }, "Hello")).toBe(false);
    
    // ended
    expect(canSend({ ...initialView, status: "ended", engine }, "Hello")).toBe(false);
    
    // error
    expect(canSend({ ...initialView, status: "error", engine, error: { message: "err", retryable: true } }, "Hello")).toBe(false);
  });

  it("returns false when engine is null", () => {
    const view: InterviewView = { ...initialView, status: "ready", engine: null };
    expect(canSend(view, "Hello")).toBe(false);
  });

  it("returns false when phase is done", () => {
    const view: InterviewView = {
      ...initialView,
      status: "ready",
      engine: engineState({ phase: "done" }),
    };
    expect(canSend(view, "Hello")).toBe(false);
  });

  it("returns false for whitespace-only text", () => {
    const view: InterviewView = {
      ...initialView,
      status: "ready",
      engine: engineState(),
    };
    expect(canSend(view, "   ")).toBe(false);
  });

  it("returns false when text is empty string", () => {
    const view: InterviewView = {
      ...initialView,
      status: "ready",
      engine: engineState(),
    };
    expect(canSend(view, "")).toBe(false);
  });
});

describe("buildTurnRequest", () => {
  it("trims text and uses source typed", () => {
    const engine = engineState();
    const view: InterviewView = { ...initialView, engine };
    const result = buildTurnRequest(view, "  Hello world  ");

    expect(result).toEqual({
      state: engine,
      event: { type: "turn_complete", text: "Hello world", source: "typed" },
    });
  });

  it("throws if engine is null", () => {
    const view: InterviewView = { ...initialView, engine: null };
    expect(() => buildTurnRequest(view, "test")).toThrow();
  });
});

describe("buildEndRequest", () => {
  it("produces the exact shape", () => {
    const engine = engineState();
    const view: InterviewView = { ...initialView, engine };
    const result = buildEndRequest(view);

    expect(result).toEqual({
      state: engine,
      event: { type: "end" },
    });
  });

  it("throws if engine is null", () => {
    const view: InterviewView = { ...initialView, engine: null };
    expect(() => buildEndRequest(view)).toThrow();
  });
});

describe("buildStartRequest", () => {
  it("produces the exact shape", () => {
    const result = buildStartRequest("maths-oxbridge", "supportive");

    expect(result).toEqual({
      state: null,
      event: { type: "start", configId: "maths-oxbridge", styleId: "supportive" },
    });
  });
});

describe("visibleTranscript", () => {
  it("returns engine transcript entries", () => {
    const engine = engineState({
      transcript: [
        { id: "a", at: 0, speaker: "interviewer", kind: "utterance", text: "Hello" },
        { id: "b", at: 100, speaker: "student", kind: "typed", text: "Hi" },
      ],
    });
    const view: InterviewView = { ...initialView, engine };
    const result = visibleTranscript(view);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      speaker: "interviewer",
      text: "Hello",
      kind: "utterance",
      key: "a",
    });
    expect(result[1]).toEqual({
      speaker: "student",
      text: "Hi",
      kind: "typed",
      key: "b",
    });
  });

  it("includes pending student entry", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      pendingStudentText: "I'm thinking...",
    };
    const result = visibleTranscript(view);

    const pending = result.find((e) => e.key === "pending");
    expect(pending).toEqual({
      speaker: "student",
      text: "I'm thinking...",
      kind: "pending",
      key: "pending",
    });
  });

  it("includes streaming interviewer entry", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      streamingText: "Well done...",
    };
    const result = visibleTranscript(view);

    const streaming = result.find((e) => e.key === "streaming");
    expect(streaming).toEqual({
      speaker: "interviewer",
      text: "Well done...",
      kind: "streaming",
      key: "streaming",
    });
  });

  it("ordering: engine entries, then pending, then streaming", () => {
    const engine = engineState({
      transcript: [{ id: "a", at: 0, speaker: "interviewer", kind: "utterance", text: "Hello" }],
    });
    const view: InterviewView = {
      ...initialView,
      engine,
      pendingStudentText: "pending",
      streamingText: "streaming",
    };
    const result = visibleTranscript(view);

    expect(result).toHaveLength(3);
    expect(result[0].key).toBe("a");
    expect(result[1].key).toBe("pending");
    expect(result[2].key).toBe("streaming");
  });
});

describe("isThinking", () => {
  it("returns true when status starting and streamingText empty", () => {
    const view: InterviewView = { ...initialView, status: "starting", streamingText: "" };
    expect(isThinking(view)).toBe(true);
  });

  it("returns true when status sending and streamingText empty", () => {
    const view: InterviewView = { ...initialView, status: "sending", streamingText: "" };
    expect(isThinking(view)).toBe(true);
  });

  it("returns false when streamingText has content", () => {
    const view: InterviewView = { ...initialView, status: "sending", streamingText: "text" };
    expect(isThinking(view)).toBe(false);
  });

  it("returns false when status is ready", () => {
    const view: InterviewView = { ...initialView, status: "ready", engine: engineState(), streamingText: "" };
    expect(isThinking(view)).toBe(false);
  });
});

describe("describeError", () => {
  it("StepHttpError status 0 → network error message, retryable true", () => {
    const err = new StepHttpError(0, "network", "Network error");
    const result = describeError(err);

    expect(result.message).toBe("Connection lost. Check your internet connection and try again.");
    expect(result.retryable).toBe(true);
  });

  it("StepHttpError status 400 → request rejected message, retryable false", () => {
    const err = new StepHttpError(400, "bad_request", "Bad request");
    const result = describeError(err);

    expect(result.message).toBe("This interview can't continue because the request was rejected. Please start a new interview.");
    expect(result.retryable).toBe(false);
  });

  it("StepHttpError status 413 → request rejected message, retryable false", () => {
    const err = new StepHttpError(413, "payload_too_large", "Too large");
    const result = describeError(err);

    expect(result.message).toBe("This interview can't continue because the request was rejected. Please start a new interview.");
    expect(result.retryable).toBe(false);
  });

  it("StepHttpError status 500 → server problem message, retryable true", () => {
    const err = new StepHttpError(500, "internal", "Internal error");
    const result = describeError(err);

    expect(result.message).toBe("The server had a problem. Please try again.");
    expect(result.retryable).toBe(true);
  });

  it("StepHttpError status 502 → server problem message, retryable true", () => {
    const err = new StepHttpError(502, "bad_gateway", "Bad gateway");
    const result = describeError(err);

    expect(result.message).toBe("The server had a problem. Please try again.");
    expect(result.retryable).toBe(true);
  });

  it("StepStreamError → interviewer problem message, uses err.retryable", () => {
    const retryableErr = new StepStreamError("model_error", true, "Model failed");
    const result1 = describeError(retryableErr);
    expect(result1.message).toBe("The interviewer ran into a problem. Please try again.");
    expect(result1.retryable).toBe(true);

    const nonRetryableErr = new StepStreamError("bad_request", false, "Bad");
    const result2 = describeError(nonRetryableErr);
    expect(result2.retryable).toBe(false);
  });

  it("StepProtocolError → receiving reply message, retryable true", () => {
    const err = new StepProtocolError("Protocol error");
    const result = describeError(err);

    expect(result.message).toBe("Something went wrong while receiving the reply. Please try again.");
    expect(result.retryable).toBe(true);
  });

  it("unknown error → unexpected message, retryable true", () => {
    const err = new Error("Some random error");
    const result = describeError(err);

    expect(result.message).toBe("Something unexpected went wrong. Please try again.");
    expect(result.retryable).toBe(true);
  });
});

describe("buildTurnRequest with voice source", () => {
  it("uses voice source when specified", () => {
    const engine = engineState();
    const view: InterviewView = { ...initialView, engine };
    const result = buildTurnRequest(view, " hi ", "voice");

    expect(result.event).toEqual({ type: "turn_complete", text: "hi", source: "voice" });
  });

  it("defaults to typed source", () => {
    const engine = engineState();
    const view: InterviewView = { ...initialView, engine };
    const result = buildTurnRequest(view, "hi");

    expect(result.event).toEqual({ type: "turn_complete", text: "hi", source: "typed" });
  });
});

describe("background steps (stage 8)", () => {
  it("initialView.background === \"none\"", () => {
    expect(initialView.background).toBe("none");
  });

  it("bg_request sets background: \"pending\" and leaves other fields unchanged", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      status: "ready",
      streamingText: "test",
      pendingStudentText: "pending",
      error: { message: "err", retryable: true },
      lastRequest: null,
    };
    const request: StepRequest = { state: engine, event: { type: "partial", text: "test" } };
    const action: InterviewAction = { type: "bg_request", request };
    const result = interviewReducer(view, action);

    expect(result.background).toBe("pending");
    expect(result.status).toBe("ready");
    expect(result.streamingText).toBe("test");
    expect(result.pendingStudentText).toBe("pending");
    expect(result.error).toEqual({ message: "err", retryable: true });
    expect(result.lastRequest).toBe(null);
  });

  it("bg_move silent returns the same object (toBe)", () => {
    const view: InterviewView = { ...initialView, engine: engineState() };
    const action: InterviewAction = { type: "bg_move", move: { type: "silent" } };
    const result = interviewReducer(view, action);
    expect(result).toBe(view);
  });

  it("bg_move realign sets status: \"sending\", background: \"speaking\", streamingText: \"\" and lastMove", () => {
    const engine = engineState();
    const view: InterviewView = { ...initialView, engine, status: "ready" };
    const move: Move = { type: "realign", misconceptionId: "test-misconception" };
    const action: InterviewAction = { type: "bg_move", move };
    const result = interviewReducer(view, action);

    expect(result.status).toBe("sending");
    expect(result.background).toBe("speaking");
    expect(result.streamingText).toBe("");
    expect(result.lastMove).toEqual(move);
    expect(result.slow).toBe(false);
  });

  it("done after a background request sets background: \"none\" and replaces engine, status is \"ready\"", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      status: "sending",
      background: "speaking",
    };
    const newState = engineState({ phase: "problem", transcript: [{ id: "a", at: 0, speaker: "interviewer", kind: "interjection", text: "test" }] });
    const action: InterviewAction = { type: "done", state: newState };
    const result = interviewReducer(view, action);

    expect(result.background).toBe("none");
    expect(result.engine).toEqual(newState);
    expect(result.status).toBe("ready");
  });

  it("bg_failed while speaking gives status: \"ready\", streamingText: \"\", background: \"none\", engine unchanged", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      status: "sending",
      streamingText: "partial",
      background: "speaking",
    };
    const action: InterviewAction = { type: "bg_failed" };
    const result = interviewReducer(view, action);

    expect(result.status).toBe("ready");
    expect(result.streamingText).toBe("");
    expect(result.background).toBe("none");
    expect(result.engine).toEqual(engine);
  });

  it("bg_failed while pending only changes background", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      status: "ready",
      background: "pending",
    };
    const action: InterviewAction = { type: "bg_failed" };
    const result = interviewReducer(view, action);

    expect(result.background).toBe("none");
    expect(result.status).toBe("ready");
    expect(result.engine).toEqual(engine);
  });

  it("A foreground request resets background to \"none\"", () => {
    const engine = engineState();
    const view: InterviewView = {
      ...initialView,
      engine,
      status: "ready",
      background: "pending",
    };
    const request: StepRequest = { state: engine, event: { type: "turn_complete", text: "test", source: "typed" } };
    const action: InterviewAction = { type: "request", request, studentText: "test" };
    const result = interviewReducer(view, action);

    expect(result.background).toBe("none");
  });

  describe("mapBackgroundAction", () => {
    it("request maps to bg_request (same request object)", () => {
      const request: StepRequest = { state: engineState(), event: { type: "turn_complete", text: "test", source: "typed" } };
      const action: InterviewAction = { type: "request", request, studentText: "test" };
      const result = mapBackgroundAction(action);
      expect(result).toEqual({ type: "bg_request", request });
    });

    it("move maps to bg_move", () => {
      const move: Move = { type: "hint", rung: 0 };
      const action: InterviewAction = { type: "move", move };
      const result = mapBackgroundAction(action);
      expect(result).toEqual({ type: "bg_move", move });
    });

    it("failed maps to bg_failed", () => {
      const action: InterviewAction = { type: "failed", message: "err", retryable: true };
      const result = mapBackgroundAction(action);
      expect(result).toEqual({ type: "bg_failed" });
    });

    it("slow maps to null", () => {
      const action: InterviewAction = { type: "slow" };
      const result = mapBackgroundAction(action);
      expect(result).toBeNull();
    });

    it("token, done and model_label are returned unchanged (toBe)", () => {
      const tokenAction: InterviewAction = { type: "token", text: "hello" };
      expect(mapBackgroundAction(tokenAction)).toBe(tokenAction);

      const doneAction: InterviewAction = { type: "done", state: engineState() };
      expect(mapBackgroundAction(doneAction)).toBe(doneAction);

      const labelAction: InterviewAction = { type: "model_label", label: "fake" };
      expect(mapBackgroundAction(labelAction)).toBe(labelAction);
    });
  });

  describe("buildBackgroundRequest", () => {
    it("returns { state: engine, event } for partial event", () => {
      const engine = engineState();
      const view: InterviewView = { ...initialView, engine };
      const event = { type: "partial", text: "test partial" } as const;
      const result = buildBackgroundRequest(view, event);

      expect(result).toEqual({ state: engine, event });
    });

    it("returns { state: engine, event } for silence event", () => {
      const engine = engineState();
      const view: InterviewView = { ...initialView, engine };
      const event = { type: "silence", ms: 5000 } as const;
      const result = buildBackgroundRequest(view, event);

      expect(result).toEqual({ state: engine, event });
    });

    it("returns { state: engine, event } for canvas event", () => {
      const engine = engineState();
      const view: InterviewView = { ...initialView, engine };
      const event = { type: "canvas", image: "data:image/png;base64,test" } as const;
      const result = buildBackgroundRequest(view, event);

      expect(result).toEqual({ state: engine, event });
    });

    it("throws when engine is null", () => {
      const view: InterviewView = { ...initialView, engine: null };
      const event = { type: "partial", text: "test" } as const;
      expect(() => buildBackgroundRequest(view, event)).toThrow("Cannot build background request without engine");
    });
  });
});

// Review 1 additions (stage-08-review.md G4).
describe("background steps (review 1 additions)", () => {
  it("bg_request keeps lastRequest (same object)", () => {
    const engine = engineState();
    const lastRequest = { request: { state: engine, event: { type: "end" as const } }, studentText: null };
    const view: InterviewView = { ...initialView, engine, status: "ready", lastRequest };
    const result = interviewReducer(view, { type: "bg_request", request: { state: engine, event: { type: "silence", ms: 20000 } } });
    expect(result.lastRequest).toBe(lastRequest);
    expect(result).toEqual({ ...view, background: "pending" });
  });

  it("bg_move spoken clears old streamingText and slow", () => {
    const view: InterviewView = { ...initialView, engine: engineState(), status: "ready", streamingText: "old", slow: true };
    const result = interviewReducer(view, { type: "bg_move", move: { type: "hint", rung: 0 } });
    expect(result).toEqual({
      ...view,
      status: "sending",
      background: "speaking",
      streamingText: "",
      lastMove: { type: "hint", rung: 0 },
      slow: false,
    });
  });

  it("bg_failed while pending changes only background", () => {
    const view: InterviewView = {
      ...initialView,
      engine: engineState(),
      status: "sending",
      streamingText: "kept",
      background: "pending",
    };
    expect(interviewReducer(view, { type: "bg_failed" })).toEqual({ ...view, background: "none" });
  });

  it("mapBackgroundAction keeps the same request object", () => {
    const request: StepRequest = { state: engineState(), event: { type: "partial", text: "x" } };
    const mapped = mapBackgroundAction({ type: "request", request, studentText: null });
    expect(mapped?.type).toBe("bg_request");
    expect(mapped !== null && mapped.type === "bg_request" ? mapped.request : null).toBe(request);
  });
});
