import "server-only";

import type { InterviewConfig, Style, EngineState, Report } from "@/contracts";
import { normalizeText } from "./feedback";

export const FAKE_FEEDBACK_DELAY_MS = 300;

function plural(k: number, w: string): string {
  return `${k} ${w}${k === 1 ? "" : "s"}`;
}

/**
 * Generate a deterministic fake report for offline testing.
 */
export function fakeReport(config: InterviewConfig, state: EngineState): Report {
  const students = state.transcript.filter((e) => e.speaker === "student");
  const n = students.length;

  const summary = `Offline practice feedback: you answered ${plural(n, "time")}.`;

  const criteria = config.rubric.criteria.map((c) => {
    const sorted = [...c.levels].sort((a, b) => a.score - b.score);
    const levelIndex = Math.min(sorted.length - 1, Math.floor(n / 3));
    const level = sorted[levelIndex];
    return {
      id: c.id,
      score: level.score,
      justification: `Offline estimate from ${plural(n, "answer")}.`,
    };
  });

  const strengths = ["You kept going and shared your thinking."];
  const improvements = ["Justify each step before moving on."];

  const keyMoments =
    n > 0
      ? [
          {
            at: students[0].at,
            quote: normalizeText(students[0].text).split(" ").slice(0, 8).join(" "),
            note: "Your first answer.",
          },
        ]
      : [];

  return { summary, criteria, strengths, improvements, keyMoments };
}

/**
 * Generate a fake report with simulated delay.
 */
export async function fakeGenerate(args: {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  signal?: AbortSignal;
}): Promise<Report> {
  // Wait for delay
  await new Promise((resolve) => setTimeout(resolve, FAKE_FEEDBACK_DELAY_MS));

  // Check for abort
  if (args.signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }

  return fakeReport(args.config, args.state);
}
