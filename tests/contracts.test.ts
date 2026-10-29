import { describe, it, expect } from "vitest";
import { toJSONSchema } from "zod";
import {
  InterviewConfigSchema,
  StepRequestSchema,
  EngineEventSchema,
  AssessmentSchema,
  ReportSchema,
} from "../src/contracts";

describe("contracts", () => {
  describe("InterviewConfig", () => {
    it("parses minimal valid config", () => {
      const config = {
        id: "maths-oxbridge",
        title: "Maths Interview",
        subject: "Mathematics",
        styles: [
          {
            id: "supportive",
            label: "Supportive",
            persona: "A supportive interviewer",
            tone: "Encouraging and patient",
            interjection: {
              minConfidence: 0.8,
              cooldownMs: 10000,
              minNewWords: 5,
            },
          },
        ],
        problems: [
          {
            id: "sqrt2-irrational",
            title: "Prove √2 is irrational",
            statement: "Prove that the square root of 2 is irrational.",
            checkpoints: [
              { id: "c1", description: "Assumes √2 = p/q with p, q coprime" },
            ],
            hintLadder: ["Hint 1", "Hint 2"],
            probes: ["What if we square both sides?"],
            misconceptions: [],
            solutionSketch: "Full proof",
          },
        ],
        rubric: {
          criteria: [
            {
              id: "clarity",
              name: "Clarity",
              levels: [
                { score: 1, descriptor: "Unclear" },
                { score: 2, descriptor: "Clear" },
              ],
            },
          ],
        },
        timing: { maxMinutes: 30, silenceStuckMs: 5000 },
        fallbackPrompt: "Let's move on.",
        asrKeywords: [],
      };

      const result = InterviewConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("rejects duplicate problem ids", () => {
      const config = {
        id: "maths-oxbridge",
        title: "Maths Interview",
        subject: "Mathematics",
        styles: [
          {
            id: "supportive",
            label: "Supportive",
            persona: "A supportive interviewer",
            tone: "Encouraging",
            interjection: { minConfidence: 0.8, cooldownMs: 10000, minNewWords: 5 },
          },
        ],
        problems: [
          {
            id: "same-id",
            title: "Problem 1",
            statement: "Statement 1",
            checkpoints: [{ id: "c1", description: "Check" }],
            hintLadder: ["Hint"],
            probes: ["Probe"],
            misconceptions: [],
            solutionSketch: "Solution",
          },
          {
            id: "same-id",
            title: "Problem 2",
            statement: "Statement 2",
            checkpoints: [{ id: "c1", description: "Check" }],
            hintLadder: ["Hint"],
            probes: ["Probe"],
            misconceptions: [],
            solutionSketch: "Solution",
          },
        ],
        rubric: {
          criteria: [
            {
              id: "clarity",
              name: "Clarity",
              levels: [
                { score: 1, descriptor: "Low" },
                { score: 2, descriptor: "High" },
              ],
            },
          ],
        },
        timing: { maxMinutes: 30, silenceStuckMs: 5000 },
        fallbackPrompt: "Fallback",
        asrKeywords: [],
      };

      const result = InterviewConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues.map((i) => i.message);
        expect(issues.some((m) => m.includes("Duplicate problem"))).toBe(true);
      }
    });
  });

  describe("StepRequest", () => {
    it("rejects state:null with non-start event", () => {
      const request = {
        state: null,
        event: { type: "turn_complete", text: "Hello", source: "voice" as const },
      };

      const result = StepRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it("rejects start event with non-null state", () => {
      const request = {
        state: {
          version: 1,
          configId: "test",
          styleId: "test",
          startedAt: 0,
          phase: "intro",
          problemIdx: 0,
          hintRung: -1,
          checkpointsHit: [],
          lastInterjectAt: null,
          turnWordBaseline: 0,
          probesAsked: 0,
          transcript: [],
        },
        event: { type: "start", configId: "test", styleId: "test" },
      };

      const result = StepRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it("accepts state:null with start event", () => {
      const request = {
        state: null,
        event: { type: "start", configId: "test", styleId: "test" },
      };

      const result = StepRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe("canvas event", () => {
    it("rejects canvas event without PNG data-URI prefix", () => {
      const event = {
        type: "canvas",
        image: "not a valid data URI",
      };

      const result = EngineEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it("accepts canvas event with PNG data-URI prefix", () => {
      const event = {
        type: "canvas",
        image: "data:image/png;base64,ABC123",
      };

      const result = EngineEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });
  });

  describe("Assessment JSON Schema", () => {
    it("converts cleanly with z.toJSONSchema", () => {
      const schema = toJSONSchema(AssessmentSchema);
      
      // Should not have $ref recursion
      const str = JSON.stringify(schema);
      expect(str).not.toContain("$ref");
      
      // Should have required properties
      expect(schema).toHaveProperty("type", "object");
    });
  });

  describe("Report JSON Schema", () => {
    it("converts cleanly with z.toJSONSchema", () => {
      const schema = toJSONSchema(ReportSchema);
      
      // Should not have $ref recursion
      const str = JSON.stringify(schema);
      expect(str).not.toContain("$ref");
      
      // Should have required properties
      expect(schema).toHaveProperty("type", "object");
    });
  });
});
