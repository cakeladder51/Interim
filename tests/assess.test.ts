import { describe, it, expect, vi } from "vitest";
import OpenAI from "openai";
import {
  assess,
  ASSESS_TIMEOUT_TURN_MS,
  ASSESS_TIMEOUT_LIVE_MS,
} from "../src/server/assess";
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

describe("assess constants", () => {
  it("ASSESS_TIMEOUT_LIVE_MS is 3500", () => {
    expect(ASSESS_TIMEOUT_LIVE_MS).toBe(3500);
  });

  it("ASSESS_TIMEOUT_TURN_MS is 8000", () => {
    expect(ASSESS_TIMEOUT_TURN_MS).toBe(8000);
  });
});

describe("assess", () => {
  it("returns parsed assessment on valid JSON", async () => {
    const mockResponse = {
      status: "progressing",
      confidence: 0.7,
      checkpointsHit: ["c1"],
      misconceptionId: null,
      evidence: "Some evidence",
    };

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }],
          }),
        },
      },
    } as unknown as OpenAI;

    const result = await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(result).toEqual(mockResponse);
  });

  it("returns null on invalid output", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "not json" } }],
          }),
        },
      },
    } as unknown as OpenAI;

    const result = await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(result).toBeNull();
  });

  it("returns null on timeout", async () => {
    const metaError = new MetaError("timeout", "Timeout", true);
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(metaError),
        },
      },
    } as unknown as OpenAI;

    const result = await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(result).toBeNull();
  });

  it("returns null on 429 rate limit", async () => {
    const metaError = new MetaError("rate_limited", "Rate limited", true, 429);
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(metaError),
        },
      },
    } as unknown as OpenAI;

    const result = await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(result).toBeNull();
  });

  // Literal value assertions for chatJSON call options

  it("turn_complete passes timeoutMs: 8000, retry: true, schemaName: Assessment", async () => {
    let capturedOpts: Record<string, unknown> | undefined;

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            return {
              choices: [{ message: { content: JSON.stringify({
                status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test"
              }) } }],
            };
          }),
        },
      },
    } as unknown as OpenAI;

    // Spy on chatJSON by capturing what assess passes internally
    // We need to spy on the module that exports chatJSON
    const meta = await import("../src/lib/meta");
    const chatJSONSpy = vi.spyOn(meta, "chatJSON").mockImplementation(async (opts) => {
      capturedOpts = opts as unknown as Record<string, unknown>;
      return {
        data: { status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test" },
        latencyMs: 100,
      };
    });

    await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(capturedOpts?.timeoutMs).toBe(8000);
    expect(capturedOpts?.retry).toBe(true);
    expect(capturedOpts?.schemaName).toBe("Assessment");

    chatJSONSpy.mockRestore();
  });

  it("partial passes timeoutMs: 3500, retry: false, schemaName: Assessment", async () => {
    let capturedOpts: Record<string, unknown> | undefined;

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;

    const meta = await import("../src/lib/meta");
    const chatJSONSpy = vi.spyOn(meta, "chatJSON").mockImplementation(async (opts) => {
      capturedOpts = opts as unknown as Record<string, unknown>;
      return {
        data: { status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test" },
        latencyMs: 100,
      };
    });

    await assess({
      config,
      style,
      state: makeState(),
      event: { type: "partial", text: "thinking" },
      client: mockClient,
    });

    expect(capturedOpts?.timeoutMs).toBe(3500);
    expect(capturedOpts?.retry).toBe(false);
    expect(capturedOpts?.schemaName).toBe("Assessment");

    chatJSONSpy.mockRestore();
  });

  it("canvas passes timeoutMs: 3500, retry: false, schemaName: Assessment", async () => {
    let capturedOpts: Record<string, unknown> | undefined;

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;

    const meta = await import("../src/lib/meta");
    const chatJSONSpy = vi.spyOn(meta, "chatJSON").mockImplementation(async (opts) => {
      capturedOpts = opts as unknown as Record<string, unknown>;
      return {
        data: { status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test" },
        latencyMs: 100,
      };
    });

    await assess({
      config,
      style,
      state: makeState(),
      event: { type: "canvas", image: "data:image/png;base64,abc" },
      client: mockClient,
    });

    expect(capturedOpts?.timeoutMs).toBe(3500);
    expect(capturedOpts?.retry).toBe(false);
    expect(capturedOpts?.schemaName).toBe("Assessment");

    chatJSONSpy.mockRestore();
  });

  it("turn_complete retries on retryable failure", async () => {
    let callCount = 0;
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
              throw new MetaError("upstream", "Error", true);
            }
            return {
              choices: [{ message: { content: JSON.stringify({
                status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test"
              }) } }],
            };
          }),
        },
      },
    } as unknown as OpenAI;

    const result = await assess({
      config,
      style,
      state: makeState(),
      event: { type: "turn_complete", text: "my answer", source: "voice" },
      client: mockClient,
    });

    expect(callCount).toBe(2);
    expect(result).not.toBeNull();
  });

  it("rejects on caller abort", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("Aborted")),
        },
      },
    } as unknown as OpenAI;

    await expect(
      assess({
        config,
        style,
        state: makeState(),
        event: { type: "turn_complete", text: "my answer", source: "voice" },
        signal: controller.signal,
        client: mockClient,
      })
    ).rejects.toThrow();
  });
});
