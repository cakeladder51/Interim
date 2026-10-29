import type {
  EngineEvent,
  EngineState,
  Assessment,
  InterviewConfig,
  Style,
  Move,
} from "@/contracts";

export type DecideEvent = Exclude<EngineEvent, { type: "start" }>;

export type DecisionReason =
  | "phase_inactive"
  | "end"
  | "closing"
  | "gated"
  | "interject_off_track"
  | "silence_short"
  | "silence_stuck"
  | "time_up"
  | "assessor_unavailable"
  | "solved_probe"
  | "solved_advance"
  | "solved_wrap_up"
  | "hints_exhausted_advance"
  | "hints_exhausted_wrap_up"
  | "off_track"
  | "stuck"
  | "progress";

export interface DecideInput {
  state: EngineState;
  event: DecideEvent;
  assessment: Assessment | null; // null = not assessed or the assessor failed
  config: InterviewConfig;
  style: Style;
  now: number; // epoch ms, supplied by the caller
}

export interface DecideResult {
  state: EngineState;
  move: Move;
  interrupt: boolean; // true only for mid-answer interjections (partial/canvas)
  reason: DecisionReason;
}

export type SpeakReason = DecisionReason | "intro";
