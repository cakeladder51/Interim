import type { Assessment } from "@/contracts";
import type { LiveExpect } from "./schema";

/**
 * Score a live assessment against expectations.
 */
export function scoreLive(expect: LiveExpect, actual: Assessment | null): { pass: boolean; why: string } {
  if (actual === null) {
    return { pass: false, why: "assessor returned null" };
  }

  if (!expect.status.includes(actual.status)) {
    return { pass: false, why: `status ${actual.status} not in [${expect.status.join(", ")}]` };
  }

  if (expect.misconceptionId !== undefined && actual.misconceptionId !== expect.misconceptionId) {
    return { pass: false, why: `misconception ${actual.misconceptionId} != ${expect.misconceptionId}` };
  }

  return { pass: true, why: "ok" };
}

export interface ScoreRow {
  scriptId: string;
  index: number;
  eventType: string;
  pass: boolean;
  latencyMs: number;
}

export interface SummaryResult {
  total: number;
  passed: number;
  passRate: number;
  p50: Record<"partial" | "turn_complete", number | null>;
  p95: Record<"partial" | "turn_complete", number | null>;
}

/**
 * Summarize live assessment results.
 * Uses nearest-rank percentiles.
 */
export function summarize(rows: ScoreRow[]): SummaryResult {
  const total = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const passRate = total > 0 ? passed / total : 0;

  // Calculate percentiles by event type using nearest-rank
  function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const n = sorted.length;
    const idx = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, Math.min(idx, n - 1))] ?? null;
  }

  const partialLatencies = rows
    .filter((r) => r.eventType === "partial")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  const turnLatencies = rows
    .filter((r) => r.eventType === "turn_complete")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  return {
    total,
    passed,
    passRate,
    p50: {
      partial: percentile(partialLatencies, 50),
      turn_complete: percentile(turnLatencies, 50),
    },
    p95: {
      partial: percentile(partialLatencies, 95),
      turn_complete: percentile(turnLatencies, 95),
    },
  };
}
