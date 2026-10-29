import "server-only";

import { getConfig } from "./load";
import type { InterviewConfig } from "@/contracts";

export interface PublicConfig {
  id: string;
  title: string;
  subject: string;
  styles: { id: string; label: string }[];
  problems: { id: string; title: string; statement: string; canvasHint?: string }[];
  timing: { maxMinutes: number };
}

/**
 * Project a full InterviewConfig to a public-safe shape.
 * Explicitly picks fields to avoid leaking solutionSketch, hints, probes, etc.
 */
export function getPublicConfig(id: string): PublicConfig {
  const config = getConfig(id);
  return projectConfig(config);
}

function projectConfig(config: InterviewConfig): PublicConfig {
  return {
    id: config.id,
    title: config.title,
    subject: config.subject,
    styles: config.styles.map((s) => ({ id: s.id, label: s.label })),
    problems: config.problems.map((p) => {
      const problem: PublicConfig["problems"][number] = {
        id: p.id,
        title: p.title,
        statement: p.statement,
      };
      // Only include canvasHint if the problem has one
      if (p.canvasHint !== undefined) {
        problem.canvasHint = p.canvasHint;
      }
      return problem;
    }),
    timing: { maxMinutes: config.timing.maxMinutes },
  };
}
