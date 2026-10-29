import "server-only";

import type OpenAI from "openai";
import type { InterviewConfig, Style, EngineState, Move } from "@/contracts";
import type { SpeakReason } from "@/engine/types";
import { chatStream, MetaError } from "@/lib/meta";
import { buildSpeakMessages, fallbackUtterance } from "@/engine/prompts";

export const SPEAK_MAX_TOKENS = 200;
export const SPEAK_MAX_TOKENS_INTERRUPT = 60;

export interface SpeakArgs {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  move: Exclude<Move, { type: "silent" }>;
  interrupt: boolean;
  reason: SpeakReason;
  studentText: string | null;
  signal?: AbortSignal;
  client?: OpenAI;
}

/**
 * Stream the interviewer's utterance.
 * On failure before any delta, yields the fallback utterance.
 * On failure after deltas started, stops silently.
 * On abort, returns silently.
 */
export async function* speak(args: SpeakArgs): AsyncGenerator<string> {
  const { config, style, state, move, interrupt, reason, studentText, signal, client } =
    args;

  const maxTokens = interrupt ? SPEAK_MAX_TOKENS_INTERRUPT : SPEAK_MAX_TOKENS;
  const messages = buildSpeakMessages({
    config,
    style,
    state,
    move,
    interrupt,
    reason,
    studentText,
  });

  let yieldedAny = false;

  try {
    for await (const delta of chatStream({
      messages,
      maxTokens,
      firstTokenTimeoutMs: 4000,
      totalTimeoutMs: 12000,
      signal,
      client,
    })) {
      yieldedAny = true;
      yield delta;
    }
  } catch (err) {
    // If aborted, return silently
    if (signal?.aborted) {
      return;
    }

    // MetaError
    if (err instanceof MetaError) {
      if (!yieldedAny) {
        // Failure before any delta → yield fallback once
        yield fallbackUtterance({ config, state, move, reason });
      }
      // Failure after some deltas → stop silently
      return;
    }

    // Other errors → rethrow
    throw err;
  }
}
