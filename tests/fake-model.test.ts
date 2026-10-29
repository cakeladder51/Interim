import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeAssess, fakeSpeak, FAKE_ASSESS_DELAY_MS } from "../src/server/fake-model";
import { getConfig } from "../src/config/load";
import { fallbackUtterance } from "../src/engine/prompts";
import type { EngineState } from "@/contracts";

const config = getConfig("maths-oxbridge");

function makeState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1,
    configId: config.id,
    styleId: "supportive",
    startedAt: 1000,
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

function makeStateForProblem(problemIdx: number): EngineState {
  return makeState({ problemIdx });
}

describe("fakeAssess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns stuck for "I DON\'T KNOW" (uppercase)', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I DON'T KNOW", source: "voice" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("stuck");
    expect(result?.confidence).toBe(0.9);
    expect(result?.evidence).toBe("fake: stuck keyword");
  });

  it('returns stuck for "I dont know"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I dont know", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("stuck");
  });

  it('returns stuck for "stuck"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I'm stuck here", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("stuck");
  });

  it('returns stuck for "no idea"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "no idea what to do", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("stuck");
  });

  it('returns correct for "solved"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I've solved it", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
    expect(result?.checkpointsHit).toEqual(config.problems[0].checkpoints.map((c) => c.id));
  });

  it('returns correct for "done"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I'm done", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
  });

  it('returns correct for "finished"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "Finished!", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
  });

  it('returns correct with all problem checkpoint ids in order for problemIdx 1', async () => {
    const state = makeStateForProblem(1);
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "solved", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
    expect(result?.checkpointsHit).toEqual(config.problems[1].checkpoints.map((c) => c.id));
  });

  // G11: Solved returns problem's own checkpoint ids, not problem 0's
  it('solved with problemIdx 1 returns checkpoints from problem 1, not problem 0', async () => {
    const state = makeStateForProblem(1);
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "solved", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
    // Must be problem 1's checkpoints
    expect(result?.checkpointsHit).toEqual(config.problems[1].checkpoints.map((c) => c.id));
  });

  // G11: With a config where problem 0 and problem 1 have different checkpoint ids, ensure correct problem is used
  it('solved uses state.problemIdx, not hardcoded 0 (config with different checkpoint ids)', async () => {
    // Create a config where problem 0 and problem 1 have DIFFERENT checkpoint ids
    const testConfig: typeof config = {
      ...config,
      problems: [
        {
          ...config.problems[0],
          id: "problem-0",
          checkpoints: [
            { id: "p0-c1", description: "Problem 0 checkpoint 1" },
            { id: "p0-c2", description: "Problem 0 checkpoint 2" },
          ],
          hintLadder: ["hint"],
          probes: ["probe"],
          misconceptions: [],
          solutionSketch: "solution",
        },
        {
          ...config.problems[1],
          id: "problem-1",
          checkpoints: [
            { id: "p1-c1", description: "Problem 1 checkpoint 1" },
            { id: "p1-c2", description: "Problem 1 checkpoint 2" },
            { id: "p1-c3", description: "Problem 1 checkpoint 3" },
          ],
          hintLadder: ["hint"],
          probes: ["probe"],
          misconceptions: [],
          solutionSketch: "solution",
        },
      ],
    };

    const state = makeStateForProblem(1);
    const promise = fakeAssess({
      config: testConfig,
      style: testConfig.styles[0],
      state,
      event: { type: "turn_complete", text: "solved", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("correct");
    // Must be problem 1's checkpoints (p1-*)
    expect(result?.checkpointsHit).toEqual(["p1-c1", "p1-c2", "p1-c3"]);
    // Must NOT be problem 0's checkpoints (p0-*)
    expect(result?.checkpointsHit).not.toEqual(["p0-c1", "p0-c2"]);
  });

  it('returns off_track for "wrong"', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "That's wrong", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("off_track");
    expect(result?.misconceptionId).toBe(config.problems[0].misconceptions[0]?.id);
  });

  it('returns off_track with misconceptionId from problem.misconceptions[0].id', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "wrong", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.misconceptionId).toBe(config.problems[0].misconceptions[0].id);
  });

  it('returns progression for default text', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I think p is even", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("progressing");
    expect(result?.confidence).toBe(0.6);
    expect(result?.evidence).toBe("fake: default");
  });

  it('branch precedence: "I don\'t know if this is wrong" → stuck (not off_track)', async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "I don't know if this is wrong", source: "typed" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("stuck");
  });

  it("canvas → default (progressing)", async () => {
    const state = makeState();
    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "canvas", image: "data:image/png;base64,abc" },
    });

    await vi.advanceTimersByTimeAsync(FAKE_ASSESS_DELAY_MS);
    const result = await promise;

    expect(result?.status).toBe("progressing");
  });

  it("already-aborted signal → rejects with AbortError", async () => {
    const state = makeState();
    const controller = new AbortController();
    controller.abort();

    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "test", source: "typed" },
      signal: controller.signal,
    });

    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("aborted during delay → rejects with AbortError", async () => {
    const state = makeState();
    const controller = new AbortController();

    const promise = fakeAssess({
      config,
      style: config.styles[0],
      state,
      event: { type: "turn_complete", text: "test", source: "typed" },
      signal: controller.signal,
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("fakeSpeak", () => {
  it("chunks joined === fallbackUtterance for intro", async () => {
    vi.useRealTimers();
    const state = makeState();
    const expected = fallbackUtterance({
      config,
      state,
      move: { type: "intro" },
      reason: "intro",
    });

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(expected);
  });

  it("chunks joined === fallbackUtterance for hint", async () => {
    vi.useRealTimers();
    const state = makeState({ phase: "problem" });
    const expected = fallbackUtterance({
      config,
      state,
      move: { type: "hint", rung: 0 },
      reason: "stuck",
    });

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "hint", rung: 0 },
      interrupt: false,
      reason: "stuck",
      studentText: null,
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(expected);
  });

  it("chunks joined === fallbackUtterance for advance", async () => {
    vi.useRealTimers();
    const state = makeState({ phase: "problem", problemIdx: 0 });
    const expected = fallbackUtterance({
      config,
      state,
      move: { type: "advance", toProblemIdx: 1 },
      reason: "solved_advance",
    });

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "advance", toProblemIdx: 1 },
      interrupt: false,
      reason: "solved_advance",
      studentText: "done",
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(expected);
  });

  it("chunks joined === fallbackUtterance for wrap_up", async () => {
    vi.useRealTimers();
    const state = makeState({ phase: "wrap_up" });
    const expected = fallbackUtterance({
      config,
      state,
      move: { type: "wrap_up" },
      reason: "closing",
    });

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "wrap_up" },
      interrupt: false,
      reason: "closing",
      studentText: null,
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(expected);
  });

  it("every chunk except last ends with whitespace or is followed by non-whitespace", async () => {
    vi.useRealTimers();
    const state = makeState();
    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Each chunk should match \S+\s*
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^\S+\s*$/);
    }
  });

  it("aborted signal yields nothing and doesn't throw", async () => {
    const state = makeState();
    const controller = new AbortController();
    controller.abort();

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
      signal: controller.signal,
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });

  it("signal aborted mid-generation yields nothing after abort", async () => {
    vi.useRealTimers();

    const state = makeState();
    const controller = new AbortController();

    const chunks: string[] = [];
    const generator = fakeSpeak({
      config,
      style: config.styles[0],
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
      signal: controller.signal,
    });

    // Collect chunks with a small delay, abort after first chunk
    let count = 0;
    for await (const chunk of generator) {
      chunks.push(chunk);
      count++;
      if (count === 1) {
        controller.abort();
      }
    }

    // Should stop after abort (may have 0 or 1 chunks, but not multiple)
    expect(chunks.length).toBeLessThanOrEqual(1);

    vi.useFakeTimers();
  });
});
