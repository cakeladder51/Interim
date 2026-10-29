import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fakeReport,
  fakeGenerate,
  FAKE_FEEDBACK_DELAY_MS,
} from "../src/server/fake-feedback";
import { selectFeedbackDeps } from "../src/server/feedback-deps";
import { generateReport } from "../src/server/feedback";
import { fakeGenerate as fakeGenerateFromDepsImport } from "../src/server/fake-feedback";
import { getConfig } from "../src/config/load";
import { toFeedbackView } from "../src/server/feedback";
import type { EngineState } from "@/contracts";

const maths = getConfig("maths-oxbridge");

function makeStateWithNEntries(n: number): EngineState {
  const transcript: EngineState["transcript"] = [];
  // Entry 0 starts at 1000ms with specific text
  for (let i = 0; i < n; i++) {
    transcript.push({
      id: `s${i}`,
      at: 1000 * (i + 1),
      speaker: "student",
      kind: "typed",
      text: i === 0 ? "  one two three four five six seven eight nine ten " : "x",
    });
  }
  // Add an interviewer entry
  transcript.unshift({
    id: "intro",
    at: 0,
    speaker: "interviewer",
    kind: "utterance",
    text: "Welcome.",
  });

  return {
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
    transcript,
  };
}

describe("fake-feedback", () => {
  describe("1. fakeReport with various transcript lengths", () => {
    const testCases: { n: number; summary: string; expectedScore: number; justification: string }[] = [
      { n: 1, summary: "Offline practice feedback: you answered 1 time.", expectedScore: 1, justification: "Offline estimate from 1 answer." },
      { n: 2, summary: "Offline practice feedback: you answered 2 times.", expectedScore: 1, justification: "Offline estimate from 2 answers." },
      { n: 3, summary: "Offline practice feedback: you answered 3 times.", expectedScore: 2, justification: "Offline estimate from 3 answers." },
      { n: 5, summary: "Offline practice feedback: you answered 5 times.", expectedScore: 2, justification: "Offline estimate from 5 answers." },
      { n: 6, summary: "Offline practice feedback: you answered 6 times.", expectedScore: 3, justification: "Offline estimate from 6 answers." },
      { n: 9, summary: "Offline practice feedback: you answered 9 times.", expectedScore: 4, justification: "Offline estimate from 9 answers." },
      { n: 12, summary: "Offline practice feedback: you answered 12 times.", expectedScore: 4, justification: "Offline estimate from 12 answers." },
    ];

    for (const { n, summary, expectedScore, justification } of testCases) {
      it(`n=${n} produces correct summary, score, justification`, () => {
        const state = makeStateWithNEntries(n);
        const report = fakeReport(maths, state);

        expect(report.summary).toBe(summary);

        // Check all criteria ids in order
        expect(report.criteria.map((c) => c.id)).toEqual([
          "approach",
          "rigour",
          "communication",
          "responsiveness",
        ]);

        // Check all criteria have expected score and justification
        for (const c of report.criteria) {
          expect(c.score).toBe(expectedScore);
          expect(c.justification).toBe(justification);
        }

        // Check strengths and improvements
        expect(report.strengths).toEqual(["You kept going and shared your thinking."]);
        expect(report.improvements).toEqual(["Justify each step before moving on."]);

        // Check keyMoments
        expect(report.keyMoments).toEqual([
          {
            at: 1000,
            quote: "one two three four five six seven eight",
            note: "Your first answer.",
          },
        ]);

        // toFeedbackView doesn't throw
        expect(() => toFeedbackView(maths, state, report)).not.toThrow();
      });
    }
  });

  describe("2. fakeGenerate behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves after delay and returns report", async () => {
      const state = makeStateWithNEntries(1);
      const promise = fakeGenerate({ config: maths, style: maths.styles[0], state });

      // Advance time
      await vi.advanceTimersByTimeAsync(FAKE_FEEDBACK_DELAY_MS);

      const result = await promise;
      expect(result.summary).toBe("Offline practice feedback: you answered 1 time.");
    });

    it("throws AbortError when signal is aborted during wait", async () => {
      const state = makeStateWithNEntries(1);
      const controller = new AbortController();

      // Set up a catch handler before advancing timers
      let caught = false;
      const promise = fakeGenerate({
        config: maths,
        style: maths.styles[0],
        state,
        signal: controller.signal,
      }).catch((err) => {
        caught = true;
        expect((err as Error).name).toBe("AbortError");
        return null;
      });

      // Abort before delay completes
      controller.abort();

      // Advance time
      await vi.advanceTimersByTimeAsync(FAKE_FEEDBACK_DELAY_MS);

      // Wait for the promise to settle
      await promise;
      expect(caught).toBe(true);
    });
  });

  describe("3. selectFeedbackDeps", () => {
    it('INTERIM_FAKE_MODEL="1" and NODE_ENV="development" returns fake', () => {
      const deps = selectFeedbackDeps({
        INTERIM_FAKE_MODEL: "1",
        NODE_ENV: "development",
      });
      expect(deps.generate).toBe(fakeGenerateFromDepsImport);
      expect(deps.modelLabel).toBe("fake");
    });

    it('INTERIM_FAKE_MODEL="1" and NODE_ENV="production" returns real', () => {
      const deps = selectFeedbackDeps({
        INTERIM_FAKE_MODEL: "1",
        NODE_ENV: "production",
      });
      expect(deps.generate).toBe(generateReport);
      expect(deps.modelLabel).toBeUndefined();
    });

    it('INTERIM_FAKE_MODEL="true" returns real', () => {
      const deps = selectFeedbackDeps({
        INTERIM_FAKE_MODEL: "true",
        NODE_ENV: "development",
      });
      expect(deps.generate).toBe(generateReport);
      expect(deps.modelLabel).toBeUndefined();
    });

    it("empty env returns real", () => {
      const deps = selectFeedbackDeps({});
      expect(deps.generate).toBe(generateReport);
      expect(deps.modelLabel).toBeUndefined();
    });
  });
});
