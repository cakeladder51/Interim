import { describe, it, expect, vi } from "vitest";
import { createStepHandler } from "../src/server/step-handler";
import { fakeAssess, fakeSpeak } from "../src/server/fake-model";
import { getConfig, getStyle } from "../src/config/load";
import {
  interviewReducer,
  initialView,
  buildStartRequest,
  buildTurnRequest,
  buildEndRequest,
} from "../src/client/interview-model";
import { runStepRequest } from "../src/client/step-client";
import type { InterviewView } from "../src/client/interview-model";
import type { EngineState, Move, StepRequest } from "@/contracts";

const config = getConfig("maths-oxbridge");
const style = getStyle(config, "supportive");

describe("e2e-text-interview (M1 regression)", () => {
  // Helper to run a request through runStepRequest, using the handler as fetchImpl
  async function runRequestThroughClient(
    handler: ReturnType<typeof createStepHandler>,
    request: StepRequest,
    callbacks: {
      onMove: (move: Move, interrupt: boolean) => void;
      onToken: (text: string) => void;
      onModelLabel: (label: string) => void;
    }
  ): Promise<{ state: EngineState; utterance: string; move: Move; interrupt: boolean }> {
    return runStepRequest(request, {
      fetchImpl: (url, init) => handler(new Request("http://test" + url, init)),
      callbacks,
    });
  }

  it("runs the full maths-oxbridge interview script", { timeout: 30000 }, async () => {
    vi.useRealTimers();
    
    let now = vi.fn(() => 1000000);

    let handler = createStepHandler({
      assess: fakeAssess,
      speak: fakeSpeak,
      now,
    });

    let view: InterviewView = initialView;
    let time = 1000000;

    // Step 1: start
    let request: StepRequest = buildStartRequest(config.id, style.id);
    view = interviewReducer(view, { type: "request", request, studentText: null });

    const tokens: string[] = [];
    
    const result1 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => {
        tokens.push(text);
      },
      onModelLabel: () => {},
    });
    
    // Verify onMove was called before any token
    expect(result1.move.type).toBe("intro");
    
    // Verify tokens joined equals utterance
    expect(tokens.join("")).toBe(result1.utterance);
    expect(result1.utterance.length).toBeGreaterThan(0);
    
    // Verify state
    expect(result1.state.phase).toBe("problem");
    
    // Dispatch to reducer
    view = interviewReducer(view, { type: "move", move: result1.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result1.state });

    // Step 2: "I don't know" -> hint{rung:0}
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "I don't know");
    view = interviewReducer(view, { type: "request", request, studentText: "I don't know" });

    tokens.length = 0;
    
    const result2 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result2.move.type).toBe("hint");
    if (result2.move.type === "hint") {
      expect(result2.move.rung).toBe(0);
    }
    expect(tokens.join("")).toBe(result2.utterance);

    view = interviewReducer(view, { type: "move", move: result2.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result2.state });

    // Step 3: "still stuck" -> hint{rung:1}
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "still stuck");
    view = interviewReducer(view, { type: "request", request, studentText: "still stuck" });

    tokens.length = 0;
    
    const result3 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result3.move.type).toBe("hint");
    if (result3.move.type === "hint") {
      expect(result3.move.rung).toBe(1);
    }
    expect(tokens.join("")).toBe(result3.utterance);

    view = interviewReducer(view, { type: "move", move: result3.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result3.state });

    // Step 4: "this is wrong" -> realign
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "this is wrong");
    view = interviewReducer(view, { type: "request", request, studentText: "this is wrong" });

    tokens.length = 0;
    
    const result4 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result4.move.type).toBe("realign");
    expect(tokens.join("")).toBe(result4.utterance);

    view = interviewReducer(view, { type: "move", move: result4.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result4.state });

    // Step 5: "solved it" -> probe{probeIdx:0}
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "solved it");
    view = interviewReducer(view, { type: "request", request, studentText: "solved it" });

    tokens.length = 0;
    
    const result5 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result5.move.type).toBe("probe");
    if (result5.move.type === "probe") {
      expect(result5.move.probeIdx).toBe(0);
    }
    expect(tokens.join("")).toBe(result5.utterance);

    view = interviewReducer(view, { type: "move", move: result5.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result5.state });

    // Step 6: "done" -> advance{toProblemIdx:1}
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "done");
    view = interviewReducer(view, { type: "request", request, studentText: "done" });

    tokens.length = 0;
    
    const result6 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result6.move.type).toBe("advance");
    if (result6.move.type === "advance") {
      expect(result6.move.toProblemIdx).toBe(1);
    }
    expect(tokens.join("")).toBe(result6.utterance);

    view = interviewReducer(view, { type: "move", move: result6.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result6.state });

    // Step 7: "solved" -> probe
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "solved");
    view = interviewReducer(view, { type: "request", request, studentText: "solved" });

    tokens.length = 0;
    
    const result7 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result7.move.type).toBe("probe");
    expect(tokens.join("")).toBe(result7.utterance);

    view = interviewReducer(view, { type: "move", move: result7.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result7.state });

    // Step 8: "done" -> advance{toProblemIdx:2}
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "done");
    view = interviewReducer(view, { type: "request", request, studentText: "done" });

    tokens.length = 0;
    
    const result8 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result8.move.type).toBe("advance");
    if (result8.move.type === "advance") {
      expect(result8.move.toProblemIdx).toBe(2);
    }
    expect(tokens.join("")).toBe(result8.utterance);

    view = interviewReducer(view, { type: "move", move: result8.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result8.state });

    // Step 9: "finished" -> probe
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "finished");
    view = interviewReducer(view, { type: "request", request, studentText: "finished" });

    tokens.length = 0;
    
    const result9 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result9.move.type).toBe("probe");
    expect(tokens.join("")).toBe(result9.utterance);

    view = interviewReducer(view, { type: "move", move: result9.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result9.state });

    // Step 10: "done" -> wrap_up, phase wrap_up
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "done");
    view = interviewReducer(view, { type: "request", request, studentText: "done" });

    tokens.length = 0;
    
    const result10 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result10.move.type).toBe("wrap_up");
    expect(tokens.join("")).toBe(result10.utterance);

    view = interviewReducer(view, { type: "move", move: result10.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result10.state });

    expect(view.engine?.phase).toBe("wrap_up");

    // Step 11: "thank you" -> acknowledge
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildTurnRequest(view, "thank you");
    view = interviewReducer(view, { type: "request", request, studentText: "thank you" });

    tokens.length = 0;
    
    const result11 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result11.move.type).toBe("acknowledge");
    expect(tokens.join("")).toBe(result11.utterance);

    view = interviewReducer(view, { type: "move", move: result11.move });
    for (const t of tokens) {
      view = interviewReducer(view, { type: "token", text: t });
    }
    view = interviewReducer(view, { type: "done", state: result11.state });

    // Step 12: end -> silent, status ended, phase done
    time += 30000;
    now = vi.fn(() => time);
    handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now });

    request = buildEndRequest(view);
    view = interviewReducer(view, { type: "request", request, studentText: null });

    tokens.length = 0;
    
    const result12 = await runRequestThroughClient(handler, request, {
      onMove: () => {},
      onToken: (text) => { tokens.push(text); },
      onModelLabel: () => {},
    });

    expect(result12.move.type).toBe("silent");
    expect(result12.state.phase).toBe("done");

    view = interviewReducer(view, { type: "move", move: result12.move });
    view = interviewReducer(view, { type: "done", state: result12.state });

    expect(view.status).toBe("ended");
    expect(view.engine?.phase).toBe("done");

    // Verify transcript has grown throughout
    expect(view.engine?.transcript.length).toBeGreaterThan(0);
  });
});
