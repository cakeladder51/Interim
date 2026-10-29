import { z } from "zod";

export const InterjectionPolicySchema = z.object({
  minConfidence: z.number().min(0).max(1),
  cooldownMs: z.number().int().min(0),
  minNewWords: z.number().int().min(0),
});

export type InterjectionPolicy = z.infer<typeof InterjectionPolicySchema>;

const nonEmptyString = z.string().min(1);

export const StyleSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  persona: nonEmptyString,
  tone: nonEmptyString,
  interjection: InterjectionPolicySchema,
});

export type Style = z.infer<typeof StyleSchema>;

export const CheckpointSchema = z.object({
  id: nonEmptyString,
  description: nonEmptyString,
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const MisconceptionSchema = z.object({
  id: nonEmptyString,
  signal: nonEmptyString,
  realign: nonEmptyString,
});

export type Misconception = z.infer<typeof MisconceptionSchema>;

export const ProblemSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  statement: nonEmptyString,
  canvasHint: nonEmptyString.optional(),
  checkpoints: z.array(CheckpointSchema).min(1),
  hintLadder: z.array(nonEmptyString).min(1),
  probes: z.array(nonEmptyString).min(1),
  misconceptions: z.array(MisconceptionSchema),
  solutionSketch: nonEmptyString,
});

export type Problem = z.infer<typeof ProblemSchema>;

export const RubricLevelSchema = z.object({
  score: z.number().int(),
  descriptor: nonEmptyString,
});

export type RubricLevel = z.infer<typeof RubricLevelSchema>;

export const RubricCriterionSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  levels: z.array(RubricLevelSchema).min(2),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z.object({
  criteria: z.array(RubricCriterionSchema).min(1),
});

export type Rubric = z.infer<typeof RubricSchema>;

export const InterviewConfigSchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    subject: nonEmptyString,
    styles: z.array(StyleSchema).min(1),
    problems: z.array(ProblemSchema).min(1),
    rubric: RubricSchema,
    timing: z.object({
      maxMinutes: z.number().int().positive(),
      silenceStuckMs: z.number().int().positive(),
    }),
    fallbackPrompt: nonEmptyString,
    asrKeywords: z.array(nonEmptyString).default([]),
  })
  .superRefine((config, ctx) => {
    // Check for duplicate styles
    const styleIds = config.styles.map((s) => s.id);
    const duplicateStyles = styleIds.filter(
      (id, index) => styleIds.indexOf(id) !== index
    );
    if (duplicateStyles.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate style ids: ${[...new Set(duplicateStyles)].join(", ")}`,
      });
    }

    // Check for duplicate problems
    const problemIds = config.problems.map((p) => p.id);
    const duplicateProblems = problemIds.filter(
      (id, index) => problemIds.indexOf(id) !== index
    );
    if (duplicateProblems.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate problem ids: ${[...new Set(duplicateProblems)].join(", ")}`,
      });
    }

    // Check for duplicate checkpoints within each problem
    config.problems.forEach((problem, problemIndex) => {
      const checkpointIds = problem.checkpoints.map((c) => c.id);
      const duplicateCheckpoints = checkpointIds.filter(
        (id, index) => checkpointIds.indexOf(id) !== index
      );
      if (duplicateCheckpoints.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate checkpoint ids in problem ${problemIndex}: ${[...new Set(duplicateCheckpoints)].join(", ")}`,
        });
      }

      // Check for duplicate misconceptions within each problem
      const misconceptionIds = problem.misconceptions.map((m) => m.id);
      const duplicateMisconceptions = misconceptionIds.filter(
        (id, index) => misconceptionIds.indexOf(id) !== index
      );
      if (duplicateMisconceptions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate misconception ids in problem ${problemIndex}: ${[...new Set(duplicateMisconceptions)].join(", ")}`,
        });
      }
    });

    // Check for duplicate rubric criteria
    const rubricIds = config.rubric.criteria.map((c) => c.id);
    const duplicateRubric = rubricIds.filter(
      (id, index) => rubricIds.indexOf(id) !== index
    );
    if (duplicateRubric.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate rubric criterion ids: ${[...new Set(duplicateRubric)].join(", ")}`,
      });
    }
  });

export type InterviewConfig = z.infer<typeof InterviewConfigSchema>;
