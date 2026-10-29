import { describe, it, expect, vi } from "vitest";
import { loadScripts } from "../src/eval/load-scripts";
import { replayScript } from "../src/eval/replay";
import { checkScript } from "../src/eval/expect";
import type { Assessment } from "@/contracts";

describe("eval live mode", () => {
  it("records live results only for steps where assessCalled is true", async () => {
    const scripts = loadScripts("evals/scripts");
    const script = scripts.find((s) => s.id === "stuck-then-recovers")!;
    
    let assessCallCount = 0;
    const fakeLive = vi.fn(async (): Promise<Assessment> => {
      assessCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: "stuck", confidence: 0.7, checkpointsHit: [], misconceptionId: null, evidence: "test" };
    });

    const outcomes = await replayScript(script, {
      live: { assess: fakeLive },
    });

    // Check that step 0 (assessCalled: true) has live result
    const step0 = outcomes[1]; // Index 0 step is at index 1 (index -1 is start)
    expect(step0?.assessCalled).toBe(true);
    expect(step0?.live).toBeDefined();
    expect(step0?.live?.latencyMs).toBeGreaterThanOrEqual(0);

    // Check that all steps marked as assessCalled have live results
    outcomes.forEach((outcome) => {
      if (outcome.index >= 0) {
        const step = script.steps[outcome.index];
        if (step?.expect.assessCalled) {
          expect(outcome.live).toBeDefined();
          expect(outcome.live?.latencyMs).toBeGreaterThanOrEqual(0);
        }
      }
    });

    // At least 1 step should have been assessed
    expect(assessCallCount).toBeGreaterThanOrEqual(1);
  });

  it("latencyMs is non-negative", async () => {
    const scripts = loadScripts("evals/scripts");
    const script = scripts.find((s) => s.id === "right-first-time")!;
    
    const fakeLive = vi.fn(async (): Promise<Assessment> => ({
      status: "correct",
      confidence: 0.9,
      checkpointsHit: [],
      misconceptionId: null,
      evidence: "test",
    }));

    const outcomes = await replayScript(script, {
      live: { assess: fakeLive },
    });

    outcomes.forEach((outcome) => {
      if (outcome.live) {
        expect(outcome.live.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("decisions still follow mock when fakeLive returns different", async () => {
    const scripts = loadScripts("evals/scripts");
    const script = scripts.find((s) => s.id === "stuck-then-recovers")!;

    // Fake live returns 'correct' instead of script's expectations
    const fakeLive = vi.fn(async (): Promise<Assessment> => ({
      status: "correct",
      confidence: 0.99,
      checkpointsHit: ["c1", "c2", "c3"],
      misconceptionId: null,
      evidence: "completely wrong",
    }));

    const outcomes = await replayScript(script, {
      live: { assess: fakeLive },
    });

    // Expectations should still pass because decisions follow mock
    const errors = checkScript(script, outcomes);
    expect(errors).toHaveLength(0);
  });

  it("live call throws: records error and continues", async () => {
    const scripts = loadScripts("evals/scripts");
    const script = scripts.find((s) => s.id === "stuck-then-recovers")!;

    const fakeLive = vi.fn(async (): Promise<Assessment> => {
      throw new Error("Network error");
    });

    const outcomes = await replayScript(script, {
      live: { assess: fakeLive },
    });

    // Check that steps with assessCalled have error recorded
    outcomes.forEach((outcome) => {
      if (outcome.index >= 0) {
        const step = script.steps[outcome.index];
        if (step?.expect.assessCalled) {
          expect(outcome.live).toBeDefined();
          expect(outcome.live?.assessment).toBe(null);
          expect(outcome.live?.error).toContain("Network error");
        }
      }
    });

    // Decisions still follow mock
    const errors = checkScript(script, outcomes);
    expect(errors).toHaveLength(0);
  });
});
