import "server-only";

import type OpenAI from "openai";
import type { InterviewConfig, Style, EngineState, Assessment } from "@/contracts";
import type { DecideEvent } from "@/engine/types";
import { chatJSON, MetaError } from "@/lib/meta";
import { AssessmentSchema } from "@/contracts";
import { buildAssessMessages } from "@/engine/prompts";

export const ASSESS_TIMEOUT_TURN_MS = 8000;
export const ASSESS_TIMEOUT_LIVE_MS = 3500; // partial and canvas

export interface AssessArgs {
  config: InterviewConfig;
  style: Style;
  state: EngineState; // before the student's turn is appended
  event: Extract<DecideEvent, { type: "partial" | "turn_complete" | "canvas" }>;
  signal?: AbortSignal;
  client?: OpenAI;
}

/**
 * Call the assessor model to assess the student's input.
 * Returns null on any MetaError (handled by FSM).
 * Rethrows other errors (including caller aborts).
 */
export async function assess(args: AssessArgs): Promise<Assessment | null> {
  const { config, state, event, signal, client } = args;

  const isLiveEvent = event.type === "partial" || event.type === "canvas";
  const timeoutMs = isLiveEvent ? ASSESS_TIMEOUT_LIVE_MS : ASSESS_TIMEOUT_TURN_MS;
  const retry = !isLiveEvent; // No retry for live events (late mid-answer is worthless)

  const messages = buildAssessMessages({ config, state, event });

  try {
    const result = await chatJSON({
      schema: AssessmentSchema,
      schemaName: "Assessment",
      messages,
      timeoutMs,
      retry,
      signal,
      client,
    });

    return result.data;
  } catch (err) {
    // MetaError → return null (FSM handles it)
    if (err instanceof MetaError) {
      return null;
    }
    // Other errors (including caller abort) → rethrow
    throw err;
  }
}
