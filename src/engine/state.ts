import type { EngineState, TranscriptEntry } from "@/contracts";

export function createInitialState(
  configId: string,
  styleId: string,
  now: number
): EngineState {
  return {
    version: 1,
    configId,
    styleId,
    startedAt: now,
    phase: "intro",
    problemIdx: 0,
    hintRung: -1,
    checkpointsHit: [],
    lastInterjectAt: null,
    turnWordBaseline: 0,
    probesAsked: 0,
    transcript: [],
  };
}

export function appendTranscript(
  state: EngineState,
  entry: Omit<TranscriptEntry, "id">
): EngineState {
  const newEntry: TranscriptEntry = {
    ...entry,
    id: crypto.randomUUID(),
  };

  const newTranscript = [...state.transcript, newEntry];

  // Cap at 500 entries by dropping oldest
  if (newTranscript.length > 500) {
    newTranscript.shift();
  }

  return {
    ...state,
    transcript: newTranscript,
  };
}
