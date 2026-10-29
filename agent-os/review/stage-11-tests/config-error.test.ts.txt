// Stage 11 reviewer-supplied tests (H1: a missing MODEL_API_KEY degrades to the fallback lines).
// Copy byte-identical to tests/config-error.test.ts; do not edit.
import { describe, it, expect, vi, afterEach } from "vitest";
import type OpenAI from "openai";
import { parseSSE } from "../src/contracts/step-protocol";
import type { StepStreamEvent, EngineState } from "@/contracts";
import { MetaError, chatJSON, chatStream, getMetaClient } from "@/lib/meta";
import { assess } from "@/server/assess";
import { createStepHandler } from "@/server/step-handler";
import { selectDeps } from "@/server/deps";
import { getConfig, getStyle } from "@/config/load";
import { z } from "zod";

// What getServerEnv() throws today when MODEL_API_KEY is unset or empty (src/lib/env.ts).
vi.mock("@/lib/env", () => ({
  getServerEnv: vi.fn(() => {
    throw new Error("Missing/invalid env: MODEL_API_KEY");
  }),
}));

const CONFIG = { name: "MetaError", code: "config", retryable: false };

function spyClient() {
  const create = vi.fn();
  return { create, client: { chat: { completions: { create } } } as unknown as OpenAI };
}

async function step(state: EngineState | null, event: unknown): Promise<StepStreamEvent[]> {
  const handler = createStepHandler(selectDeps({}));
  const response = await handler(
    new Request("http://localhost/api/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, event }),
    })
  );
  expect(response.status).toBe(200);
  const events: StepStreamEvent[] = [];
  for await (const e of parseSSE(response.body as ReadableStream<Uint8Array>)) events.push(e);
  return events;
}

function finished(events: StepStreamEvent[]): EngineState {
  expect(events.map((e) => e.event)).not.toContain("error");
  expect(events[0]?.event).toBe("move");
  const done = events[events.length - 1];
  expect(done?.event).toBe("done");
  if (done?.event !== "done") throw new Error("no done event");
  const tokens = events.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");
  expect(tokens).toBe(done.data.utterance);
  return done.data.state;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("H1: missing MODEL_API_KEY is MetaError(config)", () => {
  it("getMetaClient throws MetaError config, not retryable", () => {
    let caught: unknown;
    try { getMetaClient(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MetaError);
    expect(caught).toMatchObject(CONFIG);
    expect((caught as Error).message).toContain("MODEL_API_KEY");
  });

  it("chatJSON rejects with MetaError config and never calls the client", async () => {
    const { create, client } = spyClient();
    await expect(
      chatJSON({ schema: z.object({ a: z.string() }), schemaName: "A", messages: [{ role: "user", content: "x" }], client })
    ).rejects.toMatchObject(CONFIG);
    expect(create).not.toHaveBeenCalled();
  });

  it("chatStream's first next() rejects with MetaError config and never calls the client", async () => {
    const { create, client } = spyClient();
    const gen = chatStream({ messages: [{ role: "user", content: "x" }], client });
    await expect(gen.next()).rejects.toMatchObject(CONFIG);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("H1 drill: an interview with no key degrades to the fallback lines", () => {
  it("start and a turn both finish with done and a non-empty fallback line; nothing is logged as a step error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const startEvents = await step(null, { type: "start", configId: "maths-oxbridge", styleId: "supportive" });
    const s1 = finished(startEvents);
    const startDone = startEvents[startEvents.length - 1];
    expect(startDone.event === "done" && startDone.data.utterance.trim().length > 0).toBe(true);

    await expect(
      assess({ config: getConfig("maths-oxbridge"), style: getStyle(getConfig("maths-oxbridge"), "supportive"), state: s1, event: { type: "turn_complete", text: "I would try small cases first.", source: "typed" } })
    ).resolves.toBeNull();

    const turnEvents = await step(s1, { type: "turn_complete", text: "I would try small cases first.", source: "typed" });
    finished(turnEvents);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
