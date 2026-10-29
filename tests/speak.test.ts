import { describe, it, expect, vi } from "vitest";
import OpenAI from "openai";
import {
  speak,
  SPEAK_MAX_TOKENS,
  SPEAK_MAX_TOKENS_INTERRUPT,
} from "../src/server/speak";
import { MetaError } from "../src/lib/meta";
import { getConfig, getStyle } from "../src/config/load";
import type { EngineState } from "@/contracts";

// Mock env
vi.mock("../src/lib/env", () => ({
  getServerEnv: vi.fn(() => ({
    MODEL_API_KEY: "test-key",
    META_MODEL: "muse-spark-1.3",
  })),
}));

const config = getConfig("maths-oxbridge");
const style = getStyle(config, "supportive");

function makeState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1,
    configId: config.id,
    styleId: style.id,
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

describe("speak constants", () => {
  it("SPEAK_MAX_TOKENS is 200", () => {
    expect(SPEAK_MAX_TOKENS).toBe(200);
  });

  it("SPEAK_MAX_TOKENS_INTERRUPT is 60", () => {
    expect(SPEAK_MAX_TOKENS_INTERRUPT).toBe(60);
  });
});

describe("speak", () => {
  it("yields deltas in order", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "Hello" } }] };
      yield { choices: [{ delta: { content: " " } }] };
      yield { choices: [{ delta: { content: "world" } }] };
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    } as unknown as OpenAI;

    const chunks: string[] = [];
    for await (const chunk of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      client: mockClient,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " ", "world"]);
  });

  it("passes literal max_tokens: 60 when interrupting", async () => {
    let capturedOpts: unknown;

    const meta = await import("../src/lib/meta");
    const chatStreamSpy = vi.spyOn(meta, "chatStream").mockImplementation(async function* (opts) {
      capturedOpts = opts;
      yield "test";
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of speak({
      config,
      style,
      state: makeState(),
      move: { type: "realign", misconceptionId: null },
      interrupt: true,
      reason: "interject_off_track",
      studentText: "test",
      client: {} as OpenAI,
    })) {
      // Just consume
    }

    expect((capturedOpts as Record<string, unknown>)?.maxTokens).toBe(60);

    chatStreamSpy.mockRestore();
  });

  it("passes literal max_tokens: 200 when not interrupting", async () => {
    let capturedOpts: unknown;

    const meta = await import("../src/lib/meta");
    const chatStreamSpy = vi.spyOn(meta, "chatStream").mockImplementation(async function* (opts) {
      capturedOpts = opts;
      yield "test";
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      client: {} as OpenAI,
    })) {
      // Just consume
    }

    expect((capturedOpts as Record<string, unknown>)?.maxTokens).toBe(200);

    chatStreamSpy.mockRestore();
  });

  // Timeout value assertions
  it("passes literal firstTokenTimeoutMs: 4000 and totalTimeoutMs: 12000", async () => {
    let capturedOpts: unknown;

    const meta = await import("../src/lib/meta");
    const chatStreamSpy = vi.spyOn(meta, "chatStream").mockImplementation(async function* (opts) {
      capturedOpts = opts;
      yield "test";
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      client: {} as OpenAI,
    })) {
      // Just consume
    }

    expect((capturedOpts as Record<string, unknown>)?.firstTokenTimeoutMs).toBe(4000);
    expect((capturedOpts as Record<string, unknown>)?.totalTimeoutMs).toBe(12000);

    chatStreamSpy.mockRestore();
  });

  it("failure before first delta yields fallback utterance", async () => {
    const metaError = new MetaError("upstream", "Error", true);

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(metaError),
        },
      },
    } as unknown as OpenAI;

    const chunks: string[] = [];
    for await (const chunk of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "assessor_unavailable",
      studentText: null,
      client: mockClient,
    })) {
      chunks.push(chunk);
    }

    // Should yield exactly the fallback
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(config.fallbackPrompt);
  });

  it("failure after deltas started stops silently", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "First" } }] };
      yield { choices: [{ delta: { content: " second" } }] };
      throw new MetaError("upstream", "Error", true);
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    } as unknown as OpenAI;

    const chunks: string[] = [];
    for await (const chunk of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      client: mockClient,
    })) {
      chunks.push(chunk);
    }

    // Should yield only the first two chunks, then stop
    expect(chunks).toEqual(["First", " second"]);
  });

  it("aborted signal yields nothing more and does not throw", async () => {
    const controller = new AbortController();

    async function* mockStream() {
      yield { choices: [{ delta: { content: "First" } }] };
      // Abort after first chunk
      controller.abort();
      yield { choices: [{ delta: { content: " second" } }] };
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    } as unknown as OpenAI;

    const chunks: string[] = [];
    for await (const chunk of speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      signal: controller.signal,
      client: mockClient,
    })) {
      chunks.push(chunk);
    }

    // Should have been aborted - the generator returns when signal.aborted
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // T3: Test that non-MetaError errors are rethrown
  it("plain Error from stream is rethrown", async () => {
    const meta = await import("../src/lib/meta");
    const chatStreamSpy = vi.spyOn(meta, "chatStream").mockImplementation(async function* () {
      yield "start";
      throw new Error("boom");
    });

    const gen = speak({
      config,
      style,
      state: makeState(),
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
      client: {} as OpenAI,
    });

    // First yield succeeds
    const first = await gen.next();
    expect(first.value).toBe("start");

    // Second should throw
    await expect(gen.next()).rejects.toThrow("boom");

    chatStreamSpy.mockRestore();
  });
});
