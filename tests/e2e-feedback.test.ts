import { describe, it, expect, vi } from "vitest";
import { createStepHandler } from "../src/server/step-handler";
import { fakeAssess, fakeSpeak } from "../src/server/fake-model";
import { createFeedbackHandler } from "../src/server/feedback-handler";
import { fakeGenerate } from "../src/server/fake-feedback";
import { runStepRequest } from "../src/client/step-client";
import { fetchFeedback } from "../src/client/feedback-client";
import { getConfig, getStyle } from "../src/config/load";
import type { StepRequest } from "@/contracts";

const config = getConfig("maths-oxbridge");
const style = getStyle(config, "supportive");

describe("e2e-feedback", () => {
  it("1. Text interview → feedback", { timeout: 30000 }, async () => {
    vi.useRealTimers();

    // Create step handler with fake model
    const now = vi.fn(() => 1_000_000);
    const stepHandler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    // Run start
    const startRequest: StepRequest = {
      state: null,
      event: { type: "start", configId: config.id, styleId: style.id },
    };

    const result1 = await runStepRequest(startRequest, {
      fetchImpl: (url, init) => stepHandler(new Request("http://test" + url, init)),
    });

    expect(result1.state.phase).toBe("problem");

    // Now 10 seconds later, send "I don't know"
    now.mockReturnValue(1_010_000);
    const stepHandler2 = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const turnRequest: StepRequest = {
      state: result1.state,
      event: { type: "turn_complete", text: "I don't know", source: "typed" },
    };

    const result2 = await runStepRequest(turnRequest, {
      fetchImpl: (url, init) => stepHandler2(new Request("http://test" + url, init)),
    });

    expect(result2.move.type).toBe("hint");

    // End interview
    now.mockReturnValue(1_020_000);
    const stepHandler3 = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    const endRequest: StepRequest = {
      state: result2.state,
      event: { type: "end" },
    };

    const result3 = await runStepRequest(endRequest, {
      fetchImpl: (url, init) => stepHandler3(new Request("http://test" + url, init)),
    });

    const finalState = result3.state;
    expect(finalState.phase).toBe("done");

    // Check transcript has 4 entries
    expect(finalState.transcript.length).toBe(4);
    expect(finalState.transcript.map((e) => e.speaker)).toEqual([
      "interviewer",
      "student",
      "interviewer",
      "interviewer",
    ]);
    expect(finalState.transcript.map((e) => e.kind)).toEqual([
      "utterance",
      "typed",
      "utterance",
      "utterance",
    ]);
    expect(finalState.transcript.map((e) => e.at)).toEqual([0, 10000, 10000, 20000]);

    // 2. Call feedback
    const feedbackHandler = createFeedbackHandler({
      generate: fakeGenerate,
      modelLabel: "fake",
      sleep: async () => {},
    });

    const feedback = await fetchFeedback(finalState, {
      fetchImpl: (url, init) => feedbackHandler(new Request("http://test" + url, init)),
    });

    expect(feedback).toEqual({
      summary: "Offline practice feedback: you answered 1 time.",
      criteria: [
        {
          id: "approach",
          name: "Problem-solving approach",
          score: 1,
          maxScore: 4,
          descriptor: "Doesn't find a way in, even with hints.",
          justification: "Offline estimate from 1 answer.",
        },
        {
          id: "rigour",
          name: "Rigour and correctness",
          score: 1,
          maxScore: 4,
          descriptor: "Key steps are wrong or missing.",
          justification: "Offline estimate from 1 answer.",
        },
        {
          id: "communication",
          name: "Thinking aloud",
          score: 1,
          maxScore: 4,
          descriptor: "Rarely explains thinking; hard to follow.",
          justification: "Offline estimate from 1 answer.",
        },
        {
          id: "responsiveness",
          name: "Responding to hints",
          score: 1,
          maxScore: 4,
          descriptor: "Ignores or can't use hints.",
          justification: "Offline estimate from 1 answer.",
        },
      ],
      strengths: ["You kept going and shared your thinking."],
      improvements: ["Justify each step before moving on."],
      keyMoments: [{ at: 10000, quote: "I don't know", note: "Your first answer." }],
      modelLabel: "fake",
    });

    // 3. Call feedback with pre-end state → error
    await expect(
      fetchFeedback(result2.state, {
        fetchImpl: (url, init) => feedbackHandler(new Request("http://test" + url, init)),
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "not_finished",
      retryable: false,
    });
  });
});
