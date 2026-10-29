import { describe, it, expect } from "vitest";
import { scoreLive, summarize, type ScoreRow } from "../src/eval/score";
import type { Assessment } from "@/contracts";
import type { LiveExpect } from "../src/eval/schema";

describe("eval score", () => {
  describe("scoreLive", () => {
    it("passes when matching", () => {
      const liveExpect: LiveExpect = { status: ["stuck", "progressing"] };
      const actual: Assessment = { status: "stuck", confidence: 0.8, checkpointsHit: [], misconceptionId: null, evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(true);
      expect(result.why).toBe("ok");
    });

    it("fails when actual is null", () => {
      const liveExpect: LiveExpect = { status: ["stuck"] };
      const result = scoreLive(liveExpect, null);
      expect(result.pass).toBe(false);
      expect(result.why).toBe("assessor returned null");
    });

    it("fails when wrong status", () => {
      const liveExpect: LiveExpect = { status: ["stuck", "progressing"] };
      const actual: Assessment = { status: "correct", confidence: 0.9, checkpointsHit: [], misconceptionId: null, evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("status correct not in [stuck, progressing]");
    });

    it("passes when misconceptionId matches", () => {
      const liveExpect: LiveExpect = { status: ["off_track"], misconceptionId: "m1" };
      const actual: Assessment = { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: "m1", evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(true);
      expect(result.why).toBe("ok");
    });

    it("fails when misconceptionId mismatched", () => {
      const liveExpect: LiveExpect = { status: ["off_track"], misconceptionId: "m1" };
      const actual: Assessment = { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: "m2", evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("misconception m2 != m1");
    });

    it("ignores misconceptionId when undefined in expect", () => {
      const liveExpect: LiveExpect = { status: ["off_track"] };
      const actual: Assessment = { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: "m1", evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(true);
    });

    it("passes when null misconceptionId expected and actual null", () => {
      const liveExpect: LiveExpect = { status: ["off_track"], misconceptionId: null };
      const actual: Assessment = { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: null, evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(true);
    });

    it("fails when null misconceptionId expected but actual is non-null", () => {
      const liveExpect: LiveExpect = { status: ["off_track"], misconceptionId: null };
      const actual: Assessment = { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: "lowest-terms-missing", evidence: "test" };
      const result = scoreLive(liveExpect, actual);
      expect(result.pass).toBe(false);
      expect(result.why).toBe("misconception lowest-terms-missing != null");
    });
  });

  describe("summarize", () => {
    it("calculates pass rate", () => {
      const rows: ScoreRow[] = [
        { scriptId: "a", index: 0, eventType: "partial", pass: true, latencyMs: 100 },
        { scriptId: "a", index: 1, eventType: "partial", pass: false, latencyMs: 200 },
        { scriptId: "a", index: 2, eventType: "partial", pass: true, latencyMs: 300 },
      ];
      const result = summarize(rows);
      expect(result.total).toBe(3);
      expect(result.passed).toBe(2);
      expect(result.passRate).toBeCloseTo(2 / 3);
    });

    it("returns 0 pass rate for empty rows", () => {
      const result = summarize([]);
      expect(result.total).toBe(0);
      expect(result.passed).toBe(0);
      expect(result.passRate).toBe(0);
    });

    it("calculates p50/p95 for partial and turn_complete separately", () => {
      const rows: ScoreRow[] = [
        { scriptId: "a", index: 0, eventType: "partial", pass: true, latencyMs: 100 },
        { scriptId: "a", index: 1, eventType: "partial", pass: true, latencyMs: 200 },
        { scriptId: "a", index: 2, eventType: "turn_complete", pass: true, latencyMs: 300 },
        { scriptId: "a", index: 3, eventType: "turn_complete", pass: true, latencyMs: 400 },
      ];
      const result = summarize(rows);
      // p50 for partial: nearest-rank on [100, 200], ceil(50/100 * 2) - 1 = 0, so 100
      expect(result.p50.partial).toBe(100);
      // p50 for turn: nearest-rank on [300, 400], ceil(50/100 * 2) - 1 = 0, so 300
      expect(result.p50.turn_complete).toBe(300);
    });

    it("returns null for empty event type", () => {
      const rows: ScoreRow[] = [
        { scriptId: "a", index: 0, eventType: "partial", pass: true, latencyMs: 100 },
      ];
      const result = summarize(rows);
      expect(result.p95.turn_complete).toBe(null);
    });

    it("uses nearest-rank for percentiles", () => {
      // Test with known array: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
      const rows: ScoreRow[] = Array.from({ length: 10 }, (_, i) => ({
        scriptId: "a",
        index: i,
        eventType: "partial" as const,
        pass: true,
        latencyMs: (i + 1) * 100,
      }));
      const result = summarize(rows);
      // p50: ceil(50/100 * 10) - 1 = 4, so 500
      expect(result.p50.partial).toBe(500);
      // p95: ceil(95/100 * 10) - 1 = 9, so 1000
      expect(result.p95.partial).toBe(1000);
    });
  });
});
