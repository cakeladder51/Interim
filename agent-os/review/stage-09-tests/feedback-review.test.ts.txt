// Reviewer tests for Stage 9 (stage-09-review.md T1). Copy byte-identical to tests/feedback-review.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenAI } from "openai";
import { EngineStateSchema, type EngineState, type InterviewConfig, type Report } from "@/contracts";
import { getConfig, getStyle } from "@/config/load";
import { MetaError } from "@/lib/meta";
import { toFeedbackView, noAnswerView } from "@/server/feedback";
import { fakeReport, fakeGenerate } from "@/server/fake-feedback";
import { createFeedbackHandler, type FeedbackDeps } from "@/server/feedback-handler";
import {
  FeedbackError,
  fetchFeedback,
  createFeedbackRunner,
  type FeedbackSnapshot,
} from "@/client/feedback-client";
import type { FeedbackView } from "@/shared/feedback-protocol";

const maths = getConfig("maths-oxbridge");
const supportive = getStyle(maths, "supportive");

type Entry = EngineState["transcript"][number];
const makeState = (transcript: Entry[], phase: EngineState["phase"] = "done"): EngineState =>
  EngineStateSchema.parse({
    version: 1, configId: "maths-oxbridge", styleId: "supportive", startedAt: 1000, phase, problemIdx: 0,
    hintRung: -1, checkpointsHit: [], lastInterjectAt: null, turnWordBaseline: 0, probesAsked: 0, transcript,
  });
const say = (id: string, at: number, speaker: "interviewer" | "student", text: string): Entry => ({
  id, at, speaker, kind: speaker === "student" ? "typed" : "utterance", text,
});
const welcome = say("e1", 0, "interviewer", "Welcome. Let's begin.");
const state = makeState([welcome, say("e2", 5000, "student", "I think   the answer is\nroot two"), say("e3", 5000, "interviewer", "Why is that?")]);
const noStudent = makeState([welcome]);
const withStudents = (n: number) =>
  makeState(Array.from({ length: n }, (_, i) => say(`s${i}`, 1000 * (i + 1), "student", "x")));

const C4: Report["criteria"] = [
  { id: "approach", score: 2, justification: "a" },
  { id: "rigour", score: 3, justification: "r" },
  { id: "communication", score: 1, justification: "c" },
  { id: "responsiveness", score: 4, justification: "s" },
];
const report = (over: Partial<Report> = {}): Report => ({
  summary: "Fine.", criteria: C4, strengths: [], improvements: [], keyMoments: [], ...over,
});
const invalid = report({ criteria: C4.slice(1) });

// One criterion whose levels are listed highest first.
const DESC: InterviewConfig = {
  ...maths,
  rubric: {
    criteria: [
      { id: "approach", name: "Approach", levels: [{ score: 3, descriptor: "High." }, { score: 2, descriptor: "Mid." }, { score: 1, descriptor: "Low." }] },
    ],
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reviewer: toFeedbackView V4/V5", () => {
  it("V4: strengths and improvements are trimmed, empty items dropped, then capped at 5", () => {
    const v = toFeedbackView(maths, state, report({
      strengths: [" s1 ", "s2", "", "s3", "  ", "s4", "s5", "s6", "s7"],
      improvements: ["  i1  ", "", "i2", " ", "i3", "i4", "i5", "i6"],
    }));
    expect(v.strengths).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(v.improvements).toEqual(["i1", "i2", "i3", "i4", "i5"]);
  });

  it("V5: notes are trimmed, equal-at moments keep report order, and the cap of 5 applies after sorting", () => {
    const s = makeState(Array.from({ length: 7 }, (_, i) => say(`s${i + 1}`, 1000 * (i + 1), "student", `word${i + 1} alpha beta`)));
    const desc = [7000, 6000, 5000, 4000, 3000, 2000].map((at) => ({ at, quote: "alpha", note: ` n${at / 1000} ` }));
    const v = toFeedbackView(maths, s, report({
      keyMoments: [...desc, { at: 1000, quote: "word1", note: " first " }, { at: 1000, quote: "alpha", note: " second " }],
    }));
    expect(v.keyMoments).toEqual([
      { at: 1000, quote: "word1", note: "first" },
      { at: 1000, quote: "alpha", note: "second" },
      { at: 2000, quote: "alpha", note: "n2" },
      { at: 3000, quote: "alpha", note: "n3" },
      { at: 4000, quote: "alpha", note: "n4" },
    ]);
  });

  it("noAnswerView uses the lowest-score level even when levels are listed highest first", () => {
    expect(noAnswerView(DESC).criteria).toEqual([
      { id: "approach", name: "Approach", score: 1, maxScore: 3, descriptor: "Low.", justification: "No answer was given." },
    ]);
  });
});

describe("reviewer: fakeReport / fakeGenerate", () => {
  it("fakeReport with no student lines", () => {
    const j = "Offline estimate from 0 answers.";
    expect(fakeReport(maths, noStudent)).toEqual({
      summary: "Offline practice feedback: you answered 0 times.",
      criteria: [
        { id: "approach", score: 1, justification: j },
        { id: "rigour", score: 1, justification: j },
        { id: "communication", score: 1, justification: j },
        { id: "responsiveness", score: 1, justification: j },
      ],
      strengths: ["You kept going and shared your thinking."],
      improvements: ["Justify each step before moving on."],
      keyMoments: [],
    });
  });

  it("fakeReport sorts levels by score before indexing", () => {
    const scores = [0, 3, 6, 9].map((n) => fakeReport(DESC, withStudents(n)).criteria[0].score);
    expect(scores).toEqual([1, 2, 3, 3]);
    expect(() => toFeedbackView(DESC, withStudents(3), fakeReport(DESC, withStudents(3)))).not.toThrow();
  });

  it("fakeGenerate resolves at 300 ms, not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const p = fakeGenerate({ config: maths, style: supportive, state }).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await p).toEqual(fakeReport(maths, state));
  });
});

// A Request stand-in whose signal is the test's own signal (a real Request only follows its creator's abort weakly).
const fakeRequest = (body: unknown, signal: AbortSignal = new AbortController().signal) =>
  ({ headers: new Headers({ "content-type": "application/json" }), json: async () => body, signal }) as unknown as Request;
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://test/api/feedback", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

describe("reviewer: feedback handler", () => {
  it("H5 runs before H6: an unfinished interview with no student lines is not_finished", async () => {
    const generate = vi.fn(async () => report());
    const res = await createFeedbackHandler({ generate, sleep: vi.fn(async () => {}) })(post(JSON.stringify({ state: makeState([welcome], "problem") })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "not_finished", message: "The interview hasn't finished yet." } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("every response is JSON with Cache-Control: no-store", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: FeedbackDeps = { generate: vi.fn(async () => { throw new MetaError("upstream", "u", false); }), sleep: vi.fn(async () => {}) };
    const h = createFeedbackHandler(failing);
    const cases: [string, Request, number][] = [
      ["413", post(JSON.stringify({ state }), { "content-length": "1000001" }), 413],
      ["bad json", post("{"), 400],
      ["not finished", post(JSON.stringify({ state: makeState(state.transcript, "problem") })), 400],
      ["no answer", post(JSON.stringify({ state: noStudent })), 200],
      ["failed", post(JSON.stringify({ state })), 502],
    ];
    for (const [name, req, status] of cases) {
      const res = await h(req);
      expect([name, res.status]).toEqual([name, status]);
      expect([name, res.headers.get("content-type")]).toEqual([name, "application/json"]);
      expect([name, res.headers.get("cache-control")]).toEqual([name, "no-store"]);
    }
  });

  it("an abort seen on request.signal stops retries even for a retryable error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ac = new AbortController();
    const generate = vi.fn(async () => { ac.abort(); throw new MetaError("timeout", "t", true); });
    const sleep = vi.fn(async () => {});
    const res = await createFeedbackHandler({ generate, sleep })(fakeRequest({ state }, ac.signal));
    expect(res.status).toBe(502);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("B1: an abort during the retry wait stops the second attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ac = new AbortController();
    const generate = vi.fn(async () => { throw new MetaError("timeout", "t", true); });
    const sleep = vi.fn(async () => { ac.abort(); });
    const res = await createFeedbackHandler({ generate, sleep })(fakeRequest({ state }, ac.signal));
    expect(res.status).toBe(502);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("the retry wait is exactly 400 ms and never follows the last attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const generate = vi.fn(async () => invalid);
    const sleep = vi.fn(async (ms: number) => { void ms; });
    const res = await createFeedbackHandler({ generate, sleep })(fakeRequest({ state }));
    expect(res.status).toBe(502);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[400]]);
  });

  it("without a sleep dep, the retry waits a real 400 ms timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const generate = vi.fn<FeedbackDeps["generate"]>().mockResolvedValueOnce(invalid).mockResolvedValueOnce(report());
    const p = createFeedbackHandler({ generate })(fakeRequest({ state }));
    await vi.advanceTimersByTimeAsync(399);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("reviewer: fetchFeedback aborts and endpoint", () => {
  const ok = () => new Response(JSON.stringify(noAnswerView(maths)), { status: 200 });

  it("uses a custom endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return ok(); }) as unknown as typeof fetch;
    await fetchFeedback(state, { fetchImpl, endpoint: "/x/feedback" });
    expect(urls).toEqual(["/x/feedback"]);
  });

  it("rethrows any rejection unchanged once the caller's signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = new TypeError("Failed to fetch");
    const fetchImpl = (async () => { throw err; }) as unknown as typeof fetch;
    await expect(fetchFeedback(state, { fetchImpl, signal: ac.signal })).rejects.toBe(err);
  });

  it("rethrows an AbortError unchanged even without a signal", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = (async () => { throw err; }) as unknown as typeof fetch;
    await expect(fetchFeedback(state, { fetchImpl })).rejects.toBe(err);
  });
});

describe("reviewer: feedback runner", () => {
  const view: FeedbackView = noAnswerView(maths);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  type Pending = { state: EngineState; signal: AbortSignal; resolve: (v: FeedbackView) => void; reject: (e: unknown) => void };
  function harness(calls: FeedbackSnapshot[] = []) {
    const pending: Pending[] = [];
    const fetchFn = vi.fn((s: EngineState, signal: AbortSignal) =>
      new Promise<FeedbackView>((resolve, reject) => { pending.push({ state: s, signal, resolve, reject }); }));
    const runner = createFeedbackRunner({ fetchFeedback: fetchFn, onChange: (x) => calls.push(x) });
    return { calls, pending, fetchFn, runner };
  }
  const failed502 = { status: "failed", message: "We couldn't prepare your feedback. Please try again.", retryable: true };

  it("abort(): a late resolve or a late reject emits nothing", async () => {
    const a = harness();
    a.runner.start(state);
    a.runner.abort();
    expect(a.pending[0].signal.aborted).toBe(true);
    a.pending[0].resolve(view);
    await flush();
    expect(a.calls).toEqual([]);

    const b = harness();
    b.runner.start(state);
    b.runner.abort();
    b.pending[0].reject(new FeedbackError(502, "feedback_failed", true));
    await flush();
    expect(b.calls).toEqual([]);
  });

  it("a superseded run's failure emits nothing; the current run still reports", async () => {
    const h = harness();
    h.runner.start(state);
    h.runner.start(noStudent);
    h.pending[0].reject(new FeedbackError(502, "feedback_failed", true));
    await flush();
    expect(h.calls).toEqual([]);
    h.pending[1].resolve(view);
    await flush();
    expect(h.calls).toEqual([{ status: "ready", view }]);
  });

  it("an AbortError on the current run emits nothing and clears the run", async () => {
    const h = harness();
    h.runner.start(state);
    h.pending[0].reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await flush();
    expect(h.calls).toEqual([]);
    h.runner.retry();
    expect(h.calls).toEqual([{ status: "loading" }]);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("after a failure, retry() emits loading and re-fetches with the same state object", async () => {
    const h = harness();
    h.runner.start(state);
    h.pending[0].reject(new FeedbackError(502, "feedback_failed", true));
    await flush();
    expect(h.calls).toEqual([failed502]);
    h.runner.retry();
    expect(h.calls).toEqual([failed502, { status: "loading" }]);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(h.fetchFn.mock.calls[1][0]).toBe(state);
    h.pending[1].resolve(view);
    await flush();
    expect(h.calls).toEqual([failed502, { status: "loading" }, { status: "ready", view }]);
  });

  it("StrictMode mount (start, abort, new runner start) reports exactly once", async () => {
    const calls: FeedbackSnapshot[] = [];
    const first = harness(calls);
    first.runner.start(state);
    first.runner.abort();
    const second = harness(calls);
    second.runner.start(state);
    expect(first.pending[0].signal.aborted).toBe(true);
    first.pending[0].resolve(view);
    second.pending[0].resolve(view);
    await flush();
    expect(calls).toEqual([{ status: "ready", view }]);
  });
});

describe("reviewer: generateReport call options", () => {
  const content = (c: string) => ({ choices: [{ message: { content: c } }] });
  const asClient = (create: unknown) => ({ chat: { completions: { create } } }) as unknown as OpenAI;
  const load = async () => {
    vi.stubEnv("MODEL_API_KEY", "test-key");
    vi.resetModules();
    return import("@/server/feedback");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses retry: false (an invalid output is not retried by chatJSON)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await load();
    const create = vi.fn().mockResolvedValueOnce(content("not json")).mockResolvedValueOnce(content(JSON.stringify(report())));
    await expect(mod.generateReport({ config: maths, style: supportive, state, client: asClient(create) })).rejects.toMatchObject({ code: "invalid_output" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("times out at 20 s, not before", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const create = vi.fn((_body: unknown, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
    let settled = false;
    const outcome = mod.generateReport({ config: maths, style: supportive, state, client: asClient(create) }).then(
      () => { settled = true; return null; },
      (e: unknown) => { settled = true; return e; },
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({ code: "timeout" });
  });

  it("passes the caller's signal through (an aborted call rethrows the original error)", async () => {
    const mod = await load();
    const ac = new AbortController();
    ac.abort();
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const create = vi.fn(async (_body: unknown, opts: { signal: AbortSignal }) => {
      if (opts.signal.aborted) throw err;
      return content(JSON.stringify(report()));
    });
    await expect(mod.generateReport({ config: maths, style: supportive, state, signal: ac.signal, client: asClient(create) })).rejects.toBe(err);
  });
});
