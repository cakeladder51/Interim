import { describe, it, expect, beforeEach } from "vitest";
import { loadScripts } from "../src/eval/load-scripts";
import { replayScript, T0, type StepOutcome } from "../src/eval/replay";
import { checkScript } from "../src/eval/expect";

describe("regression suite", () => {
  const scripts = loadScripts("evals/scripts");

  // Run deterministic replay for each script
  for (const script of scripts) {
    it(script.id, async () => {
      const outcomes = await replayScript(script);
      const errors = checkScript(script, outcomes);
      expect(errors).toHaveLength(0);
    });
  }

  // Sanity tests to ensure checker can catch issues
  describe("sanity checks", () => {
    const script = scripts.find((s) => s.id === "misconception-mid-answer")!;
    let outcomes: StepOutcome[];

    beforeEach(async () => {
      outcomes = await replayScript(script);
    });

    // Helper to run checkScript on modified outcomes
    function checkTampered(
      modify: (outcomes: StepOutcome[]) => void
    ): string[] {
      const clone = outcomes.map((o) => ({ ...o, state: { ...o.state } }));
      modify(clone);
      return checkScript(script, clone);
    }

    it("catches interrupt tampered", () => {
      // Step 1 (index 1) has interrupt: true
      const errors = checkTampered((o) => {
        o[2]!.interrupt = false;
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("interrupt"))).toBe(true);
    });

    it("catches move.misconceptionId tampered", () => {
      // Step 1 has misconceptionId: "lowest-terms-missing"
      const errors = checkTampered((o) => {
        const m = o[2]!.move as { type: "realign"; misconceptionId: string | null };
        m.misconceptionId = null;
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("misconceptionId"))).toBe(true);
    });

    it("catches assessCalled tampered", () => {
      // Step 2 (index 2) has assessCalled: false
      const errors = checkTampered((o) => {
        o[3]!.assessCalled = true;
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("assessCalled"))).toBe(true);
    });

    it("catches state.turnWordBaseline tampered", () => {
      // Step 3 has turnWordBaseline specific value
      const errors = checkTampered((o) => {
        o[4]!.state.turnWordBaseline = 5;
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("turnWordBaseline"))).toBe(true);
    });

    it("catches interviewerKind tampered", () => {
      // Step 1 has interviewerKind: "interjection"
      const errors = checkTampered((o) => {
        o[2]!.interviewerKind = "utterance";
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("interviewerKind"))).toBe(true);
    });

    it("catches speakReason tampered", () => {
      // Step 1 has reason: "interject_off_track"
      const errors = checkTampered((o) => {
        o[2]!.speakReason = "off_track";
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("reason"))).toBe(true);
    });

    it("catches lastInterjectAt tampered", () => {
      // Step 1 has lastInterjectAtMs: 26000
      const errors = checkTampered((o) => {
        o[2]!.state.lastInterjectAt = T0 + 99999;
      });
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.includes("lastInterjectAt"))).toBe(true);
    });

    it("catches start move tampered", async () => {
      const script3 = scripts.find((s) => s.id === "stuck-then-recovers")!;
      const scriptOutcomes = await replayScript(script3);
      scriptOutcomes[0]!.move = { type: "hint", rung: 0 };
      const errors = checkScript(script3, scriptOutcomes);
      expect(errors.some((e) => e.includes("move.type"))).toBe(true);
    });
  });

  // T2: Additional checker tests
  describe("checker field tests (01-stuck-then-recovers)", () => {
    const stuckScript = scripts.find((s) => s.id === "stuck-then-recovers")!;

    it("catches move.type tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      outcomes[1]!.move = { type: "acknowledge" };
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("move.type");
    });

    it("catches move.rung tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      const move = outcomes[1]!.move as { type: "hint"; rung: number };
      move.rung = 1;
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("rung");
    });

    it("catches move.probeIdx tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      // Step 3 (index 4) has probe
      const move = outcomes[4]!.move as { type: "probe"; probeIdx: number };
      move.probeIdx = 1;
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("probeIdx");
    });

    it("catches move.toProblemIdx tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      // Step 4 (index 5) has advance
      const move = outcomes[5]!.move as { type: "advance"; toProblemIdx: number };
      move.toProblemIdx = 2;
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("toProblemIdx");
    });

    it("catches state.problemIdx tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      // Step 4 (index 5) has problemIdx: 1
      outcomes[5]!.state.problemIdx = 0;
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("problemIdx");
    });

    it("catches state.checkpointsHit tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      // Step 2 (index 3) has checkpointsHit
      outcomes[3]!.state.checkpointsHit = ["c1"];
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("checkpointsHit");
    });

    it("catches state.probesAsked tampered", async () => {
      const outcomes = await replayScript(stuckScript);
      // Step 3 (index 4) has probesAsked: 1
      outcomes[4]!.state.probesAsked = 0;
      const errors = checkScript(stuckScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("probesAsked");
    });
  });

  describe("checker field tests (05-long-silence)", () => {
    const silenceScript = scripts.find((s) => s.id === "long-silence")!;

    it("catches state.hintRung tampered", async () => {
      const outcomes = await replayScript(silenceScript);
      // Step 1 (index 2) has hintRung: 0
      outcomes[2]!.state.hintRung = 1;
      const errors = checkScript(silenceScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("hintRung");
    });
  });

  describe("checker field tests (02-right-first-time)", () => {
    const rightScript = scripts.find((s) => s.id === "right-first-time")!;

    it("catches state.phase tampered", async () => {
      const outcomes = await replayScript(rightScript);
      // Step 5 (index 6) has phase: wrap_up
      outcomes[6]!.state.phase = "problem";
      const errors = checkScript(rightScript, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("phase");
    });
  });

  describe("implicit start check", () => {
    it("catches implicit start phase tampered", async () => {
      const script = scripts.find((s) => s.id === "stuck-then-recovers")!;
      const outcomes = await replayScript(script);
      outcomes[0]!.state.phase = "intro";
      const errors = checkScript(script, outcomes);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("phase");
    });
  });

  // Replay invariants
  describe("replay invariants", () => {
    for (const script of scripts) {
      it(`${script.id}: assess args state transcript matches previous done state`, async () => {
        const outcomes = await replayScript(script);
        // For each outcome where assess was called, check transcript length matches previous state
        outcomes.forEach((outcome, i) => {
          if (outcome.assessCalled && outcome.assessArgsStateTranscriptLength !== undefined) {
            // Get previous outcome's state transcript length
            const prevOutcome = outcomes[i - 1];
            if (prevOutcome) {
              const prevTranscriptLength = prevOutcome.state.transcript.length;
              expect(outcome.assessArgsStateTranscriptLength).toBe(prevTranscriptLength);
            }
          }
        });
      });

      it(`${script.id}: no words key reached the API`, async () => {
        const requestBodies: unknown[] = [];
        await replayScript(script, {
          onRequest: (body) => {
            requestBodies.push(body);
          },
        });
        expect(requestBodies.length).toBe(script.steps.length + 1);
        for (const body of requestBodies) {
          const req = body as { event?: unknown };
          if (req.event) {
            const event = req.event as Record<string, unknown>;
            expect(event).not.toHaveProperty("words");
            if (event.type === "partial") {
              expect(Object.keys(event).sort()).toEqual(["text", "type"]);
            }
          }
        }
      });
    }
  });

  describe("error context", () => {
    it("includes script id and step index in error message", async () => {
      const script = scripts.find((s) => s.id === "misconception-mid-answer")!;
      // Clone and remove mock from a step where assessCalled is expected
      const tamperedScript = JSON.parse(JSON.stringify(script));
      // Step 1 (index 1) has mock, delete it to trigger error
      delete tamperedScript.steps[1].mock;
      await expect(replayScript(tamperedScript as typeof script)).rejects.toThrow(/misconception-mid-answer.*step 1/);
    });
  });
});
