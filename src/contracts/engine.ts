import { z } from "zod";

export const PhaseSchema = z.enum(["intro", "problem", "wrap_up", "done"]);

export type Phase = z.infer<typeof PhaseSchema>;

export const TranscriptEntrySchema = z.object({
  id: z.string(),
  at: z.number().int().min(0),
  speaker: z.enum(["interviewer", "student"]),
  kind: z.enum(["utterance", "interjection", "typed"]),
  text: z.string(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const EngineStateSchema = z.object({
  version: z.literal(1),
  configId: z.string(),
  styleId: z.string(),
  startedAt: z.number().int(),
  phase: PhaseSchema,
  problemIdx: z.number().int().min(0),
  hintRung: z.number().int().min(-1),
  checkpointsHit: z.array(z.string()),
  lastInterjectAt: z.number().int().nullable(),
  turnWordBaseline: z.number().int().min(0),
  probesAsked: z.number().int().min(0),
  transcript: z.array(TranscriptEntrySchema).max(500),
});

export type EngineState = z.infer<typeof EngineStateSchema>;

export const EngineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    configId: z.string(),
    styleId: z.string(),
  }),
  z.object({
    type: z.literal("turn_complete"),
    text: z.string(),
    source: z.enum(["voice", "typed"]),
  }),
  z.object({
    type: z.literal("partial"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("canvas"),
    image: z.string().startsWith("data:image/png;base64,").max(1_500_000),
  }),
  z.object({
    type: z.literal("silence"),
    ms: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("end"),
  }),
]);

export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const MoveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("intro") }),
  z.object({ type: z.literal("hint"), rung: z.number().int().min(0) }),
  z.object({
    type: z.literal("realign"),
    misconceptionId: z.string().nullable(),
  }),
  z.object({ type: z.literal("probe"), probeIdx: z.number().int().min(0) }),
  z.object({ type: z.literal("acknowledge") }),
  z.object({ type: z.literal("advance"), toProblemIdx: z.number().int().min(0) }),
  z.object({ type: z.literal("wrap_up") }),
  z.object({ type: z.literal("silent") }),
]);

export type Move = z.infer<typeof MoveSchema>;

// Assessment and Report must convert cleanly to JSON Schema
// No transforms, refinements or defaults
export const AssessmentSchema = z.object({
  status: z.enum(["stuck", "progressing", "partial", "correct", "off_track"]),
  confidence: z.number().min(0).max(1),
  checkpointsHit: z.array(z.string()),
  misconceptionId: z.string().nullable(),
  evidence: z.string(),
});

export type Assessment = z.infer<typeof AssessmentSchema>;

export const ReportSchema = z.object({
  summary: z.string(),
  criteria: z.array(
    z.object({
      id: z.string(),
      score: z.number().int(),
      justification: z.string(),
    })
  ),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  keyMoments: z.array(
    z.object({
      at: z.number().int().min(0),
      quote: z.string(),
      note: z.string(),
    })
  ),
});

export type Report = z.infer<typeof ReportSchema>;
