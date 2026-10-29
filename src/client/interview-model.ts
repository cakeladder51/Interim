import type { EngineEvent, EngineState, Move, StepRequest, TranscriptEntry } from "@/contracts";
import {
  StepHttpError,
  StepStreamError,
  StepProtocolError,
} from "./step-client";

export const SLOW_FIRST_TOKEN_MS = 6000;

export type BackgroundEvent = Extract<EngineEvent, { type: "partial" | "silence" | "canvas" }>;

export type InterviewStatus =
  | "starting"
  | "ready"
  | "sending"
  | "ended"
  | "error";

export interface InterviewView {
  engine: EngineState | null;
  status: InterviewStatus;
  pendingStudentText: string | null;
  streamingText: string;
  lastMove: Move | null;
  error: { message: string; retryable: boolean } | null;
  lastRequest: { request: StepRequest; studentText: string | null } | null;
  slow: boolean;
  modelLabel: string | null;
  background: "none" | "pending" | "speaking";
}

export type InterviewAction =
  | { type: "request"; request: StepRequest; studentText: string | null }
  | { type: "move"; move: Move }
  | { type: "token"; text: string }
  | { type: "slow" }
  | { type: "done"; state: EngineState }
  | { type: "failed"; message: string; retryable: boolean }
  | { type: "model_label"; label: string }
  | { type: "bg_request"; request: StepRequest }
  | { type: "bg_move"; move: Move }
  | { type: "bg_failed" };

export const initialView: InterviewView = {
  engine: null,
  status: "starting",
  pendingStudentText: null,
  streamingText: "",
  lastMove: null,
  error: null,
  lastRequest: null,
  slow: false,
  modelLabel: null,
  background: "none",
};

/**
 * Pure reducer for interview state.
 */
export function interviewReducer(
  view: InterviewView,
  action: InterviewAction
): InterviewView {
  switch (action.type) {
    case "request": {
      const status =
        action.request.event.type === "start" ? "starting" : "sending";
      return {
        ...view,
        status,
        pendingStudentText: action.studentText,
        streamingText: "",
        lastMove: null,
        error: null,
        slow: false,
        lastRequest: { request: action.request, studentText: action.studentText },
        background: "none",
      };
    }
    case "move":
      return {
        ...view,
        lastMove: action.move,
      };
    case "token":
      return {
        ...view,
        streamingText: view.streamingText + action.text,
        slow: false,
      };
    case "slow": {
      // Only set slow if status is starting or sending and no tokens yet
      if (
        (view.status === "starting" || view.status === "sending") &&
        view.streamingText === ""
      ) {
        return { ...view, slow: true };
      }
      return view;
    }
    case "done": {
      const newStatus = action.state.phase === "done" ? "ended" : "ready";
      return {
        ...view,
        engine: action.state,
        pendingStudentText: null,
        streamingText: "",
        slow: false,
        error: null,
        status: newStatus,
        background: "none",
      };
    }
    case "failed":
      return {
        ...view,
        status: "error",
        error: { message: action.message, retryable: action.retryable },
        streamingText: "",
        slow: false,
        // Keep engine and pendingStudentText
      };
    case "model_label":
      return {
        ...view,
        modelLabel: action.label,
      };
    case "bg_request":
      return { ...view, background: "pending" };
    case "bg_move":
      if (action.move.type === "silent") return view;
      return {
        ...view,
        status: "sending",
        background: "speaking",
        streamingText: "",
        lastMove: action.move,
        slow: false,
      };
    case "bg_failed":
      if (view.background === "speaking") {
        return { ...view, background: "none", status: "ready", streamingText: "" };
      }
      return { ...view, background: "none" };
  }
}

/**
 * Check if a turn can be sent.
 */
export function canSend(view: InterviewView, text: string): boolean {
  return (
    view.status === "ready" &&
    view.engine !== null &&
    view.engine.phase !== "done" &&
    text.trim() !== ""
  );
}

/**
 * Build a turn_complete request.
 */
export function buildTurnRequest(
  view: InterviewView,
  text: string,
  source: "typed" | "voice" = "typed"
): StepRequest {
  if (view.engine === null) {
    throw new Error("Cannot build turn request without engine");
  }
  return {
    state: view.engine,
    event: { type: "turn_complete", text: text.trim(), source },
  };
}

/**
 * Build an end request.
 */
export function buildEndRequest(view: InterviewView): StepRequest {
  if (view.engine === null) {
    throw new Error("Cannot build end request without engine");
  }
  return {
    state: view.engine,
    event: { type: "end" },
  };
}

/**
 * Build a start request.
 */
export function buildStartRequest(configId: string, styleId: string): StepRequest {
  return {
    state: null,
    event: { type: "start", configId, styleId },
  };
}

/**
 * Build a background step request (partial, silence or canvas).
 */
export function buildBackgroundRequest(view: InterviewView, event: BackgroundEvent): StepRequest {
  if (view.engine === null) {
    throw new Error("Cannot build background request without engine");
  }
  return { state: view.engine, event };
}

/**
 * Map a request-runner action to its background equivalent (null = drop it).
 */
export function mapBackgroundAction(action: InterviewAction): InterviewAction | null {
  switch (action.type) {
    case "request":
      return { type: "bg_request", request: action.request };
    case "move":
      return { type: "bg_move", move: action.move };
    case "failed":
      return { type: "bg_failed" };
    case "slow":
      return null;
    default:
      return action;
  }
}

/**
 * Visible transcript entries for the UI.
 */
export function visibleTranscript(
  view: InterviewView
): {
  speaker: "interviewer" | "student";
  text: string;
  kind: TranscriptEntry["kind"] | "pending" | "streaming";
  key: string;
}[] {
  const result: ReturnType<typeof visibleTranscript> = [];

  // Add engine transcript entries
  if (view.engine !== null) {
    for (const entry of view.engine.transcript) {
      result.push({
        speaker: entry.speaker,
        text: entry.text,
        kind: entry.kind,
        key: entry.id,
      });
    }
  }

  // Add pending student text
  if (view.pendingStudentText !== null) {
    result.push({
      speaker: "student",
      text: view.pendingStudentText,
      kind: "pending",
      key: "pending",
    });
  }

  // Add streaming interviewer text
  if (view.streamingText !== "") {
    result.push({
      speaker: "interviewer",
      text: view.streamingText,
      kind: "streaming",
      key: "streaming",
    });
  }

  return result;
}

/**
 * Check if the interviewer is thinking (waiting for first token).
 */
export function isThinking(view: InterviewView): boolean {
  return (
    (view.status === "starting" || view.status === "sending") &&
    view.streamingText === ""
  );
}

/**
 * Describe an error with user-friendly messages.
 */
export function describeError(
  err: unknown
): { message: string; retryable: boolean } {
  if (err instanceof StepHttpError) {
    if (err.status === 0) {
      return {
        message: "Connection lost. Check your internet connection and try again.",
        retryable: true,
      };
    }
    if (err.status === 400 || err.status === 413) {
      return {
        message:
          "This interview can't continue because the request was rejected. Please start a new interview.",
        retryable: false,
      };
    }
    return {
      message: "The server had a problem. Please try again.",
      retryable: true,
    };
  }
  if (err instanceof StepStreamError) {
    return {
      message: "The interviewer ran into a problem. Please try again.",
      retryable: err.retryable,
    };
  }
  if (err instanceof StepProtocolError) {
    return {
      message: "Something went wrong while receiving the reply. Please try again.",
      retryable: true,
    };
  }
  return {
    message: "Something unexpected went wrong. Please try again.",
    retryable: true,
  };
}
