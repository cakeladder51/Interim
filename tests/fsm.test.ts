import { describe, it, expect } from "vitest";
import { decide, shouldAssess, countWords, TURN_OFF_TRACK_MIN_CONFIDENCE } from "../src/engine/fsm";
import { EngineError } from "../src/engine/errors";
import type { DecideInput, DecideEvent } from "../src/engine/types";
import type { EngineState, InterviewConfig, Style, Assessment } from "@/contracts";
import { getConfig, getStyle } from "../src/config/load";

// === Test-only config factory ===
function makeTestConfig(overrides: Partial<InterviewConfig> = {}): InterviewConfig {
  return {
    id: "test-config",
    title: "Test Config",
    subject: "Test",
    styles: [
      {
        id: "supportive",
        label: "Supportive",
        persona: "A warm tutor",
        tone: "Warm",
        interjection: { minConfidence: 0.8, cooldownMs: 20000, minNewWords: 12 },
      },
      {
        id: "rigorous",
        label: "Rigorous",
        persona: "A demanding examiner",
        tone: "Crisp",
        interjection: { minConfidence: 0.6, cooldownMs: 10000, minNewWords: 8 },
      },
    ],
    problems: [
      {
        id: "p1",
        title: "Problem 1",
        statement: "Statement 1",
        checkpoints: [
          { id: "p1c1", description: "Checkpoint 1" },
          { id: "p1c2", description: "Checkpoint 2" },
        ],
        hintLadder: ["Hint 1", "Hint 2"],
        probes: ["Probe 1", "Probe 2"],
        misconceptions: [{ id: "m1", signal: "Signal 1", realign: "Realign 1" }],
        solutionSketch: "Solution 1",
      },
      {
        id: "p2",
        title: "Problem 2",
        statement: "Statement 2",
        checkpoints: [
          { id: "p2c1", description: "Checkpoint 1" },
          { id: "p2c2", description: "Checkpoint 2" },
        ],
        hintLadder: ["Hint 1", "Hint 2"],
        probes: ["Probe 1"],
        misconceptions: [{ id: "m2", signal: "Signal 2", realign: "Realign 2" }],
        solutionSketch: "Solution 2",
      },
    ],
    rubric: {
      criteria: [
        {
          id: "approach",
          name: "Approach",
          levels: [
            { score: 1, descriptor: "Bad" },
            { score: 2, descriptor: "OK" },
            { score: 3, descriptor: "Good" },
            { score: 4, descriptor: "Excellent" },
          ],
        },
      ],
    },
    timing: { maxMinutes: 25, silenceStuckMs: 20000 },
    fallbackPrompt: "Fallback",
    asrKeywords: ["test"],
    ...overrides,
  };
}

function makeTestStyle(): Style {
  return {
    id: "supportive",
    label: "Supportive",
    persona: "A warm tutor",
    tone: "Warm",
    interjection: { minConfidence: 0.8, cooldownMs: 20000, minNewWords: 12 },
  };
}

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    version: 1,
    configId: "test-config",
    styleId: "supportive",
    startedAt: 1000000,
    phase: "problem",
    problemIdx: 0,
    hintRung: -1,
    checkpointsHit: [],
    lastInterjectAt: null,
    turnWordBaseline: 0,
    probesAsked: 0,
    transcript: [],
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    status: "progressing",
    confidence: 0.5,
    checkpointsHit: [],
    misconceptionId: null,
    evidence: "",
    ...overrides,
  };
}

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    state: makeState(),
    event: { type: "turn_complete", text: "test", source: "typed" },
    assessment: makeAssessment(),
    config: makeTestConfig(),
    style: makeTestStyle(),
    now: 1100000,
    ...overrides,
  };
}

// === Tests ===

describe("fsm", () => {
  describe("countWords", () => {
    it("returns 0 for empty string", () => {
      expect(countWords("")).toBe(0);
    });

    it("counts whitespace-separated tokens", () => {
      expect(countWords("hello world")).toBe(2);
    });

    it("handles extra whitespace and newlines", () => {
      expect(countWords("  hello  \n world  ")).toBe(2);
    });
  });

  describe("validation", () => {
    it("throws on configId mismatch", () => {
      const i = input({ state: makeState({ configId: "wrong" }) });
      expect(() => decide(i)).toThrow(EngineError);
      try {
        decide(i);
      } catch (e) {
        expect((e as EngineError).code).toBe("bad_state");
      }
    });

    it("throws on styleId mismatch", () => {
      const i = input({ state: makeState({ styleId: "wrong" }) });
      expect(() => decide(i)).toThrow(EngineError);
    });

    it("throws on out-of-range problemIdx", () => {
      const i = input({ state: makeState({ problemIdx: 99 }) });
      expect(() => decide(i)).toThrow(EngineError);
    });
  });

  describe("intro phase treated as problem", () => {
    it("returns state with phase: problem", () => {
      const i = input({
        state: makeState({ phase: "intro" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.state.phase).toBe("problem");
    });
  });

  describe("end event in each phase", () => {
    it("end in problem phase → wrap_up, phase done, reason end", () => {
      const i = input({ event: { type: "end" } });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.state.phase).toBe("done");
      expect(result.reason).toBe("end");
    });

    it("end in done phase → silent, reason phase_inactive", () => {
      const i = input({ state: makeState({ phase: "done" }), event: { type: "end" } });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("phase_inactive");
    });

    it("end in wrap_up phase → silent, phase done, reason end", () => {
      const i = input({ state: makeState({ phase: "wrap_up" }), event: { type: "end" } });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.state.phase).toBe("done");
      expect(result.reason).toBe("end");
    });
  });

  describe("done phase", () => {
    it("every event type returns silent/phase_inactive with state unchanged", () => {
      const events: DecideEvent[] = [
        { type: "turn_complete", text: "t", source: "typed" },
        { type: "partial", text: "hello" },
        { type: "canvas", image: "data:image/png;base64,abc" },
        { type: "silence", ms: 25000 },
        { type: "end" },
      ];
      for (const event of events) {
        const i = input({ state: makeState({ phase: "done" }), event });
        const result = decide(i);
        expect(result.move.type).toBe("silent");
        expect(result.reason).toBe("phase_inactive");
        expect(result.state).toEqual(makeState({ phase: "done" }));
      }
    });
  });

  describe("wrap_up phase", () => {
    it("turn_complete → acknowledge/closing", () => {
      const i = input({
        state: makeState({ phase: "wrap_up", turnWordBaseline: 7 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("closing");
      expect(result.state.turnWordBaseline).toBe(0);
    });

    it("partial → silent", () => {
      const i = input({
        state: makeState({ phase: "wrap_up" }),
        event: { type: "partial", text: "thinking" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("phase_inactive");
    });
  });

  describe("partial interjection", () => {
    it("fires when all three gates pass", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
        now: 1100000,
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      expect(result.interrupt).toBe(true);
      expect(result.state.lastInterjectAt).toBe(1100000);
      expect(result.state.turnWordBaseline).toBe(13);
      expect(result.reason).toBe("interject_off_track");
    });

    it("blocked by cooldown not elapsed", () => {
      const i = input({
        state: makeState({ lastInterjectAt: 1090000 }), // 10000ms ago, < 20000 cooldown
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });

    it("blocked by too few new words", () => {
      const i = input({
        state: makeState({ turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three" }, // only 3 words
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });

    it("blocked by baseline subtraction after earlier interjection", () => {
      const i = input({
        state: makeState({ turnWordBaseline: 10, lastInterjectAt: null }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen" }, // 14 words total, 4 new
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });

    it("blocked by confidence below minConfidence", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.7 }), // < 0.8
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });

    it("blocked by status not off_track", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "stuck", confidence: 0.9 }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });

    it("blocked by null assessment", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: null,
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("gated");
    });
  });

  describe("cooldown boundary", () => {
    it("exactly cooldownMs elapsed is allowed", () => {
      const i = input({
        state: makeState({ lastInterjectAt: 1080000 }), // 20000ms ago
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
        now: 1100000,
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      expect(result.interrupt).toBe(true);
    });

    it("one ms less is blocked", () => {
      const i = input({
        state: makeState({ lastInterjectAt: 1080001 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
        now: 1100000,
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
    });
  });

  describe("partial with unknown misconceptionId", () => {
    it("realigns with null misconceptionId", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85, misconceptionId: "unknown-m" }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      if (result.move.type === "realign") {
        expect(result.move.misconceptionId).toBeNull();
      }
    });
  });

  describe("canvas interjection", () => {
    it("interjects without word gate, leaves turnWordBaseline unchanged", () => {
      const i = input({
        state: makeState({ lastInterjectAt: null, turnWordBaseline: 5 }),
        event: { type: "canvas", image: "data:image/png;base64,abc" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
        now: 1100000,
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      expect(result.interrupt).toBe(true);
      expect(result.state.turnWordBaseline).toBe(5); // unchanged
    });

    it("blocked by cooldown", () => {
      const i = input({
        state: makeState({ lastInterjectAt: 1090000 }),
        event: { type: "canvas", image: "data:image/png;base64,abc" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.85 }),
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
    });
  });

  describe("silence", () => {
    it("below threshold → silence_short", () => {
      const i = input({
        event: { type: "silence", ms: 15000 },
      });
      const result = decide(i);
      expect(result.move.type).toBe("silent");
      expect(result.reason).toBe("silence_short");
    });

    it("at threshold → hint with next rung", () => {
      const i = input({
        state: makeState({ hintRung: -1 }),
        event: { type: "silence", ms: 20000 },
      });
      const result = decide(i);
      expect(result.move.type).toBe("hint");
      if (result.move.type === "hint") {
        expect(result.move.rung).toBe(0);
      }
      expect(result.state.hintRung).toBe(0);
      expect(result.reason).toBe("silence_stuck");
      expect(result.state.turnWordBaseline).toBe(0);
      expect(result.interrupt).toBe(false);
    });

    it("ladder exhausted → advance with hintRung reset", () => {
      const i = input({
        state: makeState({ hintRung: 1 }), // only 2 rungs, 0 and 1
        event: { type: "silence", ms: 20000 },
      });
      const result = decide(i);
      expect(result.move.type).toBe("advance");
      expect(result.reason).toBe("hints_exhausted_advance");
      expect(result.state.hintRung).toBe(-1);
    });

    it("ladder exhausted on last problem → wrap_up", () => {
      const i = input({
        state: makeState({ hintRung: 1, problemIdx: 1 }), // problem 2 (last)
        event: { type: "silence", ms: 20000 },
      });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.reason).toBe("hints_exhausted_wrap_up");
      expect(result.state.phase).toBe("wrap_up");
    });
  });

  describe("turn_complete paths", () => {
    it("assessor_unavailable", () => {
      const i = input({
        assessment: null,
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("assessor_unavailable");
      expect(result.state.turnWordBaseline).toBe(0);
    });

    it("stuck → hint rungs 0, 1, then exhausted → advance", () => {
      // First stuck → hint rung 0
      let i = input({
        assessment: makeAssessment({ status: "stuck" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      let result = decide(i);
      expect(result.move.type).toBe("hint");
      if (result.move.type === "hint") {
        expect(result.move.rung).toBe(0);
      }

      // Second stuck → hint rung 1
      i = input({
        state: makeState({ hintRung: 0 }),
        assessment: makeAssessment({ status: "stuck" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      result = decide(i);
      expect(result.move.type).toBe("hint");
      if (result.move.type === "hint") {
        expect(result.move.rung).toBe(1);
      }

      // Third stuck → exhausted, advance
      i = input({
        state: makeState({ hintRung: 1 }),
        assessment: makeAssessment({ status: "stuck" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      result = decide(i);
      expect(result.move.type).toBe("advance");
    });

    it("solved before off_track: all checkpoints hit + off_track assessment → probe", () => {
      // Rule 3 (solved) comes before rule 4 (off_track)
      const i = input({
        state: makeState({ checkpointsHit: ["p1c1", "p1c2"] }),
        assessment: makeAssessment({ status: "off_track", confidence: 0.9 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("probe");
      expect(result.reason).toBe("solved_probe");
    });

    it("off_track at confidence 0.5 → realign", () => {
      const i = input({
        assessment: makeAssessment({ status: "off_track", confidence: TURN_OFF_TRACK_MIN_CONFIDENCE }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      expect(result.reason).toBe("off_track");
      expect(result.interrupt).toBe(false);
    });

    it("off_track at confidence 0.49 → acknowledge/progress", () => {
      const i = input({
        assessment: makeAssessment({ status: "off_track", confidence: 0.49 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("progress");
    });

    it("progressing → acknowledge/progress", () => {
      const i = input({
        assessment: makeAssessment({ status: "progressing" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("progress");
    });

    it("partial → acknowledge/progress", () => {
      const i = input({
        assessment: makeAssessment({ status: "partial" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("progress");
    });

    it("correct but not solved → acknowledge/progress", () => {
      const i = input({
        assessment: makeAssessment({ status: "correct", checkpointsHit: ["p1c1"] }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("progress");
    });
  });

  describe("solved", () => {
    it("first probe with probesAsked 1", () => {
      const i = input({
        state: makeState({ checkpointsHit: ["p1c1", "p1c2"] }),
        assessment: makeAssessment(),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("probe");
      if (result.move.type === "probe") {
        expect(result.move.probeIdx).toBe(0);
      }
      expect(result.state.probesAsked).toBe(1);
      expect(result.reason).toBe("solved_probe");
      expect(result.interrupt).toBe(false);
    });

    it("next solved turn → advance with problem-local fields reset including hintRung", () => {
      const i = input({
        state: makeState({ checkpointsHit: ["p1c1", "p1c2"], probesAsked: 1, hintRung: 2 }),
        assessment: makeAssessment(),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("advance");
      if (result.move.type === "advance") {
        expect(result.move.toProblemIdx).toBe(1);
      }
      expect(result.state.problemIdx).toBe(1);
      expect(result.state.hintRung).toBe(-1);
      expect(result.state.checkpointsHit).toEqual([]);
      expect(result.state.probesAsked).toBe(0);
      expect(result.state.turnWordBaseline).toBe(0);
      expect(result.interrupt).toBe(false);
    });

    it("on last problem → wrap_up/solved_wrap_up", () => {
      const i = input({
        state: makeState({ checkpointsHit: ["p2c1", "p2c2"], problemIdx: 1, probesAsked: 1 }),
        config: makeTestConfig(),
        assessment: makeAssessment(),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.reason).toBe("solved_wrap_up");
      expect(result.state.phase).toBe("wrap_up");
      expect(result.interrupt).toBe(false);
    });

    it("problem with 0 probes → advances immediately", () => {
      const config = makeTestConfig();
      config.problems[0].probes = [];
      const i = input({
        state: makeState({ checkpointsHit: ["p1c1", "p1c2"] }),
        config,
        assessment: makeAssessment(),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.move.type).toBe("advance");
    });
  });

  describe("checkpoint merge", () => {
    it("keeps order, ignores unknown ids, doesn't duplicate, sorts new ids by problem order", () => {
      const i = input({
        state: makeState({ checkpointsHit: ["p1c2"] }),
        assessment: makeAssessment({ checkpointsHit: ["unknown", "p1c1", "p1c2"] }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      // Only p1c1 is new (p1c2 already exists); p1c1 is first in problem.checkpoints
      // So p1c1 is appended, resulting in ["p1c2", "p1c1"]
      expect(result.state.checkpointsHit).toEqual(["p1c2", "p1c1"]);
    });

    it("sorts new ids into problem checkpoint order", () => {
      // Assessment gives ["p1c2", "p1c1"], but problem order is p1c1, p1c2
      const i = input({
        state: makeState({ checkpointsHit: [] }),
        assessment: makeAssessment({ checkpointsHit: ["p1c2", "p1c1"] }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.state.checkpointsHit).toEqual(["p1c1", "p1c2"]);
    });

    it("existing kept first, new ones sorted by problem order", () => {
      // Config with 3 checkpoints: p1c1, p1c2, p1c3
      const config = makeTestConfig();
      config.problems[0].checkpoints = [
        { id: "p1c1", description: "c1" },
        { id: "p1c2", description: "c2" },
        { id: "p1c3", description: "c3" },
      ];
      // State has p1c3, assessment adds p1c2 and p1c1
      const i = input({
        state: makeState({ checkpointsHit: ["p1c3"] }),
        assessment: makeAssessment({ checkpointsHit: ["p1c2", "p1c1"] }),
        config,
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      // p1c3 kept first, then new ones in problem order: p1c1, p1c2
      expect(result.state.checkpointsHit).toEqual(["p1c3", "p1c1", "p1c2"]);
    });

    it("merges on partial events", () => {
      const i = input({
        state: makeState({ checkpointsHit: [] }),
        assessment: makeAssessment({ checkpointsHit: ["p1c1"] }),
        event: { type: "partial", text: "hello" },
      });
      const result = decide(i);
      expect(result.state.checkpointsHit).toEqual(["p1c1"]);
    });

    it("merges on canvas events", () => {
      const i = input({
        state: makeState({ checkpointsHit: [] }),
        assessment: makeAssessment({ checkpointsHit: ["p1c1"] }),
        event: { type: "canvas", image: "data:image/png;base64,abc" },
      });
      const result = decide(i);
      expect(result.state.checkpointsHit).toEqual(["p1c1"]);
    });

    it("not applied when assessment is null", () => {
      const i = input({
        state: makeState({ checkpointsHit: [] }),
        assessment: null,
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.state.checkpointsHit).toEqual([]);
    });
  });

  describe("timeUp", () => {
    it("on turn_complete → wrap_up/time_up", () => {
      const i = input({
        state: makeState({ startedAt: 1000000 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
        now: 1000000 + 25 * 60_000 + 1, // just past 25 min
      });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.reason).toBe("time_up");
    });

    it("at exactly maxMinutes → time_up (≥ check)", () => {
      const i = input({
        state: makeState({ startedAt: 1000000 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
        now: 1000000 + 25 * 60_000, // exactly 25 min
      });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.reason).toBe("time_up");
    });

    it("one ms before maxMinutes → not time_up", () => {
      const i = input({
        state: makeState({ startedAt: 1000000 }),
        assessment: makeAssessment({ status: "progressing" }),
        event: { type: "turn_complete", text: "test", source: "typed" },
        now: 1000000 + 25 * 60_000 - 1, // one ms before
      });
      const result = decide(i);
      expect(result.move.type).toBe("acknowledge");
      expect(result.reason).toBe("progress");
    });

    it("on qualifying silence → wrap_up/time_up", () => {
      const i = input({
        state: makeState({ startedAt: 1000000 }),
        event: { type: "silence", ms: 25000 },
        now: 1000000 + 25 * 60_000 + 1,
      });
      const result = decide(i);
      expect(result.move.type).toBe("wrap_up");
      expect(result.reason).toBe("time_up");
    });

    it("partial while time is up → still governed by partial rules", () => {
      // No time check for partials; gates pass, so interject
      const i = input({
        state: makeState({ startedAt: 1000000, lastInterjectAt: null, turnWordBaseline: 0 }),
        event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        assessment: makeAssessment({ status: "off_track", confidence: 0.9 }),
        now: 1000000 + 25 * 60_000 + 1,
      });
      const result = decide(i);
      expect(result.move.type).toBe("realign");
      expect(result.reason).toBe("interject_off_track");
      expect(result.interrupt).toBe(true);
    });
  });

  describe("turnWordBaseline reset", () => {
    it("reset by turn_complete", () => {
      const i = input({
        state: makeState({ turnWordBaseline: 50 }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result = decide(i);
      expect(result.state.turnWordBaseline).toBe(0);
    });

    it("reset by silence hint", () => {
      const i = input({
        state: makeState({ turnWordBaseline: 50, hintRung: -1 }),
        event: { type: "silence", ms: 25000 },
      });
      const result = decide(i);
      expect(result.state.turnWordBaseline).toBe(0);
    });
  });

  describe("purity", () => {
    function deepFreeze<T>(obj: T): T {
      if (obj === null || typeof obj !== "object") {
        return obj;
      }
      if (Array.isArray(obj)) {
        Object.freeze(obj.forEach(deepFreeze));
        return Object.freeze(obj);
      }
      for (const key of Object.keys(obj)) {
        deepFreeze((obj as Record<string, unknown>)[key]);
      }
      return Object.freeze(obj);
    }

    it("deep-freezing inputs does not break any path and leaves inputs unchanged", () => {
      const cases: { input: DecideInput }[] = [
        { input: input({ event: { type: "end" } }) },
        { input: input({ state: makeState({ phase: "done" }), event: { type: "partial", text: "test" } }) },
        { input: input({ state: makeState({ phase: "wrap_up" }), event: { type: "turn_complete", text: "t", source: "typed" } }) },
        { input: input({
          state: makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
          event: { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
          assessment: makeAssessment({ status: "off_track", confidence: 0.9 }),
        }) },
        { input: input({
          state: makeState({ lastInterjectAt: null }),
          event: { type: "canvas", image: "data:image/png;base64,abc" },
          assessment: makeAssessment({ status: "off_track", confidence: 0.9 }),
        }) },
        { input: input({ event: { type: "silence", ms: 25000 } }) },
        { input: input({
          state: makeState({ hintRung: 1 }),
          event: { type: "silence", ms: 20000 },
        }) },
        { input: input({
          state: makeState({ checkpointsHit: ["p1c1", "p1c2"] }),
          event: { type: "turn_complete", text: "t", source: "typed" },
        }) },
        { input: input({
          state: makeState({ checkpointsHit: ["p1c1", "p1c2"], probesAsked: 1 }),
          event: { type: "turn_complete", text: "t", source: "typed" },
        }) },
        { input: input({
          state: makeState({ checkpointsHit: ["p1c1"] }),
          assessment: makeAssessment({ checkpointsHit: ["p1c2"] }),
          event: { type: "turn_complete", text: "t", source: "typed" },
        }) },
        { input: input({
          state: makeState({ startedAt: 1000000 }),
          event: { type: "turn_complete", text: "t", source: "typed" },
          now: 1000000 + 25 * 60_000 + 1,
        }) },
        { input: input({
          state: makeState({ phase: "done" }),
          event: { type: "end" },
        }) },
        { input: input({
          state: makeState({ phase: "wrap_up" }),
          event: { type: "end" },
        }) },
      ];

      for (const { input: i } of cases) {
        // Deep freeze the inputs
        const frozenState = deepFreeze(structuredClone(i.state));
        const frozenConfig = deepFreeze(structuredClone(i.config));
        const frozenStyle = deepFreeze(structuredClone(i.style));
        const frozenAssessment = i.assessment ? deepFreeze(structuredClone(i.assessment)) : null;

        // Take a snapshot of what was passed to decide
        const snapshot = {
          state: structuredClone(frozenState),
          config: structuredClone(frozenConfig),
          style: structuredClone(frozenStyle),
          assessment: frozenAssessment ? structuredClone(frozenAssessment) : null,
        };

        // Should not throw
        expect(() =>
          decide({
            ...i,
            state: frozenState,
            config: frozenConfig,
            style: frozenStyle,
            assessment: frozenAssessment,
          })
        ).not.toThrow();

        // Inputs that were actually passed should be unchanged
        expect(frozenState).toEqual(snapshot.state);
        expect(frozenConfig).toEqual(snapshot.config);
        expect(frozenStyle).toEqual(snapshot.style);
        expect(frozenAssessment).toEqual(snapshot.assessment);
      }
    });

    it("calling twice with same input gives deep-equal output", () => {
      const i = input({
        state: makeState({ checkpointsHit: ["p1c1"] }),
        assessment: makeAssessment({ checkpointsHit: ["p1c2"] }),
        event: { type: "turn_complete", text: "test", source: "typed" },
      });
      const result1 = decide(i);
      const result2 = decide(i);
      expect(result1).toEqual(result2);
    });
  });

  describe("shouldAssess", () => {
    it("true for turn_complete not time up", () => {
      const sa = shouldAssess(
        makeState(),
        { type: "turn_complete", text: "t", source: "typed" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(true);
    });

    it("false for turn_complete when time is up", () => {
      const sa = shouldAssess(
        makeState({ startedAt: 1000000 }),
        { type: "turn_complete", text: "t", source: "typed" },
        makeTestConfig(),
        makeTestStyle(),
        1000000 + 25 * 60_000 + 1
      );
      expect(sa).toBe(false);
    });

    it("true for gated-open partial", () => {
      const sa = shouldAssess(
        makeState({ lastInterjectAt: null, turnWordBaseline: 0 }),
        { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(true);
    });

    it("false for partial in cooldown", () => {
      const sa = shouldAssess(
        makeState({ lastInterjectAt: 1090000 }),
        { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("false for partial with too few new words", () => {
      const sa = shouldAssess(
        makeState({ turnWordBaseline: 0 }),
        { type: "partial", text: "one two three" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("false for partial with too few new words after baseline subtraction", () => {
      // 13 words total, turnWordBaseline 5 → 8 new words, minNewWords 12
      const sa = shouldAssess(
        makeState({ turnWordBaseline: 5, lastInterjectAt: null }),
        { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("true for partial with enough new words after baseline subtraction", () => {
      // 13 words total, turnWordBaseline 0 → 13 new words ≥ 12
      const sa = shouldAssess(
        makeState({ turnWordBaseline: 0, lastInterjectAt: null }),
        { type: "partial", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(true);
    });

    it("true for gated-open canvas", () => {
      const sa = shouldAssess(
        makeState({ lastInterjectAt: null }),
        { type: "canvas", image: "data:image/png;base64,abc" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(true);
    });

    it("false for silence", () => {
      const sa = shouldAssess(
        makeState(),
        { type: "silence", ms: 25000 },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("false for end", () => {
      const sa = shouldAssess(
        makeState(),
        { type: "end" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("false for non-problem phase", () => {
      const sa = shouldAssess(
        makeState({ phase: "done" }),
        { type: "turn_complete", text: "t", source: "typed" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });

    it("true for intro phase treated as problem", () => {
      const sa = shouldAssess(
        makeState({ phase: "intro" }),
        { type: "turn_complete", text: "t", source: "typed" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(true);
    });

    it("false for canvas inside cooldown", () => {
      const sa = shouldAssess(
        makeState({ lastInterjectAt: 1090000 }), // 10000ms ago
        { type: "canvas", image: "data:image/png;base64,abc" },
        makeTestConfig(),
        makeTestStyle(),
        1100000
      );
      expect(sa).toBe(false);
    });
  });

  describe("smoke test with real maths-oxbridge config", () => {
    it("decide runs without error on real config", () => {
      const config = getConfig("maths-oxbridge");
      const style = getStyle(config, "supportive");
      const state: EngineState = {
        version: 1,
        configId: config.id,
        styleId: style.id,
        startedAt: Date.now(),
        phase: "problem",
        problemIdx: 0,
        hintRung: -1,
        checkpointsHit: [],
        lastInterjectAt: null,
        turnWordBaseline: 0,
        probesAsked: 0,
        transcript: [],
      };
      const result = decide({
        state,
        event: { type: "turn_complete", text: "test", source: "typed" },
        assessment: makeAssessment(),
        config,
        style,
        now: Date.now() + 1000,
      });
      expect(result.state).toBeDefined();
      expect(result.move).toBeDefined();
    });
  });
});
