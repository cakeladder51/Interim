import { z } from "zod";
import { AssessmentSchema } from "@/contracts";

/**
 * Count whitespace-separated non-empty tokens.
 * Must match src/engine/fsm.ts countWords exactly.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

// Event types for scripts (partial has words field)
export const ScriptPartialEventSchema = z.object({
  type: z.literal("partial"),
  text: z.string(),
  words: z.number().int().nonnegative(),
});

export const ScriptTurnCompleteEventSchema = z.object({
  type: z.literal("turn_complete"),
  text: z.string(),
  source: z.enum(["voice", "typed"]),
});

export const ScriptCanvasEventSchema = z.object({
  type: z.literal("canvas"),
  image: z.string().startsWith("data:image/png;base64,").max(1_500_000),
});

export const ScriptSilenceEventSchema = z.object({
  type: z.literal("silence"),
  ms: z.number().int().positive(),
});

export const ScriptEndEventSchema = z.object({
  type: z.literal("end"),
});

export const ScriptEventSchema = z.discriminatedUnion("type", [
  ScriptPartialEventSchema,
  ScriptTurnCompleteEventSchema,
  ScriptCanvasEventSchema,
  ScriptSilenceEventSchema,
  ScriptEndEventSchema,
]);

// Live expectation schema (used for live eval)
export const LiveExpectSchema = z.object({
  status: z.array(z.enum(["stuck", "progressing", "partial", "correct", "off_track"])).min(1),
  misconceptionId: z.string().nullable().optional(),
});

// Expectation schema (used for deterministic checks)
export const ExpectSchema = z.object({
  move: z.object({
    type: z.enum(["intro", "hint", "realign", "probe", "acknowledge", "advance", "wrap_up", "silent"]),
    rung: z.number().int().optional(),
    misconceptionId: z.string().nullable().optional(),
    probeIdx: z.number().int().optional(),
    toProblemIdx: z.number().int().optional(),
  }),
  interrupt: z.boolean().default(false),
  assessCalled: z.boolean(),
  reason: z.string().optional(),
  state: z.object({
    phase: z.enum(["intro", "problem", "wrap_up", "done"]).optional(),
    problemIdx: z.number().int().optional(),
    hintRung: z.number().int().optional(),
    checkpointsHit: z.array(z.string()).optional(),
    probesAsked: z.number().int().optional(),
    turnWordBaseline: z.number().int().optional(),
    lastInterjectAtMs: z.number().int().nullable().optional(),
  }).optional(),
  interviewerKind: z.enum(["utterance", "interjection"]).optional(),
});

// Script step schema
export const ScriptStepSchema = z.object({
  atMs: z.number().int().positive(),
  event: ScriptEventSchema,
  mock: AssessmentSchema.optional(),
  expect: ExpectSchema,
  live: LiveExpectSchema.optional(),
  note: z.string().optional(),
});

// Full script schema (base, before refinements)
const ScriptBaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  configId: z.string(),
  styleId: z.string(),
  steps: z.array(ScriptStepSchema).min(1),
});

// Script schema with refinements
export const ScriptSchema = ScriptBaseSchema.superRefine((script, ctx) => {
  // Check atMs is strictly increasing
  for (let i = 1; i < script.steps.length; i++) {
    if (script.steps[i]!.atMs <= script.steps[i - 1]!.atMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${i}: atMs must be strictly increasing`,
        path: ["steps", i, "atMs"],
      });
    }
  }

  // Check assessCalled consistency
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    const expectsAssess = step.expect.assessCalled;
    const hasMock = step.mock !== undefined;
    if (expectsAssess !== hasMock) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${i}: assessCalled must equal presence of mock`,
        path: ["steps", i, "expect", "assessCalled"],
      });
    }
  }

  // Check live is only allowed when assessCalled is true and not on canvas steps
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    if (step.live !== undefined) {
      if (!step.expect.assessCalled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${i}: live is only allowed when assessCalled is true`,
          path: ["steps", i, "live"],
        });
      }
      if (step.event.type === "canvas") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${i}: live is not allowed on canvas steps`,
          path: ["steps", i, "live"],
        });
      }
    }
  }

  // Check partial word counts
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    if (step.event.type === "partial") {
      const expectedWords = countWords(step.event.text);
      if (step.event.words !== expectedWords) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${i}: partial words (${step.event.words}) doesn't match countWords(text) = ${expectedWords}`,
          path: ["steps", i, "event", "words"],
        });
      }
    }
  }

  // Check reason not allowed on silent moves
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    if (step.expect.move.type === "silent" && step.expect.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${i}: reason is not allowed when move.type is "silent"`,
        path: ["steps", i, "expect", "reason"],
      });
    }
  }
});

export type Script = z.infer<typeof ScriptSchema>;
export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;
export type Expect = z.infer<typeof ExpectSchema>;
export type LiveExpect = z.infer<typeof LiveExpectSchema>;
