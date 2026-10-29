import "server-only";

import type { OpenAI } from "openai";
import type {
  InterviewConfig,
  Style,
  EngineState,
  Assessment,
} from "@/contracts";
import type { DecideEvent, SpeakReason } from "@/engine/types";
import { fallbackUtterance } from "@/engine/prompts";

export const FAKE_ASSESS_DELAY_MS = 150;
export const FAKE_TOKEN_DELAY_MS = 30;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fake assessor for offline testing.
 */
export async function fakeAssess(args: {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  event: Extract<DecideEvent, { type: "partial" | "turn_complete" | "canvas" }>;
  signal?: AbortSignal;
  client?: OpenAI;
}): Promise<Assessment | null> {
  // Wait the delay
  await delay(FAKE_ASSESS_DELAY_MS);

  // Check for abort
  if (args.signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }

  const event = args.event;
  const problem = args.config.problems[args.state.problemIdx];

  // For canvas, text is empty
  const t = event.type === "canvas" ? "" : event.text.toLowerCase();

  // Branch 1: stuck keywords
  if (/\b(i don'?t know|stuck|no idea)\b/.test(t)) {
    return {
      status: "stuck",
      confidence: 0.9,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "fake: stuck keyword",
    };
  }

  // Branch 2: solved keywords
  if (/\b(solved|done|finished)\b/.test(t)) {
    return {
      status: "correct",
      confidence: 0.9,
      checkpointsHit: problem.checkpoints.map((c) => c.id),
      misconceptionId: null,
      evidence: "fake: solved keyword",
    };
  }

  // Branch 3: wrong keyword
  if (/\bwrong\b/.test(t)) {
    const misconceptionId =
      problem.misconceptions.length > 0 ? problem.misconceptions[0].id : null;
    return {
      status: "off_track",
      confidence: 0.9,
      checkpointsHit: [],
      misconceptionId,
      evidence: "fake: wrong keyword",
    };
  }

  // Branch 4: default
  return {
    status: "progressing",
    confidence: 0.6,
    checkpointsHit: [],
    misconceptionId: null,
    evidence: "fake: default",
  };
}

/**
 * Fake speaker for offline testing.
 * Yields whitespace-delimited chunks of the fallback utterance.
 */
export async function* fakeSpeak(args: {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  move: Exclude<import("@/contracts").Move, { type: "silent" }>;
  interrupt: boolean;
  reason: SpeakReason;
  studentText: string | null;
  signal?: AbortSignal;
  client?: OpenAI;
}): AsyncGenerator<string> {
  const text = fallbackUtterance({
    config: args.config,
    state: args.state,
    move: args.move,
    reason: args.reason,
  });

  // Split into word+trailing-whitespace chunks
  const chunks = text.match(/\S+\s*/g) ?? [];

  let isFirst = true;
  for (const chunk of chunks) {
    // Check abort before yielding
    if (args.signal?.aborted) {
      return;
    }

    // Wait before each chunk after the first
    if (!isFirst) {
      await delay(FAKE_TOKEN_DELAY_MS);
      // Check abort again after wait
      if (args.signal?.aborted) {
        return;
      }
    }
    isFirst = false;

    yield chunk;
  }
}
