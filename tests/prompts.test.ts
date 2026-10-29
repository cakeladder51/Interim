import { describe, it, expect } from "vitest";
import {
  formatTranscript,
  buildAssessMessages,
  buildSpeakMessages,
  fallbackUtterance,
} from "../src/engine/prompts";
import { getConfig, getStyle } from "../src/config/load";
import type { EngineState, TranscriptEntry } from "@/contracts";
import type { SpeakReason } from "../src/engine/types";

const mathsConfig = getConfig("maths-oxbridge");
// csConfig loaded for potential future use
const _csConfig = getConfig("cs-oxbridge");
void _csConfig;

function makeState(overrides?: Partial<EngineState>): EngineState {
  return {
    version: 1,
    configId: mathsConfig.id,
    styleId: mathsConfig.styles[0].id,
    startedAt: 1000,
    phase: "problem",
    problemIdx: 0,
    hintRung: -1,
    checkpointsHit: [],
    lastInterjectAt: null,
    turnWordBaseline: 0,
    probesAsked: 0,
    transcript: [],
    ...overrides,
  };
}

function makeTranscript(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${i}`,
    at: i * 1000,
    speaker: i % 2 === 0 ? ("interviewer" as const) : ("student" as const),
    kind: "utterance" as const,
    text: `Entry ${i} content here`,
  }));
}

describe("formatTranscript", () => {
  it("returns placeholder when empty", () => {
    expect(formatTranscript([], 12)).toBe("(no earlier conversation)");
  });

  it("takes the last max entries, oldest first", () => {
    const entries: TranscriptEntry[] = [
      { id: "1", at: 0, speaker: "interviewer", kind: "utterance", text: "First" },
      { id: "2", at: 1, speaker: "student", kind: "utterance", text: "Second" },
      { id: "3", at: 2, speaker: "interviewer", kind: "utterance", text: "Third" },
    ];
    const result = formatTranscript(entries, 2);
    expect(result).toBe("[Student] Second\n[Interviewer] Third");
  });

  it("truncates text longer than 600 chars", () => {
    const longText = "a".repeat(700);
    const entries: TranscriptEntry[] = [
      { id: "1", at: 0, speaker: "student", kind: "utterance", text: longText },
    ];
    const result = formatTranscript(entries, 12);
    expect(result).toBe(`[Student] ${"a".repeat(600)}…`);
  });
});

describe("buildAssessMessages", () => {
  it("system message for problem index 1 with no checkpoints hit", () => {
    // Using maths-oxbridge problemIdx 1 (sum-of-odds)
    const state = makeState({ problemIdx: 1, checkpointsHit: [] });
    const messages = buildAssessMessages({
      config: mathsConfig,
      state,
      event: { type: "partial", text: "testing" },
    });

    const problem = mathsConfig.problems[1];
    const checkpointLines = problem.checkpoints
      .map((c) => `- ${c.id}: ${c.description}`)
      .join("\n");
    const misconceptionLines = problem.misconceptions
      .map((m) => `- ${m.id}: ${m.signal}`)
      .join("\n");

    const expectedSystem = `You are the silent assessor in a live Mathematics admissions interview. You never speak to the student. Judge the student's reasoning on the current problem and reply with JSON only.

Problem: ${problem.statement}
Model solution (for your judgement only): ${problem.solutionSketch}

Checkpoints (use these ids):
${checkpointLines}
Already achieved: none

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
- evidence: one short sentence quoting or paraphrasing what supports your judgement.`;

    expect(messages[0]).toEqual({ role: "system", content: expectedSystem });
  });

  it("system message for problem index 1 with checkpoints c1 and c2 hit", () => {
    const state = makeState({ problemIdx: 1, checkpointsHit: ["c1", "c2"] });
    const messages = buildAssessMessages({
      config: mathsConfig,
      state,
      event: { type: "partial", text: "testing" },
    });

    const problem = mathsConfig.problems[1];
    const checkpointLines = problem.checkpoints
      .map((c) => `- ${c.id}: ${c.description}`)
      .join("\n");
    const misconceptionLines = problem.misconceptions
      .map((m) => `- ${m.id}: ${m.signal}`)
      .join("\n");

    const expectedSystem = `You are the silent assessor in a live Mathematics admissions interview. You never speak to the student. Judge the student's reasoning on the current problem and reply with JSON only.

Problem: ${problem.statement}
Model solution (for your judgement only): ${problem.solutionSketch}

Checkpoints (use these ids):
${checkpointLines}
Already achieved: c1, c2

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
- evidence: one short sentence quoting or paraphrasing what supports your judgement.`;

    expect(messages[0]).toEqual({ role: "system", content: expectedSystem });
  });

  // R1: Assess user message tests with 13-entry transcript (12-entry window)

  it("user message for partial event uses formatTranscript with 12 entries", () => {
    // 13 entries so that the 12-entry window is visible (entry-0 should be absent)
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });

    const messages = buildAssessMessages({
      config: mathsConfig,
      state,
      event: { type: "partial", text: "so the nth odd number is 2n plus 1" },
    });

    const expectedTranscript = formatTranscript(transcript13, 12);

    const expectedUser = `Conversation so far (oldest first):
${expectedTranscript}

The student is still speaking. Their words so far: "so the nth odd number is 2n plus 1". Judge only what they have said; an unfinished sentence is not an error.`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
    expect(typeof (messages[1] as { content: unknown }).content).toBe("string");
  });

  it("user message for turn_complete event uses formatTranscript with 12 entries", () => {
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });

    const messages = buildAssessMessages({
      config: mathsConfig,
      state,
      event: { type: "turn_complete", text: "that is my answer", source: "voice" },
    });

    const expectedTranscript = formatTranscript(transcript13, 12);

    const expectedUser = `Conversation so far (oldest first):
${expectedTranscript}

The student has just finished speaking: "that is my answer"`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
    expect(typeof (messages[1] as { content: unknown }).content).toBe("string");
  });

  it("user message for canvas event has image_url part with correct url", () => {
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });

    const messages = buildAssessMessages({
      config: mathsConfig,
      state,
      event: { type: "canvas", image: "data:image/png;base64,AAAA" },
    });

    const expectedTranscript = formatTranscript(transcript13, 12);

    const expectedText = `Conversation so far (oldest first):
${expectedTranscript}

The attached image is the student's whiteboard working. Judge it together with what they have said.`;

    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: expectedText },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });
});

describe("buildSpeakMessages", () => {
  const rigorous = getStyle(mathsConfig, "rigorous");

  it("system message for rigorous style without interrupt", () => {
    const state = makeState({ problemIdx: 1 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: rigorous,
      state,
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
    });

    const expectedSystem = `You are the interviewer in a live Mathematics admissions interview, speaking out loud to a student. Your words are turned into speech.
Persona: ${rigorous.persona}
Tone: ${rigorous.tone}

Rules:
- Say only the words you speak aloud: no stage directions, markdown, lists, emoji or LaTeX. Phrase maths so it reads naturally aloud.
- Never give away the solution, and never say whether later steps are right before the student reaches them.
- Keep it to at most three sentences, plus the problem statement if the guidance asks you to read one.
- Follow the guidance below. Rephrase it naturally in your persona but keep its meaning, and do not add extra hints.`;

    expect(messages[0]).toEqual({ role: "system", content: expectedSystem });
  });

  it("system message for rigorous style with interrupt", () => {
    const state = makeState({ problemIdx: 1 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: rigorous,
      state,
      move: { type: "realign", misconceptionId: null },
      interrupt: true,
      reason: "interject_off_track",
      studentText: null,
    });

    const expectedSystem = `You are the interviewer in a live Mathematics admissions interview, speaking out loud to a student. Your words are turned into speech.
Persona: ${rigorous.persona}
Tone: ${rigorous.tone}

Rules:
- Say only the words you speak aloud: no stage directions, markdown, lists, emoji or LaTeX. Phrase maths so it reads naturally aloud.
- Never give away the solution, and never say whether later steps are right before the student reaches them.
- You are interrupting the student mid-answer. Say one sentence of at most 25 words, opening with a brief natural interjection such as "Sorry to jump in".
- Follow the guidance below. Rephrase it naturally in your persona but keep its meaning, and do not add extra hints.`;

    expect(messages[0]).toEqual({ role: "system", content: expectedSystem });
  });

  // All 12 grounding rows with literal expected user messages
  // Use problemIdx: 1, non-zero indices (hint rung 2, probeIdx 1, second misconception)
  // Transcript with 7 entries so "last 6" is visible

  const transcript7 = makeTranscript(7);
  const recent6 = formatTranscript(transcript7, 6);

  it("user message for grounding row: intro", () => {
    const state = makeState({ problemIdx: 0 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "intro" },
      interrupt: false,
      reason: "intro",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
Greet the student, introduce yourself in one short sentence, then present the first problem. Read the problem statement exactly as written: "${mathsConfig.problems[0].statement}"

Recent conversation (oldest first):
(no earlier conversation)`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: hint{rung: 2}", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "hint", rung: 2 },
      interrupt: false,
      reason: "stuck",
      studentText: null,
    });

    const problem = mathsConfig.problems[1];
    const expectedUser = `Guidance for what to say now:
The student needs a hint. Give this hint: "${problem.hintLadder[2]}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: realign with known misconception (second one)", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    // Second misconception of problem 1
    const miscId = mathsConfig.problems[1].misconceptions[1].id;
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "realign", misconceptionId: miscId },
      interrupt: false,
      reason: "off_track",
      studentText: null,
    });

    const problem = mathsConfig.problems[1];
    const misc = problem.misconceptions[1];
    const expectedUser = `Guidance for what to say now:
The student's reasoning is going wrong. Steer them back with this: "${misc.realign}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: realign{misconceptionId: null}", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "realign", misconceptionId: null },
      interrupt: false,
      reason: "off_track",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The student's reasoning seems to be going wrong. Without saying what the error is, ask them to double-check their current step.

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: probe{probeIdx: 1}", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "probe", probeIdx: 1 },
      interrupt: false,
      reason: "solved_probe",
      studentText: null,
    });

    const problem = mathsConfig.problems[1];
    const expectedUser = `Guidance for what to say now:
The student has solved the problem. Acknowledge that briefly, then ask this follow-up question: "${problem.probes[1]}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: acknowledge assessor_unavailable", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "assessor_unavailable",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
Say this: "${mathsConfig.fallbackPrompt}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: acknowledge closing", () => {
    const state = makeState({ problemIdx: 0, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "closing",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The interview is over. Thank the student briefly for their final remarks.

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: acknowledge other reason", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The student is making progress. Briefly encourage them to keep going, or ask them to explain their last step in more detail. Do not give new information.

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: advance solved_advance", () => {
    const state = makeState({ problemIdx: 0, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "advance", toProblemIdx: 1 },
      interrupt: false,
      reason: "solved_advance",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The student has finished this problem. Say well done briefly, then present the next problem. Read the statement exactly as written: "${mathsConfig.problems[1].statement}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: advance other reason", () => {
    const state = makeState({ problemIdx: 0, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "advance", toProblemIdx: 1 },
      interrupt: false,
      reason: "hints_exhausted_advance",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The student hasn't been able to finish this problem. Without revealing the answer, kindly say you'll move on, then present the next problem. Read the statement exactly as written: "${mathsConfig.problems[1].statement}"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: wrap_up time_up", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "wrap_up" },
      interrupt: false,
      reason: "time_up",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
Time is up. Thank the student, and tell them the interview is over and their feedback is being prepared.

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("user message for grounding row: wrap_up other reason", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "wrap_up" },
      interrupt: false,
      reason: "end",
      studentText: null,
    });

    const expectedUser = `Guidance for what to say now:
The interview is over. Thank the student and tell them their feedback is being prepared.

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  // StudentText present
  it("user message includes studentText when non-null", () => {
    const state = makeState({ problemIdx: 1, transcript: transcript7 });
    const messages = buildSpeakMessages({
      config: mathsConfig,
      style: mathsConfig.styles[0],
      state,
      move: { type: "acknowledge" },
      interrupt: false,
      reason: "progress",
      studentText: "So I think the answer is n squared",
    });

    const expectedUser = `Guidance for what to say now:
The student is making progress. Briefly encourage them to keep going, or ask them to explain their last step in more detail. Do not give new information.

What the student just said: "So I think the answer is n squared"

Recent conversation (oldest first):
${recent6}`;

    expect(messages[1]).toEqual({ role: "user", content: expectedUser });
  });

  it("no speak message ever contains solutionSketch", () => {
    const state = makeState({ problemIdx: 1 });
    // Test all move types
    const moves: Array<{ type: string; rung?: number; misconceptionId?: string | null; probeIdx?: number; toProblemIdx?: number }> = [
      { type: "intro" },
      { type: "hint", rung: 2 },
      { type: "realign", misconceptionId: null },
      { type: "realign", misconceptionId: mathsConfig.problems[1].misconceptions[1].id },
      { type: "probe", probeIdx: 1 },
      { type: "acknowledge" },
      { type: "advance", toProblemIdx: 1 },
      { type: "wrap_up" },
    ];

    const reasons: SpeakReason[] = [
      "intro",
      "stuck",
      "off_track",
      "assessor_unavailable",
      "closing",
      "progress",
      "solved_advance",
      "hints_exhausted_advance",
      "solved_probe",
      "time_up",
      "end",
    ];

    for (const move of moves) {
      for (const reason of reasons) {
        const messages = buildSpeakMessages({
          config: mathsConfig,
          style: mathsConfig.styles[0],
          state,
          move: move as never,
          interrupt: false,
          reason,
          studentText: null,
        });

        const allContent = messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join(" ");

        expect(
          allContent,
          `move ${move.type} reason ${reason} should not contain solutionSketch`
        ).not.toContain(mathsConfig.problems[1].solutionSketch);
      }
    }
  });
});

describe("fallbackUtterance", () => {
  // All 12 rows with literal expected strings, non-zero indices

  it("fallback row: intro", () => {
    const state = makeState({ problemIdx: 0 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "intro" },
      reason: "intro",
    });
    expect(result).toBe(`Hello, I'm your interviewer today. Here's the first problem. ${mathsConfig.problems[0].statement}`);
  });

  it("fallback row: hint{rung: 2}", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "hint", rung: 2 },
      reason: "stuck",
    });
    expect(result).toBe(mathsConfig.problems[1].hintLadder[2]);
  });

  it("fallback row: realign with known misconception (second)", () => {
    const state = makeState({ problemIdx: 1 });
    const miscId = mathsConfig.problems[1].misconceptions[1].id;
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "realign", misconceptionId: miscId },
      reason: "off_track",
    });
    expect(result).toBe(mathsConfig.problems[1].misconceptions[1].realign);
  });

  it("fallback row: realign{misconceptionId: null}", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "realign", misconceptionId: null },
      reason: "off_track",
    });
    expect(result).toBe(mathsConfig.fallbackPrompt);
  });

  it("fallback row: probe{probeIdx: 1}", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "probe", probeIdx: 1 },
      reason: "solved_probe",
    });
    expect(result).toBe(`Well done. ${mathsConfig.problems[1].probes[1]}`);
  });

  it("fallback row: acknowledge assessor_unavailable", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "acknowledge" },
      reason: "assessor_unavailable",
    });
    expect(result).toBe(mathsConfig.fallbackPrompt);
  });

  it("fallback row: acknowledge closing", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "acknowledge" },
      reason: "closing",
    });
    expect(result).toBe("Thank you.");
  });

  it("fallback row: acknowledge other reason", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "acknowledge" },
      reason: "progress",
    });
    expect(result).toBe("Good. Keep going and talk me through your next step.");
  });

  it("fallback row: advance solved_advance", () => {
    const state = makeState({ problemIdx: 0 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "advance", toProblemIdx: 1 },
      reason: "solved_advance",
    });
    expect(result).toBe(`Well done. Let's move on to the next problem. ${mathsConfig.problems[1].statement}`);
  });

  it("fallback row: advance other reason", () => {
    const state = makeState({ problemIdx: 0 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "advance", toProblemIdx: 1 },
      reason: "hints_exhausted_advance",
    });
    expect(result).toBe(`Let's move on to the next problem. ${mathsConfig.problems[1].statement}`);
  });

  it("fallback row: wrap_up time_up", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "wrap_up" },
      reason: "time_up",
    });
    expect(result).toBe("We're out of time. Thank you, that's the end of the interview. Your feedback is being prepared.");
  });

  it("fallback row: wrap_up other reason", () => {
    const state = makeState({ problemIdx: 1 });
    const result = fallbackUtterance({
      config: mathsConfig,
      state,
      move: { type: "wrap_up" },
      reason: "end",
    });
    expect(result).toBe("Thank you, that's the end of the interview. Your feedback is being prepared.");
  });
});

// R2: Purity tests

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === "object" && val !== null && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

describe("prompts purity", () => {
  it("buildAssessMessages does not mutate inputs for partial event", () => {
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });
    const frozenState = deepFreeze(structuredClone(state));
    const frozenConfig = deepFreeze(structuredClone(mathsConfig));
    const snapshotState = structuredClone(frozenState);
    const snapshotConfig = structuredClone(frozenConfig);

    expect(() =>
      buildAssessMessages({
        config: frozenConfig,
        state: frozenState,
        event: { type: "partial", text: "test partial" },
      })
    ).not.toThrow();

    expect(frozenState).toEqual(snapshotState);
    expect(frozenConfig).toEqual(snapshotConfig);
  });

  it("buildAssessMessages does not mutate inputs for turn_complete event", () => {
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });
    const frozenState = deepFreeze(structuredClone(state));
    const frozenConfig = deepFreeze(structuredClone(mathsConfig));
    const snapshotState = structuredClone(frozenState);
    const snapshotConfig = structuredClone(frozenConfig);

    expect(() =>
      buildAssessMessages({
        config: frozenConfig,
        state: frozenState,
        event: { type: "turn_complete", text: "test answer", source: "voice" },
      })
    ).not.toThrow();

    expect(frozenState).toEqual(snapshotState);
    expect(frozenConfig).toEqual(snapshotConfig);
  });

  it("buildAssessMessages does not mutate inputs for canvas event", () => {
    const transcript13 = makeTranscript(13);
    const state = makeState({ problemIdx: 1, transcript: transcript13 });
    const frozenState = deepFreeze(structuredClone(state));
    const frozenConfig = deepFreeze(structuredClone(mathsConfig));
    const snapshotState = structuredClone(frozenState);
    const snapshotConfig = structuredClone(frozenConfig);

    expect(() =>
      buildAssessMessages({
        config: frozenConfig,
        state: frozenState,
        event: { type: "canvas", image: "data:image/png;base64,TEST" },
      })
    ).not.toThrow();

    expect(frozenState).toEqual(snapshotState);
    expect(frozenConfig).toEqual(snapshotConfig);
  });

  it("buildSpeakMessages does not mutate inputs for every grounding row", () => {
    const transcript7 = makeTranscript(7);

    const groundingCases: Array<{
      name: string;
      move: Parameters<typeof buildSpeakMessages>[0]["move"];
      reason: SpeakReason;
    }> = [
      { name: "intro", move: { type: "intro" }, reason: "intro" },
      { name: "hint", move: { type: "hint", rung: 2 }, reason: "stuck" },
      { name: "realign-known", move: { type: "realign", misconceptionId: mathsConfig.problems[1].misconceptions[1].id }, reason: "off_track" },
      { name: "realign-null", move: { type: "realign", misconceptionId: null }, reason: "off_track" },
      { name: "probe", move: { type: "probe", probeIdx: 1 }, reason: "solved_probe" },
      { name: "ack-assessor", move: { type: "acknowledge" }, reason: "assessor_unavailable" },
      { name: "ack-closing", move: { type: "acknowledge" }, reason: "closing" },
      { name: "ack-progress", move: { type: "acknowledge" }, reason: "progress" },
      { name: "advance-solved", move: { type: "advance", toProblemIdx: 1 }, reason: "solved_advance" },
      { name: "advance-hints", move: { type: "advance", toProblemIdx: 1 }, reason: "hints_exhausted_advance" },
      { name: "wrap-up-time", move: { type: "wrap_up" }, reason: "time_up" },
      { name: "wrap-up-end", move: { type: "wrap_up" }, reason: "end" },
    ];

    for (const { move, reason } of groundingCases) {
      const state = makeState({ problemIdx: 1, transcript: transcript7 });
      const frozenState = deepFreeze(structuredClone(state));
      const frozenConfig = deepFreeze(structuredClone(mathsConfig));
      const frozenStyle = deepFreeze(structuredClone(mathsConfig.styles[0]));
      const snapshotState = structuredClone(frozenState);
      const snapshotConfig = structuredClone(frozenConfig);
      const snapshotStyle = structuredClone(frozenStyle);

      expect(() =>
        buildSpeakMessages({
          config: frozenConfig,
          style: frozenStyle,
          state: frozenState,
          move,
          interrupt: false,
          reason,
          studentText: null,
        })
      ).not.toThrow();

      expect(frozenState).toEqual(snapshotState);
      expect(frozenConfig).toEqual(snapshotConfig);
      expect(frozenStyle).toEqual(snapshotStyle);
    }
  });

  it("fallbackUtterance does not mutate inputs for every row", () => {
    const fallbackCases: Array<{
      name: string;
      move: Parameters<typeof fallbackUtterance>[0]["move"];
      reason: SpeakReason;
    }> = [
      { name: "intro", move: { type: "intro" }, reason: "intro" },
      { name: "hint", move: { type: "hint", rung: 2 }, reason: "stuck" },
      { name: "realign-known", move: { type: "realign", misconceptionId: mathsConfig.problems[1].misconceptions[1].id }, reason: "off_track" },
      { name: "realign-null", move: { type: "realign", misconceptionId: null }, reason: "off_track" },
      { name: "probe", move: { type: "probe", probeIdx: 1 }, reason: "solved_probe" },
      { name: "ack-assessor", move: { type: "acknowledge" }, reason: "assessor_unavailable" },
      { name: "ack-closing", move: { type: "acknowledge" }, reason: "closing" },
      { name: "ack-progress", move: { type: "acknowledge" }, reason: "progress" },
      { name: "advance-solved", move: { type: "advance", toProblemIdx: 1 }, reason: "solved_advance" },
      { name: "advance-hints", move: { type: "advance", toProblemIdx: 1 }, reason: "hints_exhausted_advance" },
      { name: "wrap-up-time", move: { type: "wrap_up" }, reason: "time_up" },
      { name: "wrap-up-end", move: { type: "wrap_up" }, reason: "end" },
    ];

    for (const { move, reason } of fallbackCases) {
      const state = makeState({ problemIdx: 1 });
      const frozenState = deepFreeze(structuredClone(state));
      const frozenConfig = deepFreeze(structuredClone(mathsConfig));
      const snapshotState = structuredClone(frozenState);
      const snapshotConfig = structuredClone(frozenConfig);

      expect(() =>
        fallbackUtterance({
          config: frozenConfig,
          state: frozenState,
          move,
          reason,
        })
      ).not.toThrow();

      expect(frozenState).toEqual(snapshotState);
      expect(frozenConfig).toEqual(snapshotConfig);
    }
  });
});
