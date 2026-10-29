import type { EngineState, Assessment, InterviewConfig, Style } from "@/contracts";
import { EngineError } from "./errors";
import type { DecideInput, DecideResult, DecideEvent, DecisionReason } from "./types";

export const TURN_OFF_TRACK_MIN_CONFIDENCE = 0.5;
export const PROBES_PER_PROBLEM = 1;

/**
 * Count whitespace-separated non-empty tokens.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

/**
 * Pure decision function. Given state, event, optional assessment, config, style, and now,
 * returns the next state and move.
 */
export function decide(input: DecideInput): DecideResult {
  const { state, event, assessment, config, style, now } = input;

  // Validation
  if (state.configId !== config.id) {
    throw new EngineError("bad_state", `configId mismatch: ${state.configId} !== ${config.id}`);
  }
  if (state.styleId !== style.id) {
    throw new EngineError("bad_state", `styleId mismatch: ${state.styleId} !== ${style.id}`);
  }
  if (state.problemIdx < 0 || state.problemIdx >= config.problems.length) {
    throw new EngineError("bad_state", `problemIdx out of range: ${state.problemIdx}`);
  }

  const problem = config.problems[state.problemIdx];

  // Definitions
  const effectivePhase = state.phase === "intro" ? "problem" : state.phase;
  const canInterject =
    state.lastInterjectAt === null ||
    now - state.lastInterjectAt >= style.interjection.cooldownMs;
  const confidentOffTrack =
    assessment !== null &&
    assessment.status === "off_track" &&
    assessment.confidence >= style.interjection.minConfidence;
  const timeUp = now - state.startedAt >= config.timing.maxMinutes * 60_000;

  function misconceptionFor(a: Assessment | null): string | null {
    if (a === null || a.misconceptionId === null) return null;
    const found = problem.misconceptions.find((m) => m.id === a.misconceptionId);
    return found ? found.id : null;
  }

  // Checkpoint merge helper
  function mergeCheckpoints(
    current: string[],
    newIds: string[] | undefined
  ): string[] {
    if (!newIds) return current;
    // Filter to valid checkpoint ids for this problem, in order
    const validIds = problem.checkpoints.map((c) => c.id);
    const orderedNewIds = newIds
      .filter((id) => validIds.includes(id))
      .sort((a, b) => validIds.indexOf(a) - validIds.indexOf(b));
    // Append only new ones
    const merged = [...current];
    for (const id of orderedNewIds) {
      if (!merged.includes(id)) {
        merged.push(id);
      }
    }
    return merged;
  }

  // advanceOrWrap: move to next problem or wrap_up
  function advanceOrWrap(
    baseState: EngineState,
    prefix: "solved" | "hints_exhausted"
  ): { state: EngineState; move: DecideResult["move"]; reason: DecisionReason } {
    const nextIdx = baseState.problemIdx + 1;
    if (nextIdx < config.problems.length) {
      return {
        state: {
          ...baseState,
          problemIdx: nextIdx,
          hintRung: -1,
          checkpointsHit: [],
          probesAsked: 0,
          turnWordBaseline: 0,
        },
        move: { type: "advance", toProblemIdx: nextIdx },
        reason: `${prefix}_advance` as const,
      };
    } else {
      return {
        state: { ...baseState, phase: "wrap_up" },
        move: { type: "wrap_up" },
        reason: `${prefix}_wrap_up` as const,
      };
    }
  }

  // stuckMove: give next hint, or advance/wrap
  function stuckMove(
    baseState: EngineState,
    reason: DecisionReason
  ): { state: EngineState; move: DecideResult["move"]; reason: DecisionReason } {
    const nextRung = baseState.hintRung + 1;
    if (nextRung < problem.hintLadder.length) {
      return {
        state: { ...baseState, hintRung: nextRung },
        move: { type: "hint", rung: nextRung },
        reason,
      };
    } else {
      return advanceOrWrap(baseState, "hints_exhausted");
    }
  }

  // wrapUp: move to wrap_up phase
  function wrapUp(baseState: EngineState): {
    state: EngineState;
    move: DecideResult["move"];
  } {
    return {
      state: { ...baseState, phase: "wrap_up" },
      move: { type: "wrap_up" },
    };
  }

  // === RULES (in order) ===

  // Rule 1: end event
  if (event.type === "end") {
    if (effectivePhase === "done") {
      return { state, move: { type: "silent" }, interrupt: false, reason: "phase_inactive" };
    }
    if (effectivePhase === "problem") {
      return { state: { ...state, phase: "done" }, move: { type: "wrap_up" }, interrupt: false, reason: "end" };
    }
    if (effectivePhase === "wrap_up") {
      return { state: { ...state, phase: "done" }, move: { type: "silent" }, interrupt: false, reason: "end" };
    }
  }

  // Rule 2: done phase
  if (effectivePhase === "done") {
    return { state, move: { type: "silent" }, interrupt: false, reason: "phase_inactive" };
  }

  // Rule 3: wrap_up phase
  if (effectivePhase === "wrap_up") {
    if (event.type === "turn_complete") {
      return {
        state: { ...state, turnWordBaseline: 0 },
        move: { type: "acknowledge" },
        interrupt: false,
        reason: "closing",
      };
    }
    return { state, move: { type: "silent" }, interrupt: false, reason: "phase_inactive" };
  }

  // Rule 4+: Problem phase
  // Apply checkpoint merge before processing
  let mergedState = state;
  if (assessment !== null) {
    const mergedCheckpoints = mergeCheckpoints(state.checkpointsHit, assessment.checkpointsHit);
    mergedState = { ...state, checkpointsHit: mergedCheckpoints };
  }

  // Helper to update phase to "problem" for intro states
  const finalPhase = state.phase === "intro" ? "problem" : state.phase;
  mergedState = { ...mergedState, phase: finalPhase };

  if (event.type === "partial") {
    const words = countWords(event.text);
    const newWords = Math.max(0, words - state.turnWordBaseline);

    if (canInterject && newWords >= style.interjection.minNewWords && confidentOffTrack) {
      return {
        state: {
          ...mergedState,
          lastInterjectAt: now,
          turnWordBaseline: words,
        },
        move: { type: "realign", misconceptionId: misconceptionFor(assessment) },
        interrupt: true,
        reason: "interject_off_track",
      };
    }
    return { state: mergedState, move: { type: "silent" }, interrupt: false, reason: "gated" };
  }

  if (event.type === "canvas") {
    if (canInterject && confidentOffTrack) {
      return {
        state: {
          ...mergedState,
          lastInterjectAt: now,
        },
        move: { type: "realign", misconceptionId: misconceptionFor(assessment) },
        interrupt: true,
        reason: "interject_off_track",
      };
    }
    return { state: mergedState, move: { type: "silent" }, interrupt: false, reason: "gated" };
  }

  if (event.type === "silence") {
    if (event.ms < config.timing.silenceStuckMs) {
      return { state: mergedState, move: { type: "silent" }, interrupt: false, reason: "silence_short" };
    }
    if (timeUp) {
      const { state: wrappedState, move } = wrapUp(mergedState);
      return { state: wrappedState, move, interrupt: false, reason: "time_up" };
    }
    const { state: stuckState, move, reason } = stuckMove(
      { ...mergedState, turnWordBaseline: 0 },
      "silence_stuck"
    );
    return { state: stuckState, move, interrupt: false, reason };
  }

  if (event.type === "turn_complete") {
    // Reset turnWordBaseline
    const baseState = { ...mergedState, turnWordBaseline: 0 };

    // 1. timeUp
    if (timeUp) {
      const { state: wrappedState, move } = wrapUp(baseState);
      return { state: wrappedState, move, interrupt: false, reason: "time_up" };
    }

    // 2. assessor unavailable
    if (assessment === null) {
      return { state: baseState, move: { type: "acknowledge" }, interrupt: false, reason: "assessor_unavailable" };
    }

    // 3. solved (all checkpoints hit)
    const allCheckpointsHit = problem.checkpoints.every((c) =>
      baseState.checkpointsHit.includes(c.id)
    );
    if (allCheckpointsHit) {
      const maxProbes = Math.min(PROBES_PER_PROBLEM, problem.probes.length);
      if (baseState.probesAsked < maxProbes) {
        return {
          state: { ...baseState, probesAsked: baseState.probesAsked + 1 },
          move: { type: "probe", probeIdx: baseState.probesAsked },
          interrupt: false,
          reason: "solved_probe",
        };
      }
      const { state: advancedState, move, reason } = advanceOrWrap(baseState, "solved");
      return { state: advancedState, move, interrupt: false, reason };
    }

    // 4. off_track with sufficient confidence
    if (assessment.status === "off_track" && assessment.confidence >= TURN_OFF_TRACK_MIN_CONFIDENCE) {
      return {
        state: baseState,
        move: { type: "realign", misconceptionId: misconceptionFor(assessment) },
        interrupt: false,
        reason: "off_track",
      };
    }

    // 5. stuck
    if (assessment.status === "stuck") {
      const { state: stuckState, move, reason } = stuckMove(baseState, "stuck");
      return { state: stuckState, move, interrupt: false, reason };
    }

    // 6. otherwise acknowledge (progressing, partial, correct)
    return { state: baseState, move: { type: "acknowledge" }, interrupt: false, reason: "progress" };
  }

  // Should never reach here (exhaustive)
  throw new EngineError("bad_state", `Unhandled event type: ${(event as { type: string }).type}`);
}

/**
 * Determine whether the assessor should be called.
 * Pure function - no side effects.
 */
export function shouldAssess(
  state: EngineState,
  event: DecideEvent,
  config: InterviewConfig,
  style: Style,
  now: number
): boolean {
  const effectivePhase = state.phase === "intro" ? "problem" : state.phase;

  if (effectivePhase !== "problem") {
    return false;
  }

  const timeUp = now - state.startedAt >= config.timing.maxMinutes * 60_000;
  const canInterject =
    state.lastInterjectAt === null ||
    now - state.lastInterjectAt >= style.interjection.cooldownMs;

  if (event.type === "turn_complete") {
    return !timeUp;
  }

  if (event.type === "partial") {
    const words = countWords(event.text);
    const newWords = Math.max(0, words - state.turnWordBaseline);
    return canInterject && newWords >= style.interjection.minNewWords;
  }

  if (event.type === "canvas") {
    return canInterject;
  }

  // silence, end, and other events
  return false;
}
