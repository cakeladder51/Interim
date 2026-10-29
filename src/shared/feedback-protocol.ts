import { z } from "zod";
import { EngineStateSchema } from "@/contracts";

export const FEEDBACK_MAX_BODY_BYTES = 1_000_000;

export const FeedbackRequestSchema = z.object({ state: EngineStateSchema });
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export const FeedbackViewSchema = z.object({
  summary: z.string().min(1),
  criteria: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        score: z.number().int(),
        maxScore: z.number().int(),
        descriptor: z.string(),
        justification: z.string(),
      })
    )
    .min(1),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  keyMoments: z.array(z.object({ at: z.number().int().min(0), quote: z.string(), note: z.string() })),
  modelLabel: z.string().optional(),
});
export type FeedbackView = z.infer<typeof FeedbackViewSchema>;
