import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  toFeedbackView,
  noAnswerView,
  buildFeedbackMessages,
  normalizeText,
  FeedbackInvalidError,
} from "../src/server/feedback";
import { getConfig, getStyle } from "../src/config/load";
import { InterviewConfigSchema } from "@/contracts";
import type { EngineState, Report } from "@/contracts";
import type OpenAI from "openai";

const maths = getConfig("maths-oxbridge");

// F1 transcript and state
const T = [
  { id: "e1", at: 0, speaker: "interviewer" as const, kind: "utterance" as const, text: "Welcome. Let's begin." },
  { id: "e2", at: 5000, speaker: "student" as const, kind: "typed" as const, text: "I think   the answer is\nroot two" },
  { id: "e3", at: 5000, speaker: "interviewer" as const, kind: "utterance" as const, text: "Why is that?" },
  { id: "e4", at: 9000, speaker: "student" as const, kind: "typed" as const, text: "Because it can't be a fraction." },
];

const state: EngineState = {
  version: 1,
  configId: "maths-oxbridge",
  styleId: "supportive",
  startedAt: 1000,
  phase: "done",
  problemIdx: 0,
  hintRung: -1,
  checkpointsHit: [],
  lastInterjectAt: null,
  turnWordBaseline: 0,
  probesAsked: 0,
  transcript: T,
};

const R: Report = {
  summary: "  Good start.  ",
  criteria: [
    { id: "rigour", score: 3, justification: "Mostly right." },
    { id: "approach", score: 2, justification: " Needed a hint. " },
    { id: "responsiveness", score: 4, justification: "Quick." },
    { id: "communication", score: 1, justification: "Quiet." },
  ],
  strengths: ["Clear.", "  ", "Kept going."],
  improvements: ["i1", "i2", "i3", "i4", "i5", "i6"],
  keyMoments: [
    { at: 9000, quote: "can't be a fraction", note: "Good insight." },
    { at: 5000, quote: "the answer is  root two", note: "First idea." },
    { at: 5000, quote: "Why is that", note: "Interviewer line." },
    { at: 1234, quote: "root two", note: "Wrong time." },
    { at: 9000, quote: "   ", note: "Empty quote." },
    { at: 9000, quote: "fraction", note: "  " },
  ],
};

describe("feedback-view", () => {
  describe("1. F1: toFeedbackView with maths and state", () => {
    it("returns the expected view", () => {
      const view = toFeedbackView(maths, state, R);
      expect(view).toEqual({
        summary: "Good start.",
        criteria: [
          { id: "approach", name: "Problem-solving approach", score: 2, maxScore: 4, descriptor: "Finds a way in only after substantial hints.", justification: "Needed a hint." },
          { id: "rigour", name: "Rigour and correctness", score: 3, maxScore: 4, descriptor: "Correct, with minor gaps in justification.", justification: "Mostly right." },
          { id: "communication", name: "Thinking aloud", score: 1, maxScore: 4, descriptor: "Rarely explains thinking; hard to follow.", justification: "Quiet." },
          { id: "responsiveness", name: "Responding to hints", score: 4, maxScore: 4, descriptor: "Picks up subtle hints immediately and builds on them.", justification: "Quick." },
        ],
        strengths: ["Clear.", "Kept going."],
        improvements: ["i1", "i2", "i3", "i4", "i5"],
        keyMoments: [
          { at: 5000, quote: "the answer is root two", note: "First idea." },
          { at: 9000, quote: "can't be a fraction", note: "Good insight." },
        ],
      });
      expect("modelLabel" in view).toBe(false);
    });
  });

  describe("2. FeedbackInvalidError cases", () => {
    it("F2: criteria without rigour throws", () => {
      const report = { ...R, criteria: R.criteria.slice(1) };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F3: duplicate criterion throws", () => {
      const report = {
        ...R,
        criteria: [...R.criteria.slice(1), { id: "approach", score: 1, justification: "x" }],
      };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F4: unknown criterion id throws", () => {
      const report = {
        ...R,
        criteria: [...R.criteria.slice(1), { id: "creativity", score: 2, justification: "x" }],
      };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F5: rigour score 5 throws", () => {
      const report = {
        ...R,
        criteria: R.criteria.map((c) =>
          c.id === "rigour" ? { ...c, score: 5 } : c
        ),
      };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F6: rigour score 0 throws", () => {
      const report = {
        ...R,
        criteria: R.criteria.map((c) =>
          c.id === "rigour" ? { ...c, score: 0 } : c
        ),
      };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F7: empty summary throws", () => {
      const report = { ...R, summary: "   " };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });

    it("F8: extra criterion throws", () => {
      const report = {
        ...R,
        criteria: [...R.criteria, { id: "creativity", score: 2, justification: "x" }],
      };
      expect(() => toFeedbackView(maths, state, report)).toThrow(FeedbackInvalidError);
    });
  });

  describe("3. NA: noAnswerView", () => {
    it("returns the expected no-answer view", () => {
      const view = noAnswerView(maths);
      expect(view).toEqual({
        summary: "You didn't answer any questions in this interview, so there's nothing to score yet. Try again and talk through your thinking out loud.",
        criteria: [
          { id: "approach", name: "Problem-solving approach", score: 1, maxScore: 4, descriptor: "Doesn't find a way in, even with hints.", justification: "No answer was given." },
          { id: "rigour", name: "Rigour and correctness", score: 1, maxScore: 4, descriptor: "Key steps are wrong or missing.", justification: "No answer was given." },
          { id: "communication", name: "Thinking aloud", score: 1, maxScore: 4, descriptor: "Rarely explains thinking; hard to follow.", justification: "No answer was given." },
          { id: "responsiveness", name: "Responding to hints", score: 1, maxScore: 4, descriptor: "Ignores or can't use hints.", justification: "No answer was given." },
        ],
        strengths: [],
        improvements: ["Answer out loud, even when you're unsure: the interviewer can only help with what they hear."],
        keyMoments: [],
      });
    });
  });

  describe("4. Exact prompt with synthetic config", () => {
    it("builds the exact messages", () => {
      const TC = {
        id: "t",
        title: "Test interview",
        subject: "Mathematics",
        styles: [{ id: "s", label: "Supportive", persona: "p", tone: "t", interjection: { minConfidence: 0.7, cooldownMs: 0, minNewWords: 0 } }],
        problems: [
          {
            id: "p1",
            title: "Roots",
            statement: "Is the square root of 2 rational?",
            checkpoints: [{ id: "c1", description: "d" }],
            hintLadder: ["h"],
            probes: ["q"],
            misconceptions: [],
            solutionSketch: "Assume p/q in lowest terms.",
          },
        ],
        rubric: {
          criteria: [
            { id: "approach", name: "Approach", levels: [{ score: 1, descriptor: "Weak." }, { score: 2, descriptor: "Strong." }] },
            { id: "clarity", name: "Clarity", levels: [{ score: 1, descriptor: "Unclear." }, { score: 2, descriptor: "Clear." }] },
          ],
        },
        timing: { maxMinutes: 10, silenceStuckMs: 20000 },
        fallbackPrompt: "f",
        asrKeywords: [],
      };

      // Parse to validate
      expect(() => InterviewConfigSchema.parse(TC)).not.toThrow();
      const parsed = InterviewConfigSchema.parse(TC);

      const ts: EngineState = {
        version: 1,
        configId: "t",
        styleId: "s",
        startedAt: 0,
        phase: "done",
        problemIdx: 0,
        hintRung: -1,
        checkpointsHit: [],
        lastInterjectAt: null,
        turnWordBaseline: 0,
        probesAsked: 0,
        transcript: [
          { id: "a", at: 0, speaker: "interviewer", kind: "utterance", text: "Hello." },
          { id: "b", at: 4000, speaker: "student", kind: "utterance", text: "It is   rational\nI think" },
          { id: "c", at: 4000, speaker: "interviewer", kind: "interjection", text: "Hold on." },
        ],
      };

      const messages = buildFeedbackMessages(parsed, parsed.styles[0], ts);

      // System prompt
      expect(messages[0]).toEqual({
        role: "system",
        content: `You are an experienced Oxbridge admissions interviewer writing feedback for a student after a practice interview in Mathematics. Score the student against the rubric using only what the transcript shows. Be specific and kind, address the student as "you", and never invent anything the student didn't say. Reply with JSON only.`,
      });

      // User content
      const expectedUserContent = `Interview: Test interview
Interviewer style: Supportive

Problems:
1. Roots: Is the square root of 2 rational?
   Model solution (for scoring only; never quote it): Assume p/q in lowest terms.

Rubric (give each criterion exactly one of its level scores):
- approach (Approach):
  1: Weak.
  2: Strong.
- clarity (Clarity):
  1: Unclear.
  2: Clear.

Transcript (ms from the start, then speaker):
[0] Interviewer: Hello.
[4000] Student: It is rational I think
[4000] Interviewer (interrupting): Hold on.

Return a JSON object with:
- summary: 2-3 sentences on the overall performance.
- criteria: one entry per rubric criterion, with its id, the chosen score, and a one-sentence justification that cites what the student said or did.
- strengths: up to 3 short points.
- improvements: up to 3 short, actionable points.
- keyMoments: up to 3 moments from the student's lines, each with the exact "at" value of that line, a short exact quote from it, and a note.`;

      expect(messages[1].content).toBe(expectedUserContent);
    });
  });

  describe("5. normalizeText", () => {
    it("normalizes whitespace", () => {
      expect(normalizeText("  a \n b\t\tc ")).toBe("a b c");
      expect(normalizeText("   ")).toBe("");
    });
  });

  describe("6. generateReport with fake client", () => {
    beforeEach(() => {
      vi.stubEnv("MODEL_API_KEY", "test-key");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("calls chatJSON with correct arguments and returns the report", async () => {
      // Import dynamically after env stub
      const feedbackMod = await import("../src/server/feedback");
      const config = getConfig("maths-oxbridge");
      const sty = getStyle(config, "supportive");

      // Create a fake client with proper OpenAI mock
      const createMock = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(R) } }],
      });

      const fakeClient = {
        chat: {
          completions: {
            create: createMock,
          },
        },
      };

      const result = await feedbackMod.generateReport({
        config,
        style: sty,
        state,
        client: fakeClient as unknown as OpenAI,
      });

      // Check result
      expect(result).toEqual(R);

      // Check the request
      const callArgs = createMock.mock.calls[0][0];
      expect(callArgs.response_format.json_schema.name).toBe("Report");

      // Check messages
      const expectedMessages = feedbackMod.buildFeedbackMessages(config, sty, state);
      expect(callArgs.messages).toEqual(expectedMessages);
    });
  });
});
