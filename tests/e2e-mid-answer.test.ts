import { describe, it, expect } from "vitest";
import { createStepHandler } from "../src/server/step-handler";
import { fakeAssess, fakeSpeak } from "../src/server/fake-model";
import {
  interviewReducer,
  initialView,
  buildStartRequest,
  buildBackgroundRequest,
  buildTurnRequest,
  describeError,
} from "../src/client/interview-model";
import type { InterviewView, InterviewAction, BackgroundEvent } from "../src/client/interview-model";
import { createBackgroundRunner } from "../src/client/background-runner";
import { createRequestRunner } from "../src/client/request-runner";
import { runStepRequest } from "../src/client/step-client";
import type { Move } from "@/contracts";

const P7 = "I think this is wrong because two";
const P14 = "I think the answer is wrong because two is not a perfect square here";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Real step handler + fake model, a foreground request runner and a background runner sharing one local view.
function harness(assess: typeof fakeAssess = fakeAssess) {
  let clock = 1_000_000;
  const handler = createStepHandler({ assess, speak: fakeSpeak, now: () => clock });
  let view: InterviewView = initialView;
  const log: InterviewAction[] = [];
  const settled: (Move | null)[] = [];
  const apply = (a: InterviewAction) => {
    log.push(a);
    view = interviewReducer(view, a);
  };
  const deps = {
    runStepRequest: ((request, opts) =>
      runStepRequest(request, {
        ...opts,
        fetchImpl: (url, init) => handler(new Request("http://test" + String(url), init)),
      })) as typeof runStepRequest,
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    describeError,
  };
  const fg = createRequestRunner({ ...deps, dispatch: apply });
  const bg = createBackgroundRunner({ ...deps, dispatch: apply, onSettled: (m) => settled.push(m) });
  const waitIdle = async () => {
    for (let i = 0; i < 400 && (fg.inFlight() || bg.inFlight()); i++) await sleep(5);
    expect(fg.inFlight() || bg.inFlight()).toBe(false);
  };
  return {
    get view() {
      return view;
    },
    log,
    settled,
    fg,
    bg,
    waitIdle,
    setNow: (t: number) => {
      clock = t;
    },
  };
}

async function started(assess?: typeof fakeAssess) {
  const h = harness(assess);
  h.fg.run(buildStartRequest("maths-oxbridge", "supportive"), null);
  await h.waitIdle();
  expect(h.view.status).toBe("ready");
  expect(h.view.engine?.phase).toBe("problem");
  h.setNow(1_005_000);
  h.log.length = 0;
  return h;
}

async function background(h: Awaited<ReturnType<typeof started>>, event: BackgroundEvent) {
  const before = h.settled.length;
  h.bg.run(buildBackgroundRequest(h.view, event));
  expect(h.view.background).toBe("pending");
  expect(h.view.status).toBe("ready");
  await h.waitIdle();
  expect(h.settled.length).toBe(before + 1);
  return h.settled[h.settled.length - 1];
}

describe("e2e-mid-answer (M3 regression)", () => {
  it("partial P7 → silent, transcript unchanged, lastInterjectAt null", async () => {
    const h = await started();
    const move = await background(h, { type: "partial", text: P7 });

    expect(move).toEqual({ type: "silent" });
    expect(h.view.engine?.transcript).toHaveLength(1);
    expect(h.view.engine?.lastInterjectAt).toBeNull();
    expect(h.view.background).toBe("none");
    expect(h.view.status).toBe("ready");
    expect(h.log.filter((a) => a.type === "token")).toEqual([]);
    expect(h.log.filter((a) => a.type === "bg_move")).toEqual([{ type: "bg_move", move: { type: "silent" } }]);
  });

  it("partial P14 → realign, lastInterjectAt set, turnWordBaseline 14, transcript + interjection", async () => {
    const h = await started();
    const move = await background(h, { type: "partial", text: P14 });

    expect(move).toEqual({ type: "realign", misconceptionId: "lowest-terms-missing" });
    const engine = h.view.engine;
    expect(engine?.lastInterjectAt).toBe(1_005_000);
    expect(engine?.turnWordBaseline).toBe(14);
    expect(engine?.transcript).toHaveLength(2);
    const last = engine?.transcript[engine.transcript.length - 1];
    expect(last?.speaker).toBe("interviewer");
    expect(last?.kind).toBe("interjection");
    const joined = h.log.map((a) => (a.type === "token" ? a.text : "")).join("");
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toBe(last?.text);
    expect(h.view.status).toBe("ready");
    expect(h.view.background).toBe("none");
    expect(h.view.streamingText).toBe("");
  });

  it("partial P14 + more within cooldown → silent", async () => {
    const h = await started();
    await background(h, { type: "partial", text: P14 });
    expect(h.view.engine?.lastInterjectAt).toBe(1_005_000);

    h.setNow(1_006_000);
    const move = await background(h, { type: "partial", text: P14 + " so it is irrational" });
    expect(move).toEqual({ type: "silent" });
    expect(h.view.engine?.lastInterjectAt).toBe(1_005_000);
    expect(h.view.engine?.transcript).toHaveLength(2);
  });

  it("canvas → silent, transcript unchanged", async () => {
    const h = await started();
    const move = await background(h, { type: "canvas", image: "data:image/png;base64,iVBORw0KGgo=" });
    expect(move).toEqual({ type: "silent" });
    expect(h.view.engine?.transcript).toHaveLength(1);
    expect(h.view.status).toBe("ready");
    expect(h.view.background).toBe("none");
  });

  it("silence 10000 → silent", async () => {
    const h = await started();
    const move = await background(h, { type: "silence", ms: 10000 });
    expect(move).toEqual({ type: "silent" });
    expect(h.view.engine?.transcript).toHaveLength(1);
  });

  it("silence 20000 → hint, hintRung=0, transcript + utterance", async () => {
    const h = await started();
    const move = await background(h, { type: "silence", ms: 20000 });
    expect(move).toEqual({ type: "hint", rung: 0 });
    expect(h.view.engine?.hintRung).toBe(0);
    expect(h.view.engine?.transcript).toHaveLength(2);
    const last = h.view.engine?.transcript[1];
    expect(last?.speaker).toBe("interviewer");
    expect(last?.kind).toBe("utterance");
    expect(h.view.status).toBe("ready");
    expect(h.view.background).toBe("none");
  });

  it("foreground turn supersedes pending background step", async () => {
    let gateNext = false;
    let assessEntered = false;
    let release: () => void = () => {};
    const gated: typeof fakeAssess = async (args) => {
      if (gateNext) {
        gateNext = false;
        assessEntered = true;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return fakeAssess(args);
    };
    const h = await started(gated);

    gateNext = true;
    h.bg.run(buildBackgroundRequest(h.view, { type: "partial", text: P14 }));
    for (let i = 0; i < 200 && !assessEntered; i++) await sleep(5);
    expect(assessEntered).toBe(true);
    expect(h.view.background).toBe("pending");

    const fgStart = h.log.length;
    h.fg.run(buildTurnRequest(h.view, "Hello"), "Hello");
    h.bg.abort();
    expect(h.settled).toEqual([null]);
    expect(h.view.status).toBe("sending");
    expect(h.view.background).toBe("none");

    release();
    await h.waitIdle();
    await sleep(300);

    const after = h.log.slice(fgStart).map((a) => a.type);
    expect(after[0]).toBe("request");
    expect(after.filter((t) => t.startsWith("bg_"))).toEqual([]);
    expect(after.filter((t) => t === "done")).toHaveLength(1);
    expect(h.settled).toEqual([null]);
    expect(h.view.status).toBe("ready");
    expect(h.view.background).toBe("none");
    expect(h.view.engine?.lastInterjectAt).toBeNull();
    expect(h.view.engine?.transcript.some((e) => e.speaker === "student" && e.text === "Hello")).toBe(true);
  });
});
