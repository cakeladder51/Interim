import "server-only";

import type { InterviewConfig, Style, EngineState, Move, Assessment, EngineEvent } from "@/contracts";
import { createStepHandler, type StepDeps } from "@/server/step-handler";
import { runStepRequest } from "@/client/step-client";
import { getConfig, getStyle } from "@/config/load";
import { fallbackUtterance } from "@/engine/prompts";
import type { SpeakReason, DecideEvent } from "@/engine/types";
import type { Script } from "./schema";

/** Epoch ms baseline for replay timestamps */
export const T0 = 1_700_000_000_000;

export interface StepOutcome {
  index: number;  // -1 for implicit start, then 0..n-1
  move: Move;
  interrupt: boolean;
  utterance: string;
  state: EngineState;
  assessCalled: boolean;
  assessArgsStateTranscriptLength?: number;
  speakReason?: SpeakReason;
  interviewerKind?: "utterance" | "interjection";
  live?: { assessment: Assessment | null; latencyMs: number; error?: string };
}

export interface AssessArgs {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  event: Extract<DecideEvent, { type: "partial" | "turn_complete" | "canvas" }>;
  signal?: AbortSignal;
}

/**
 * Replay a script through the engine and capture outcomes.
 * In live mode, the real assessor is also called but the mock result is used for decisions.
 */
export async function replayScript(
  script: Script,
  opts?: { live?: { assess: (args: AssessArgs) => Promise<Assessment | null> }; onRequest?: (body: unknown) => void }
): Promise<StepOutcome[]> {
  const config = getConfig(script.configId);
  // style is retrieved to validate it exists, then used implicitly by assess
  getStyle(config, script.styleId);
  const outcomes: StepOutcome[] = [];

  // Track current atMs for now()
  let currentAtMs = 0;
  // Track step index for mock matching
  let stepIndex = -2; // -2 so first increment gives -1 for start

  // Track previous transcript length for assess args validation
  let prevTranscriptLength = 0;

  // Capture calls
  let currentAssessCalled = false;
  let currentAssessArgsStateTranscriptLength: number | undefined;
  let currentSpeakReason: SpeakReason | undefined;
  let currentLiveResult: { assessment: Assessment | null; latencyMs: number; error?: string } | undefined;

  // Create handler deps
  const deps: StepDeps = {
    now: () => T0 + currentAtMs,
    assess: async (args) => {
      currentAssessCalled = true;
      currentAssessArgsStateTranscriptLength = args.state.transcript.length;

      // If in live mode, also call the live assessor
      if (opts?.live) {
        const start = performance.now();
        try {
          const liveAssessment = await opts.live.assess(args);
          currentLiveResult = {
            assessment: liveAssessment,
            latencyMs: performance.now() - start,
          };
        } catch (err) {
          currentLiveResult = {
            assessment: null,
            latencyMs: performance.now() - start,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Return mock result
      const idx = stepIndex;
      if (idx < 0 || idx >= script.steps.length) {
        throw new Error(`Script ${script.id} step ${idx}: assess was called but step has no mock`);
      }
      const step = script.steps[idx]!;
      if (!step.mock) {
        throw new Error(`Script ${script.id} step ${idx}: assess was called but the step has no mock`);
      }
      return step.mock;
    },
    speak: async function* (args) {
      currentSpeakReason = args.reason;
      const text = fallbackUtterance({
        config,
        state: args.state,
        move: args.move,
        reason: args.reason,
      });
      // Yield text split by whitespace, preserving trailing space on each piece
      const pieces = text.match(/\S+\s*/g) ?? [];
      for (const piece of pieces) {
        yield piece;
      }
    },
  };

  const handler = createStepHandler(deps);

  // Track previous state for capturing interviewerKind
  let prevState: EngineState | null = null;

  // Run implicit start
  stepIndex = -1;
  currentAtMs = 0;
  currentAssessCalled = false;
  currentAssessArgsStateTranscriptLength = undefined;
  currentSpeakReason = undefined;
  currentLiveResult = undefined;
  prevTranscriptLength = 0;

  let startResult;
  try {
    startResult = await runStepRequest(
      { state: null, event: { type: "start", configId: script.configId, styleId: script.styleId } },
      {
        fetchImpl: (url, init) => {
          if (opts?.onRequest && init?.body) {
            opts.onRequest(JSON.parse(init.body as string));
          }
          return handler(new Request("http://test" + url, init));
        },
      }
    );
  } catch (err) {
    throw new Error(`Script ${script.id} start: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Capture outcome
  let outcome: StepOutcome = {
    index: stepIndex,
    move: startResult.move,
    interrupt: startResult.interrupt,
    utterance: startResult.utterance,
    state: startResult.state,
    assessCalled: currentAssessCalled,
    assessArgsStateTranscriptLength: currentAssessArgsStateTranscriptLength,
    speakReason: currentSpeakReason,
  };

  // Check if interviewer entry was added
  if (startResult.state.transcript.length > 0) {
    const lastEntry = startResult.state.transcript[startResult.state.transcript.length - 1];
    if (lastEntry?.speaker === "interviewer") {
      outcome.interviewerKind = lastEntry.kind as "utterance" | "interjection";
    }
  }

  outcomes.push(outcome);
  prevState = startResult.state;
  prevTranscriptLength = startResult.state.transcript.length;

  // Run each script step
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    stepIndex = i;
    currentAtMs = step.atMs;
    currentAssessCalled = false;
    currentAssessArgsStateTranscriptLength = undefined;
    currentSpeakReason = undefined;
    currentLiveResult = undefined;

    // Build event (strip 'words' from partial events)
    let event: EngineEvent;
    if (step.event.type === "partial") {
      event = { type: "partial", text: step.event.text };
    } else {
      event = step.event as EngineEvent;
    }

    const requestState = prevState;
    let result;
    try {
      result = await runStepRequest(
        { state: requestState, event },
        {
          fetchImpl: (url, init) => {
            if (opts?.onRequest && init?.body) {
              opts.onRequest(JSON.parse(init.body as string));
            }
            return handler(new Request("http://test" + url, init));
          },
        }
      );
    } catch (err) {
      throw new Error(`Script ${script.id} step ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Capture outcome
    outcome = {
      index: stepIndex,
      move: result.move,
      interrupt: result.interrupt,
      utterance: result.utterance,
      state: result.state,
      assessCalled: currentAssessCalled,
      assessArgsStateTranscriptLength: currentAssessArgsStateTranscriptLength,
      speakReason: currentSpeakReason,
      live: currentLiveResult,
    };

    // Check if interviewer entry was added
    if (result.state.transcript.length > prevTranscriptLength) {
      const lastEntry = result.state.transcript[result.state.transcript.length - 1];
      if (lastEntry?.speaker === "interviewer") {
        outcome.interviewerKind = lastEntry.kind as "utterance" | "interjection";
      }
    }

    outcomes.push(outcome);
    prevState = result.state;
    prevTranscriptLength = result.state.transcript.length;
  }

  return outcomes;
}
