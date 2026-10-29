import type { Move } from "@/contracts";
import type { Script } from "./schema";
import type { StepOutcome } from "./replay";
import { T0 } from "./replay";

/**
 * Check that outcomes match script expectations.
 * Returns an array of error messages; empty array means pass.
 */
export function checkScript(script: Script, outcomes: StepOutcome[]): string[] {
  const errors: string[] = [];

  // Check implicit start (index -1)
  const startOutcome = outcomes.find((o) => o.index === -1);
  if (!startOutcome) {
    errors.push(`${script.id} start: missing implicit start outcome`);
    return errors;
  }

  // Start must be intro, !interrupt, !assessCalled, phase problem
  if (startOutcome.move.type !== "intro") {
    errors.push(`${script.id} start: move.type expected intro, got ${startOutcome.move.type}`);
  }
  if (startOutcome.interrupt !== false) {
    errors.push(`${script.id} start: interrupt expected false, got ${startOutcome.interrupt}`);
  }
  if (startOutcome.assessCalled !== false) {
    errors.push(`${script.id} start: assessCalled expected false, got ${startOutcome.assessCalled}`);
  }
  if (startOutcome.state.phase !== "problem") {
    errors.push(`${script.id} start: phase expected problem, got ${startOutcome.state.phase}`);
  }

  // Check each step
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    const expect = step.expect;
    const outcome = outcomes.find((o) => o.index === i);
    if (!outcome) {
      errors.push(`${script.id} step ${i}: missing outcome`);
      continue;
    }

    const eventType = step.event.type;
    const prefix = `${script.id} step ${i} (${eventType})`;

    // Check move.type
    if (outcome.move.type !== expect.move.type) {
      errors.push(`${prefix}: move.type expected ${expect.move.type}, got ${outcome.move.type}`);
    }

    // Check move fields if move type matches
    if (outcome.move.type === expect.move.type) {
      const move = outcome.move as Move;
      const expectedMove = expect.move;

      if (expectedMove.rung !== undefined && move.type === "hint") {
        const actualRung = move.rung;
        if (actualRung !== expectedMove.rung) {
          errors.push(`${prefix}: move.rung expected ${expectedMove.rung}, got ${actualRung}`);
        }
      }

      if (expectedMove.misconceptionId !== undefined && move.type === "realign") {
        const actualMisconceptionId = move.misconceptionId;
        if (actualMisconceptionId !== expectedMove.misconceptionId) {
          errors.push(`${prefix}: move.misconceptionId expected ${expectedMove.misconceptionId}, got ${actualMisconceptionId}`);
        }
      }

      if (expectedMove.probeIdx !== undefined && move.type === "probe") {
        const actualProbeIdx = move.probeIdx;
        if (actualProbeIdx !== expectedMove.probeIdx) {
          errors.push(`${prefix}: move.probeIdx expected ${expectedMove.probeIdx}, got ${actualProbeIdx}`);
        }
      }

      if (expectedMove.toProblemIdx !== undefined && move.type === "advance") {
        const actualToProblemIdx = move.toProblemIdx;
        if (actualToProblemIdx !== expectedMove.toProblemIdx) {
          errors.push(`${prefix}: move.toProblemIdx expected ${expectedMove.toProblemIdx}, got ${actualToProblemIdx}`);
        }
      }
    }

    // Check interrupt (always)
    if (outcome.interrupt !== expect.interrupt) {
      errors.push(`${prefix}: interrupt expected ${expect.interrupt}, got ${outcome.interrupt}`);
    }

    // Check assessCalled (always)
    if (outcome.assessCalled !== expect.assessCalled) {
      errors.push(`${prefix}: assessCalled expected ${expect.assessCalled}, got ${outcome.assessCalled}`);
    }

    // Check reason
    if (expect.reason !== undefined) {
      if (outcome.speakReason !== expect.reason) {
        errors.push(`${prefix}: reason expected ${expect.reason}, got ${outcome.speakReason}`);
      }
    }

    // Check state fields
    if (expect.state) {
      const state = outcome.state;
      const expectedState = expect.state;

      if (expectedState.phase !== undefined && state.phase !== expectedState.phase) {
        errors.push(`${prefix}: state.phase expected ${expectedState.phase}, got ${state.phase}`);
      }

      if (expectedState.problemIdx !== undefined && state.problemIdx !== expectedState.problemIdx) {
        errors.push(`${prefix}: state.problemIdx expected ${expectedState.problemIdx}, got ${state.problemIdx}`);
      }

      if (expectedState.hintRung !== undefined && state.hintRung !== expectedState.hintRung) {
        errors.push(`${prefix}: state.hintRung expected ${expectedState.hintRung}, got ${state.hintRung}`);
      }

      if (expectedState.checkpointsHit !== undefined) {
        if (!arrayEquals(state.checkpointsHit, expectedState.checkpointsHit)) {
          errors.push(`${prefix}: state.checkpointsHit expected ${JSON.stringify(expectedState.checkpointsHit)}, got ${JSON.stringify(state.checkpointsHit)}`);
        }
      }

      if (expectedState.probesAsked !== undefined && state.probesAsked !== expectedState.probesAsked) {
        errors.push(`${prefix}: state.probesAsked expected ${expectedState.probesAsked}, got ${state.probesAsked}`);
      }

      if (expectedState.turnWordBaseline !== undefined && state.turnWordBaseline !== expectedState.turnWordBaseline) {
        errors.push(`${prefix}: state.turnWordBaseline expected ${expectedState.turnWordBaseline}, got ${state.turnWordBaseline}`);
      }

      if (expectedState.lastInterjectAtMs !== undefined) {
        const actualLastInterjectMs = state.lastInterjectAt === null ? null : state.lastInterjectAt - T0;
        if (actualLastInterjectMs !== expectedState.lastInterjectAtMs) {
          errors.push(`${prefix}: state.lastInterjectAtMs expected ${expectedState.lastInterjectAtMs}, got ${actualLastInterjectMs}`);
        }
      }
    }

    // Check interviewerKind
    if (expect.interviewerKind !== undefined) {
      if (outcome.interviewerKind !== expect.interviewerKind) {
        errors.push(`${prefix}: interviewerKind expected ${expect.interviewerKind}, got ${outcome.interviewerKind}`);
      }
    }
  }

  return errors;
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
