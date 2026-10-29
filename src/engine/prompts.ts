import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
  InterviewConfig,
  EngineState,
  EngineEvent,
  TranscriptEntry,
  Move,
} from "@/contracts";
import type { SpeakReason } from "./types";

const MAX_TRANSCRIPT_CHAR = 600;

/**
 * Format transcript entries for display in prompts.
 * Takes the last `max` entries, oldest first.
 */
export function formatTranscript(entries: TranscriptEntry[], max: number): string {
  if (entries.length === 0) {
    return "(no earlier conversation)";
  }
  const slice = entries.slice(-max);
  const lines = slice.map((entry) => {
    const speaker = entry.speaker === "interviewer" ? "Interviewer" : "Student";
    let text = entry.text;
    if (text.length > MAX_TRANSCRIPT_CHAR) {
      text = text.slice(0, MAX_TRANSCRIPT_CHAR) + "…";
    }
    return `[${speaker}] ${text}`;
  });
  return lines.join("\n");
}

/**
 * Build messages for the assessor model.
 * `event` is a partial, turn_complete, or canvas event.
 * `state` is the state BEFORE the student's current turn is appended.
 */
export function buildAssessMessages({
  config,
  state,
  event,
}: {
  config: InterviewConfig;
  state: EngineState;
  event: Extract<EngineEvent, { type: "partial" | "turn_complete" | "canvas" }>;
}): ChatCompletionMessageParam[] {
  const problem = config.problems[state.problemIdx];
  const checkpointLines = problem.checkpoints
    .map((c) => `- ${c.id}: ${c.description}`)
    .join("\n");
  const misconceptionLines = problem.misconceptions
    .map((m) => `- ${m.id}: ${m.signal}`)
    .join("\n");
  const alreadyAchieved =
    state.checkpointsHit.length > 0
      ? state.checkpointsHit.join(", ")
      : "none";

  const systemMessage: ChatCompletionMessageParam = {
    role: "system",
    content: `You are the silent assessor in a live ${config.subject} admissions interview. You never speak to the student. Judge the student's reasoning on the current problem and reply with JSON only.

Problem: ${problem.statement}
Model solution (for your judgement only): ${problem.solutionSketch}

Checkpoints (use these ids):
${checkpointLines}
Already achieved: ${alreadyAchieved}

Known misconceptions (use these ids):
${misconceptionLines}

Status meanings:
- "stuck": not making progress; says they don't know, stalls, or repeats themselves.
- "progressing": sound reasoning heading towards the next checkpoint, not there yet.
- "partial": some correct ideas, but incomplete or imprecise.
- "correct": the step they are on is right.
- "off_track": an approach that will not work, a reasoning error, or one of the known misconceptions.

Rules:
- checkpointsHit: only ids the student has clearly demonstrated, in this answer or earlier. Never guess.
- misconceptionId: a known misconception id only if it clearly matches, otherwise null.
- confidence: 0 to 1. Use 0.8 or more only when the evidence is unambiguous.
- evidence: one short sentence quoting or paraphrasing what supports your judgement.`,
  };

  let eventLine: string;
  let userContent: string | ChatCompletionMessageParam["content"];

  if (event.type === "partial") {
    eventLine = `The student is still speaking. Their words so far: "${event.text}". Judge only what they have said; an unfinished sentence is not an error.`;
  } else if (event.type === "turn_complete") {
    eventLine = `The student has just finished speaking: "${event.text}"`;
  } else {
    // canvas
    eventLine = `The attached image is the student's whiteboard working. Judge it together with what they have said.`;
  }

  const transcriptPart = formatTranscript(state.transcript, 12);

  if (event.type === "canvas") {
    // For canvas, content is an array with text and image
    userContent = [
      {
        type: "text",
        text: `Conversation so far (oldest first):
${transcriptPart}

${eventLine}`,
      },
      {
        type: "image_url",
        image_url: {
          url: event.image,
        },
      },
    ];
  } else {
    userContent = `Conversation so far (oldest first):
${transcriptPart}

${eventLine}`;
  }

  const userMessage: ChatCompletionMessageParam = {
    role: "user",
    content: userContent,
  };

  return [systemMessage, userMessage];
}

/**
 * Build messages for the speaker model.
 * `state` is the state AFTER decide (or the initial state for intro).
 * `move` is any non-silent move.
 */
export function buildSpeakMessages({
  config,
  style,
  state,
  move,
  interrupt,
  reason,
  studentText,
}: {
  config: InterviewConfig;
  style: { id: string; label: string; persona: string; tone: string };
  state: EngineState;
  move: Exclude<Move, { type: "silent" }>;
  interrupt: boolean;
  reason: SpeakReason;
  studentText: string | null;
}): ChatCompletionMessageParam[] {
  const lengthRule = interrupt
    ? "You are interrupting the student mid-answer. Say one sentence of at most 25 words, opening with a brief natural interjection such as \"Sorry to jump in\"."
    : "Keep it to at most three sentences, plus the problem statement if the guidance asks you to read one.";

  const systemMessage: ChatCompletionMessageParam = {
    role: "system",
    content: `You are the interviewer in a live ${config.subject} admissions interview, speaking out loud to a student. Your words are turned into speech.
Persona: ${style.persona}
Tone: ${style.tone}

Rules:
- Say only the words you speak aloud: no stage directions, markdown, lists, emoji or LaTeX. Phrase maths so it reads naturally aloud.
- Never give away the solution, and never say whether later steps are right before the student reaches them.
- ${lengthRule}
- Follow the guidance below. Rephrase it naturally in your persona but keep its meaning, and do not add extra hints.`,
  };

  const grounding = buildGrounding(config, state, move, reason);
  const transcriptPart = formatTranscript(state.transcript, 6);
  const studentTextPart =
    studentText !== null ? `What the student just said: "${studentText}"\n\n` : "";

  const userMessage: ChatCompletionMessageParam = {
    role: "user",
    content: `Guidance for what to say now:
${grounding}

${studentTextPart}Recent conversation (oldest first):
${transcriptPart}`,
  };

  return [systemMessage, userMessage];
}

/**
 * Build the grounding text for a given move/reason.
 * The speaker MUST never see solutionSketch.
 */
function buildGrounding(
  config: InterviewConfig,
  state: EngineState,
  move: Exclude<Move, { type: "silent" }>,
  reason: SpeakReason
): string {
  // Note: We don't access problem.solutionSketch here - speaker never sees it
  
  if (move.type === "intro") {
    return `Greet the student, introduce yourself in one short sentence, then present the first problem. Read the problem statement exactly as written: "${config.problems[0].statement}"`;
  }

  const problem = config.problems[state.problemIdx];

  if (move.type === "hint") {
    return `The student needs a hint. Give this hint: "${problem.hintLadder[move.rung]}"`;
  }

  if (move.type === "realign") {
    if (move.misconceptionId !== null) {
      const misconc = problem.misconceptions.find(
        (m) => m.id === move.misconceptionId
      );
      if (misconc) {
        return `The student's reasoning is going wrong. Steer them back with this: "${misconc.realign}"`;
      }
      // Fallback if misconceptionId not found (shouldn't happen)
      return `The student's reasoning seems to be going wrong. Without saying what the error is, ask them to double-check their current step.`;
    }
    return `The student's reasoning seems to be going wrong. Without saying what the error is, ask them to double-check their current step.`;
  }

  if (move.type === "probe") {
    return `The student has solved the problem. Acknowledge that briefly, then ask this follow-up question: "${problem.probes[move.probeIdx]}"`;
  }

  if (move.type === "acknowledge") {
    if (reason === "assessor_unavailable") {
      return `Say this: "${config.fallbackPrompt}"`;
    }
    if (reason === "closing") {
      return `The interview is over. Thank the student briefly for their final remarks.`;
    }
    return `The student is making progress. Briefly encourage them to keep going, or ask them to explain their last step in more detail. Do not give new information.`;
  }

  if (move.type === "advance") {
    const nextProblem = config.problems[move.toProblemIdx];
    if (reason === "solved_advance") {
      return `The student has finished this problem. Say well done briefly, then present the next problem. Read the statement exactly as written: "${nextProblem.statement}"`;
    }
    return `The student hasn't been able to finish this problem. Without revealing the answer, kindly say you'll move on, then present the next problem. Read the statement exactly as written: "${nextProblem.statement}"`;
  }

  if (move.type === "wrap_up") {
    if (reason === "time_up") {
      return `Time is up. Thank the student, and tell them the interview is over and their feedback is being prepared.`;
    }
    return `The interview is over. Thank the student and tell them their feedback is being prepared.`;
  }

  // Exhaustive check
  void move;
  return "";
}

/**
 * Deterministic fallback utterance when the speaker model fails.
 */
export function fallbackUtterance({
  config,
  state,
  move,
  reason,
}: {
  config: InterviewConfig;
  state: EngineState;
  move: Exclude<Move, { type: "silent" }>;
  reason: SpeakReason;
}): string {
  if (move.type === "intro") {
    return `Hello, I'm your interviewer today. Here's the first problem. ${config.problems[0].statement}`;
  }

  const problem = config.problems[state.problemIdx];

  if (move.type === "hint") {
    return problem.hintLadder[move.rung];
  }

  if (move.type === "realign") {
    if (move.misconceptionId !== null) {
      const misconc = problem.misconceptions.find(
        (m) => m.id === move.misconceptionId
      );
      if (misconc) {
        return misconc.realign;
      }
    }
    return config.fallbackPrompt;
  }

  if (move.type === "probe") {
    return `Well done. ${problem.probes[move.probeIdx]}`;
  }

  if (move.type === "acknowledge") {
    if (reason === "assessor_unavailable") {
      return config.fallbackPrompt;
    }
    if (reason === "closing") {
      return "Thank you.";
    }
    return "Good. Keep going and talk me through your next step.";
  }

  if (move.type === "advance") {
    const nextProblem = config.problems[move.toProblemIdx];
    if (reason === "solved_advance") {
      return `Well done. Let's move on to the next problem. ${nextProblem.statement}`;
    }
    return `Let's move on to the next problem. ${nextProblem.statement}`;
  }

  if (move.type === "wrap_up") {
    if (reason === "time_up") {
      return "We're out of time. Thank you, that's the end of the interview. Your feedback is being prepared.";
    }
    return "Thank you, that's the end of the interview. Your feedback is being prepared.";
  }

  // Exhaustive check (should never reach here for 'silent' since it's excluded)
  void move;
  return config.fallbackPrompt;
}
