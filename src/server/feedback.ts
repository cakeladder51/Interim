import "server-only";

import type { OpenAI } from "openai";
import type { InterviewConfig, Style, EngineState, Report } from "@/contracts";
import { ReportSchema } from "@/contracts";
import { chatJSON } from "@/lib/meta";
import type { FeedbackView } from "@/shared/feedback-protocol";

export const FEEDBACK_TIMEOUT_MS = 20_000;

export class FeedbackInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackInvalidError";
  }
}

/**
 * Normalize whitespace in text: trim and collapse internal whitespace to single spaces.
 */
export function normalizeText(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Generate the system prompt for feedback generation.
 */
export function feedbackSystemPrompt(subject: string): string {
  return `You are an experienced Oxbridge admissions interviewer writing feedback for a student after a practice interview in ${subject}. Score the student against the rubric using only what the transcript shows. Be specific and kind, address the student as "you", and never invent anything the student didn't say. Reply with JSON only.`;
}

/**
 * Build the messages array for the feedback model call.
 */
export function buildFeedbackMessages(
  config: InterviewConfig,
  style: Style,
  state: EngineState
): { role: "system" | "user"; content: string }[] {
  const lines: string[] = [];

  // 1. Interview title
  lines.push(`Interview: ${config.title}`);

  // 2. Interviewer style
  lines.push(`Interviewer style: ${style.label}`);

  // 3. Empty line
  lines.push("");

  // 4. Problems header
  lines.push("Problems:");

  // 5. Problem entries
  for (let i = 0; i < config.problems.length; i++) {
    const p = config.problems[i];
    lines.push(`${i + 1}. ${p.title}: ${p.statement}`);
    lines.push(`   Model solution (for scoring only; never quote it): ${p.solutionSketch}`);
  }

  // 6. Empty line
  lines.push("");

  // 7. Rubric header
  lines.push("Rubric (give each criterion exactly one of its level scores):");

  // 8. Rubric criteria
  for (const c of config.rubric.criteria) {
    lines.push(`- ${c.id} (${c.name}):`);
    for (const l of c.levels) {
      lines.push(`  ${l.score}: ${l.descriptor}`);
    }
  }

  // 9. Empty line
  lines.push("");

  // 10. Transcript header
  lines.push("Transcript (ms from the start, then speaker):");

  // 11. Transcript entries
  for (const e of state.transcript) {
    const who =
      e.speaker === "student"
        ? "Student"
        : e.kind === "interjection"
          ? "Interviewer (interrupting)"
          : "Interviewer";
    lines.push(`[${e.at}] ${who}: ${normalizeText(e.text)}`);
  }

  // 12. Empty line
  lines.push("");

  // 13. Return instructions (5 lines)
  lines.push("Return a JSON object with:");
  lines.push("- summary: 2-3 sentences on the overall performance.");
  lines.push("- criteria: one entry per rubric criterion, with its id, the chosen score, and a one-sentence justification that cites what the student said or did.");
  lines.push("- strengths: up to 3 short points.");
  lines.push("- improvements: up to 3 short, actionable points.");
  lines.push("- keyMoments: up to 3 moments from the student's lines, each with the exact \"at\" value of that line, a short exact quote from it, and a note.");

  return [
    { role: "system", content: feedbackSystemPrompt(config.subject) },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * Convert a Report to a FeedbackView, validating against the config's rubric.
 */
export function toFeedbackView(
  config: InterviewConfig,
  state: EngineState,
  report: Report
): FeedbackView {
  // V1: summary must be non-empty after trim
  const summary = report.summary.trim();
  if (summary === "") {
    throw new FeedbackInvalidError("Empty summary");
  }

  // V2: criteria count must match
  if (report.criteria.length !== config.rubric.criteria.length) {
    throw new FeedbackInvalidError(
      `Criteria count mismatch: expected ${config.rubric.criteria.length}, got ${report.criteria.length}`
    );
  }

  // V3: validate each criterion in config order
  const criteria: FeedbackView["criteria"] = [];
  for (const c of config.rubric.criteria) {
    const found = report.criteria.filter((x) => x.id === c.id);
    if (found.length !== 1) {
      throw new FeedbackInvalidError(
        `Criterion ${c.id} not found exactly once (found ${found.length})`
      );
    }

    const reportEntry = found[0];
    const level = c.levels.find((l) => l.score === reportEntry.score);
    if (!level) {
      throw new FeedbackInvalidError(
        `Criterion ${c.id}: score ${reportEntry.score} not found in rubric levels`
      );
    }

    const maxScore = Math.max(...c.levels.map((l) => l.score));
    criteria.push({
      id: c.id,
      name: c.name,
      score: level.score,
      maxScore,
      descriptor: level.descriptor,
      justification: reportEntry.justification.trim(),
    });
  }

  // V4: strengths and improvements: trim, drop empty, keep first 5
  const strengths = report.strengths
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .slice(0, 5);

  const improvements = report.improvements
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .slice(0, 5);

  // V5: keyMoments validation
  const validMoments: { at: number; quote: string; note: string }[] = [];
  for (const m of report.keyMoments) {
    const normalizedQuote = normalizeText(m.quote);
    if (normalizedQuote === "") continue;
    if (m.note.trim() === "") continue;

    // Check if some student entry matches
    const matches = state.transcript.some(
      (e) =>
        e.speaker === "student" &&
        e.at === m.at &&
        normalizeText(e.text).includes(normalizedQuote)
    );
    if (!matches) continue;

    validMoments.push({
      at: m.at,
      quote: normalizedQuote,
      note: m.note.trim(),
    });
  }

  // Sort by at ascending, keep first 5
  validMoments.sort((a, b) => a.at - b.at);
  const keyMoments = validMoments.slice(0, 5);

  // V6: return without modelLabel
  return { summary, criteria, strengths, improvements, keyMoments };
}

/**
 * Generate a feedback view when there's no answer.
 */
export function noAnswerView(config: InterviewConfig): FeedbackView {
  const criteria = config.rubric.criteria.map((c) => {
    // Find the lowest-score level
    const sorted = [...c.levels].sort((a, b) => a.score - b.score);
    const lowest = sorted[0];
    const maxScore = Math.max(...c.levels.map((l) => l.score));
    return {
      id: c.id,
      name: c.name,
      score: lowest.score,
      maxScore,
      descriptor: lowest.descriptor,
      justification: "No answer was given.",
    };
  });

  return {
    summary:
      "You didn't answer any questions in this interview, so there's nothing to score yet. Try again and talk through your thinking out loud.",
    criteria,
    strengths: [],
    improvements: [
      "Answer out loud, even when you're unsure: the interviewer can only help with what they hear.",
    ],
    keyMoments: [],
  };
}

/**
 * Generate a report by calling the model.
 */
export async function generateReport(args: {
  config: InterviewConfig;
  style: Style;
  state: EngineState;
  signal?: AbortSignal;
  client?: OpenAI;
}): Promise<Report> {
  const { config, style, state, signal, client } = args;

  const result = await chatJSON({
    schema: ReportSchema,
    schemaName: "Report",
    messages: buildFeedbackMessages(config, style, state),
    timeoutMs: FEEDBACK_TIMEOUT_MS,
    retry: false,
    signal,
    client,
  });

  return result.data;
}
