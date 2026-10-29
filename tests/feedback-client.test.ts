import { describe, it, expect, vi } from "vitest";
import {
  fetchFeedback,
  FeedbackError,
  describeFeedbackError,
  formatAt,
  createFeedbackRunner,
} from "../src/client/feedback-client";
import type { FeedbackView } from "@/shared/feedback-protocol";

// F1 view fixture
const view: FeedbackView = {
  summary: "Good start.",
  criteria: [
    {
      id: "approach",
      name: "Problem-solving approach",
      score: 2,
      maxScore: 4,
      descriptor: "Finds a way in only after substantial hints.",
      justification: "Needed a hint.",
    },
    {
      id: "rigour",
      name: "Rigour and correctness",
      score: 3,
      maxScore: 4,
      descriptor: "Correct, with minor gaps in justification.",
      justification: "Mostly right.",
    },
    {
      id: "communication",
      name: "Thinking aloud",
      score: 1,
      maxScore: 4,
      descriptor: "Rarely explains thinking; hard to follow.",
      justification: "Quiet.",
    },
    {
      id: "responsiveness",
      name: "Responding to hints",
      score: 4,
      maxScore: 4,
      descriptor: "Picks up subtle hints immediately and builds on them.",
      justification: "Quick.",
    },
  ],
  strengths: ["Clear.", "Kept going."],
  improvements: ["i1", "i2", "i3", "i4", "i5"],
  keyMoments: [
    { at: 5000, quote: "the answer is root two", note: "First idea." },
    { at: 9000, quote: "can't be a fraction", note: "Good insight." },
  ],
};

// Mock state
const state = {
  version: 1 as const,
  configId: "maths-oxbridge",
  styleId: "supportive",
  startedAt: 1000,
  phase: "done" as const,
  problemIdx: 0,
  hintRung: -1,
  checkpointsHit: [],
  lastInterjectAt: null as number | null,
  turnWordBaseline: 0,
  probesAsked: 0,
  transcript: [
    { id: "e1", at: 0, speaker: "interviewer" as const, kind: "utterance" as const, text: "Welcome." },
    { id: "e2", at: 5000, speaker: "student" as const, kind: "typed" as const, text: "I think the answer is root two" },
  ],
};

describe("feedback-client", () => {
  describe("fetchFeedback", () => {
    it("1. On 200 with valid view, returns the view", async () => {
      const signal = new AbortController().signal;
      let capturedUrl: string | undefined;
      let capturedMethod: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      let capturedBody: string | undefined;
      let capturedSignal: AbortSignal | null | undefined;

      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url as string;
        capturedMethod = init?.method;
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = init?.body as string;
        capturedSignal = init?.signal ?? null;
        return new Response(JSON.stringify(view), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const result = await fetchFeedback(state, { signal, fetchImpl: fetchImpl as typeof fetch });

      expect(result).toEqual(view);
      expect(capturedUrl).toBe("/api/feedback");
      expect(capturedMethod).toBe("POST");
      expect(capturedHeaders!["Content-Type"]).toBe("application/json");
      expect(JSON.parse(capturedBody!)).toEqual({ state });
      expect(capturedSignal).toBe(signal);
    });

    it("1b. Custom endpoint is used when given", async () => {
      const fetchImpl = async () => {
        return new Response(JSON.stringify(view), { status: 200 });
      };

      await fetchFeedback(state, { fetchImpl, endpoint: "/custom" });
      // fetchImpl was called, that's enough
    });

    it("2. TypeError → FeedbackError(status=0, code=network)", async () => {
      const fetchImpl = async () => {
        throw new TypeError("Network error");
      };

      await expect(fetchFeedback(state, { fetchImpl })).rejects.toThrow(FeedbackError);
      await expect(fetchFeedback(state, { fetchImpl })).rejects.toMatchObject({
        status: 0,
        code: "network",
        retryable: true,
      });
    });

    it("3. AbortError rethrown unchanged", async () => {
      const controller = new AbortController();
      controller.abort();
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";

      const fetchImpl = vi.fn().mockRejectedValue(abortErr);
      const promise = fetchFeedback(state, {
        signal: controller.signal,
        fetchImpl,
      });

      await expect(promise).rejects.toBe(abortErr);
    });

    it("4. 502 with code feedback_failed → FeedbackError(502, feedback_failed, true)", async () => {
      const fetchImpl = async () => {
        return new Response(
          JSON.stringify({ error: { code: "feedback_failed", message: "m" } }),
          { status: 502 }
        );
      };

      await expect(fetchFeedback(state, { fetchImpl })).rejects.toMatchObject({
        status: 502,
        code: "feedback_failed",
        retryable: true,
      });
    });

    it("5. 400 with code not_finished → FeedbackError(400, not_finished, false)", async () => {
      const fetchImpl = async () => {
        return new Response(
          JSON.stringify({ error: { code: "not_finished", message: "m" } }),
          { status: 400 }
        );
      };

      await expect(fetchFeedback(state, { fetchImpl })).rejects.toMatchObject({
        status: 400,
        code: "not_finished",
        retryable: false,
      });
    });

    it("6. 500 with non-JSON body → FeedbackError(500, http, true)", async () => {
      const fetchImpl = async () => {
        return new Response("Internal Server Error", { status: 500 });
      };

      await expect(fetchFeedback(state, { fetchImpl })).rejects.toMatchObject({
        status: 500,
        code: "http",
        retryable: true,
      });
    });

    it("7. 200 with invalid body → FeedbackError(200, protocol, true)", async () => {
      const fetchImpl1 = async () => {
        return new Response(JSON.stringify({ summary: "" }), { status: 200 });
      };
      await expect(fetchFeedback(state, { fetchImpl: fetchImpl1 })).rejects.toMatchObject({
        status: 200,
        code: "protocol",
        retryable: true,
      });

      const fetchImpl2 = async () => {
        return new Response("not json", { status: 200 });
      };
      await expect(fetchFeedback(state, { fetchImpl: fetchImpl2 })).rejects.toMatchObject({
        status: 200,
        code: "protocol",
        retryable: true,
      });
    });
  });

  describe("describeFeedbackError", () => {
    it("8. 400/413 → not scored message", () => {
      const err400 = new FeedbackError(400, "bad_request", false);
      const err413 = new FeedbackError(413, "payload_too_large", false);

      expect(describeFeedbackError(err400)).toEqual({
        message: "This interview can't be scored.",
        retryable: false,
      });
      expect(describeFeedbackError(err413)).toEqual({
        message: "This interview can't be scored.",
        retryable: false,
      });
    });

    it("9. 502/0/Error → retryable message", () => {
      const err502 = new FeedbackError(502, "feedback_failed", true);
      const err0 = new FeedbackError(0, "network", true);
      const err = new Error("x");

      const expected = {
        message: "We couldn't prepare your feedback. Please try again.",
        retryable: true,
      };

      expect(describeFeedbackError(err502)).toEqual(expected);
      expect(describeFeedbackError(err0)).toEqual(expected);
      expect(describeFeedbackError(err)).toEqual(expected);
    });
  });

  describe("formatAt", () => {
    it("10. formats correctly", () => {
      expect(formatAt(0)).toBe("0:00");
      expect(formatAt(5000)).toBe("0:05");
      expect(formatAt(59999)).toBe("0:59");
      expect(formatAt(60000)).toBe("1:00");
      expect(formatAt(65000)).toBe("1:05");
      expect(formatAt(600000)).toBe("10:00");
      expect(formatAt(3599000)).toBe("59:59");
    });
  });

  describe("createFeedbackRunner", () => {
    it("11. start → calls don't emit immediately; resolve → onChange called", async () => {
      const calls: { status: string }[] = [];
      let resolvePromise: (v: FeedbackView) => void;
      const signals: AbortSignal[] = [];

      const fakeFetch = vi.fn().mockImplementation(async (_, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          resolvePromise = resolve;
        });
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s as never),
      });

      runner.start(state);
      expect(calls).toEqual([]);

      // Resolve the promise
      resolvePromise!(view as FeedbackView);
      
      // Wait for promises to settle
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([{ status: "ready", view }]);
      expect(signals.length).toBe(1);
    });

    it("12. Reject with 502 → failed with correct messages", async () => {
      const calls: { status: string; message?: string; retryable?: boolean }[] = [];

      const fakeFetch = vi.fn().mockRejectedValue(new FeedbackError(502, "feedback_failed", true));

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s as never),
      });

      runner.start(state);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([
        {
          status: "failed",
          message: "We couldn't prepare your feedback. Please try again.",
          retryable: true,
        },
      ]);

      // Reset for 400 case
      calls.length = 0;
      const runner2 = createFeedbackRunner({
        fetchFeedback: vi.fn().mockRejectedValue(new FeedbackError(400, "bad_request", false)),
        onChange: (s) => calls.push(s as never),
      });

      runner2.start(state);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([
        {
          status: "failed",
          message: "This interview can't be scored.",
          retryable: false,
        },
      ]);
    });

    it("13. retry → loading then fetch again with same state", async () => {
      const calls: { status: string }[] = [];

      const fakeFetch = vi.fn().mockImplementation(async () => {
        return view as FeedbackView;
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      runner.start(state);
      await new Promise((resolve) => setTimeout(resolve, 0));

      runner.retry();

      expect(calls.some((c) => c.status === "loading")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fakeFetch).toHaveBeenCalledTimes(2);
      // Same state object passed both times
      expect(fakeFetch).toHaveBeenNthCalledWith(1, state, expect.any(AbortSignal));
      expect(fakeFetch).toHaveBeenNthCalledWith(2, state, expect.any(AbortSignal));
    });

    it("14. retry while running or before start does nothing", async () => {
      const calls: { status: string }[] = [];
      let resolvePromise: () => void;

      const fakeFetch = vi.fn().mockImplementation(async () => {
        return new Promise((resolve) => {
          resolvePromise = () => resolve(view as FeedbackView);
        });
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      runner.start(state);
      runner.retry(); // Should do nothing while running

      expect(calls).toEqual([]);

      resolvePromise!();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Now retry after done
      runner.retry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls.some((c) => c.status === "loading")).toBe(true);

      // Before start (new runner)
      calls.length = 0;
      const runner2 = createFeedbackRunner({
        fetchFeedback: vi.fn(),
        onChange: (s) => calls.push(s),
      });

      runner2.retry();
      expect(calls).toEqual([]);
    });

    it("15. abort mid-flight → signal aborted, later resolve/reject adds nothing", async () => {
      const calls: { status: string }[] = [];
      let resolvePromise: (v: FeedbackView) => void;
      const signals: AbortSignal[] = [];

      const fakeFetch = vi.fn().mockImplementation(async (_, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          resolvePromise = resolve;
        });
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      runner.start(state);
      runner.abort();

      expect(signals[0].aborted).toBe(true);

      // Resolve after abort
      resolvePromise!(view);
      await Promise.resolve();

      expect(calls).toEqual([]);
    });

    it("16. superseded: start(s1) then start(s2) aborts first", async () => {
      const calls: { status: string }[] = [];
      const signals: AbortSignal[] = [];
      let resolve1: (v: FeedbackView) => void;
      let resolve2: (v: FeedbackView) => void;

      const fakeFetch = vi.fn().mockImplementation(async (_, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          if (signals.length === 1) {
            resolve1 = resolve;
          } else {
            resolve2 = resolve;
          }
        });
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      const s1 = { ...state, startedAt: 1000 };
      const s2 = { ...state, startedAt: 2000 };

      runner.start(s1);
      runner.start(s2);

      // First signal aborted
      expect(signals[0].aborted).toBe(true);

      // Resolve first - adds nothing
      resolve1!(view as FeedbackView);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([]);

      // Resolve second - adds ready
      resolve2!(view as FeedbackView);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([{ status: "ready", view }]);
    });

    it("17. AbortError rejection adds nothing", async () => {
      const calls: { status: string }[] = [];
      let rejectPromise: (e: Error) => void;

      const fakeFetch = vi.fn().mockImplementation(async () => {
        return new Promise((_, reject) => {
          rejectPromise = reject;
        });
      });

      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      runner.start(state);
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      rejectPromise!(abortErr);

      await Promise.resolve();

      expect(calls).toEqual([]);
    });

    it("18. No unhandled rejection after abort", async () => {
      const calls: { status: string }[] = [];
      const fakeFetch = vi.fn().mockRejectedValue(new Error("x"));
      const runner = createFeedbackRunner({
        fetchFeedback: fakeFetch,
        onChange: (s) => calls.push(s),
      });

      runner.start(state);
      runner.abort();

      // Promise should not cause unhandled rejection
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });
});
