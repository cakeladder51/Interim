// Reviewer reference for the Stage 9 brief (feedback). Prints the brief's vectors. Never hand this to the builder.
//   node agent-os/review/stage-09-ref.mjs
import { readFileSync } from "node:fs";

export class FeedbackInvalidError extends Error {}
export const norm = (s) => s.trim().split(/\s+/).filter(Boolean).join(" ");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export const FEEDBACK_SYSTEM_PROMPT = (subject) =>
  `You are an experienced Oxbridge admissions interviewer writing feedback for a student after a practice interview in ${subject}. ` +
  `Score the student against the rubric using only what the transcript shows. ` +
  `Be specific and kind, address the student as "you", and never invent anything the student didn't say. Reply with JSON only.`;

export function buildFeedbackMessages(config, style, state) {
  const lines = [];
  lines.push(`Interview: ${config.title}`);
  lines.push(`Interviewer style: ${style.label}`);
  lines.push("");
  lines.push("Problems:");
  config.problems.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.title}: ${p.statement}`);
    lines.push(`   Model solution (for scoring only; never quote it): ${p.solutionSketch}`);
  });
  lines.push("");
  lines.push("Rubric (give each criterion exactly one of its level scores):");
  for (const c of config.rubric.criteria) {
    lines.push(`- ${c.id} (${c.name}):`);
    for (const l of c.levels) lines.push(`  ${l.score}: ${l.descriptor}`);
  }
  lines.push("");
  lines.push("Transcript (ms from the start, then speaker):");
  for (const e of state.transcript) {
    const who = e.speaker === "student" ? "Student" : e.kind === "interjection" ? "Interviewer (interrupting)" : "Interviewer";
    lines.push(`[${e.at}] ${who}: ${norm(e.text)}`);
  }
  lines.push("");
  lines.push("Return a JSON object with:");
  lines.push("- summary: 2-3 sentences on the overall performance.");
  lines.push("- criteria: one entry per rubric criterion, with its id, the chosen score, and a one-sentence justification that cites what the student said or did.");
  lines.push("- strengths: up to 3 short points.");
  lines.push("- improvements: up to 3 short, actionable points.");
  lines.push('- keyMoments: up to 3 moments from the student\'s lines, each with the exact "at" value of that line, a short exact quote from it, and a note.');
  return [
    { role: "system", content: FEEDBACK_SYSTEM_PROMPT(config.subject) },
    { role: "user", content: lines.join("\n") },
  ];
}

export function toFeedbackView(config, state, report) {
  const summary = report.summary.trim();
  if (summary === "") throw new FeedbackInvalidError("summary");
  if (report.criteria.length !== config.rubric.criteria.length) throw new FeedbackInvalidError("criteria count");
  const criteria = config.rubric.criteria.map((c) => {
    const found = report.criteria.filter((x) => x.id === c.id);
    if (found.length !== 1) throw new FeedbackInvalidError("criterion " + c.id);
    const level = c.levels.find((l) => l.score === found[0].score);
    if (!level) throw new FeedbackInvalidError("score " + c.id);
    return {
      id: c.id,
      name: c.name,
      score: level.score,
      maxScore: Math.max(...c.levels.map((l) => l.score)),
      descriptor: level.descriptor,
      justification: found[0].justification.trim(),
    };
  });
  const clean = (xs) => xs.map((s) => s.trim()).filter((s) => s !== "").slice(0, 5);
  const students = state.transcript.filter((e) => e.speaker === "student");
  const keyMoments = report.keyMoments
    .filter((m) => norm(m.quote) !== "" && m.note.trim() !== "" && students.some((e) => e.at === m.at && norm(e.text).includes(norm(m.quote))))
    .map((m) => ({ at: m.at, quote: norm(m.quote), note: m.note.trim() }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  return { summary, criteria, strengths: clean(report.strengths), improvements: clean(report.improvements), keyMoments };
}

export function noAnswerView(config) {
  return {
    summary: "You didn't answer any questions in this interview, so there's nothing to score yet. Try again and talk through your thinking out loud.",
    criteria: config.rubric.criteria.map((c) => {
      const low = [...c.levels].sort((a, b) => a.score - b.score)[0];
      return { id: c.id, name: c.name, score: low.score, maxScore: Math.max(...c.levels.map((l) => l.score)), descriptor: low.descriptor, justification: "No answer was given." };
    }),
    strengths: [],
    improvements: ["Answer out loud, even when you're unsure: the interviewer can only help with what they hear."],
    keyMoments: [],
  };
}

export function fakeReport(config, state) {
  const students = state.transcript.filter((e) => e.speaker === "student");
  const n = students.length;
  return {
    summary: `Offline practice feedback: you answered ${plural(n, "time")}.`,
    criteria: config.rubric.criteria.map((c) => {
      const sorted = [...c.levels].sort((a, b) => a.score - b.score);
      return { id: c.id, score: sorted[Math.min(sorted.length - 1, Math.floor(n / 3))].score, justification: `Offline estimate from ${plural(n, "answer")}.` };
    }),
    strengths: ["You kept going and shared your thinking."],
    improvements: ["Justify each step before moving on."],
    keyMoments: students.length ? [{ at: students[0].at, quote: norm(students[0].text).split(" ").slice(0, 8).join(" "), note: "Your first answer." }] : [],
  };
}

export const formatAt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

// ---------------- vectors ----------------
if (process.argv[1] && process.argv[1].endsWith("stage-09-ref.mjs")) {
  const maths = JSON.parse(readFileSync("configs/maths-oxbridge.json", "utf8"));
  const T = [
    { id: "e1", at: 0, speaker: "interviewer", kind: "utterance", text: "Welcome. Let's begin." },
    { id: "e2", at: 5000, speaker: "student", kind: "typed", text: "I think   the answer is\nroot two" },
    { id: "e3", at: 5000, speaker: "interviewer", kind: "utterance", text: "Why is that?" },
    { id: "e4", at: 9000, speaker: "student", kind: "typed", text: "Because it can't be a fraction." },
  ];
  const state = { transcript: T };
  const R = {
    summary: "  Good start.  ",
    criteria: [
      { id: "rigour", score: 3, justification: "Mostly right." },
      { id: "approach", score: 2, justification: " Needed a hint. " },
      { id: "responsiveness", score: 4, justification: "Quick." },
      { id: "communication", score: 1, justification: "Quiet." },
    ],
    strengths: ["Clear.", "  ", "Kept going."],
    improvements: ["i1", "i2", "i3", "i4", "i5", "i6"],
    keyMoments: [
      { at: 9000, quote: "can't be a fraction", note: "Good insight." },
      { at: 5000, quote: "the answer is  root two", note: "First idea." },
      { at: 5000, quote: "Why is that", note: "Interviewer line." },
      { at: 1234, quote: "root two", note: "Wrong time." },
      { at: 9000, quote: "   ", note: "Empty quote." },
      { at: 9000, quote: "fraction", note: "  " },
    ],
  };
  console.log("F1", JSON.stringify(toFeedbackView(maths, state, R), null, 1));
  const bad = {
    F2_missing: { ...R, criteria: R.criteria.slice(1) },
    F3_duplicate: { ...R, criteria: [...R.criteria.slice(1), { id: "approach", score: 1, justification: "x" }] },
    F4_unknown: { ...R, criteria: [...R.criteria.slice(1), { id: "creativity", score: 2, justification: "x" }] },
    F5_score5: { ...R, criteria: [{ id: "rigour", score: 5, justification: "x" }, ...R.criteria.slice(1)] },
    F6_score0: { ...R, criteria: [{ id: "rigour", score: 0, justification: "x" }, ...R.criteria.slice(1)] },
    F7_blank: { ...R, summary: "   " },
    F8_extra: { ...R, criteria: [...R.criteria, { id: "creativity", score: 2, justification: "x" }] },
  };
  for (const [k, r] of Object.entries(bad)) {
    try { toFeedbackView(maths, state, r); console.log(k, "NO THROW"); } catch (e) { console.log(k, e instanceof FeedbackInvalidError ? "throws FeedbackInvalidError" : "OTHER " + e); }
  }
  console.log("NA", JSON.stringify(noAnswerView(maths)));
  for (const n of [1, 2, 3, 5, 6, 9, 12]) {
    const tr = Array.from({ length: n }, (_, i) => ({ id: "s" + i, at: 1000 * (i + 1), speaker: "student", kind: "typed", text: i === 0 ? "  one two three four five six seven eight nine ten " : "x" }));
    const r = fakeReport(maths, { transcript: tr });
    console.log("FK n=" + n, r.summary, "|", r.criteria.map((c) => c.id + ":" + c.score).join(","), "|", r.criteria[0].justification, "|", JSON.stringify(r.keyMoments));
    toFeedbackView(maths, { transcript: tr }, r);
  }
  for (const ms of [0, 5000, 59999, 60000, 65000, 600000, 3599000]) console.log("AT", ms, formatAt(ms));
  // Synthetic config for the exact-prompt test
  const TC = {
    id: "t", title: "Test interview", subject: "Mathematics",
    styles: [{ id: "s", label: "Supportive", persona: "p", tone: "t", interjection: { minConfidence: 0.7, cooldownMs: 0, minNewWords: 0 } }],
    problems: [{ id: "p1", title: "Roots", statement: "Is the square root of 2 rational?", checkpoints: [{ id: "c1", description: "d" }], hintLadder: ["h"], probes: ["q"], misconceptions: [], solutionSketch: "Assume p/q in lowest terms." }],
    rubric: { criteria: [
      { id: "approach", name: "Approach", levels: [{ score: 1, descriptor: "Weak." }, { score: 2, descriptor: "Strong." }] },
      { id: "clarity", name: "Clarity", levels: [{ score: 1, descriptor: "Unclear." }, { score: 2, descriptor: "Clear." }] },
    ] },
    timing: { maxMinutes: 10, silenceStuckMs: 20000 }, fallbackPrompt: "f", asrKeywords: [],
  };
  const TS = { transcript: [
    { id: "a", at: 0, speaker: "interviewer", kind: "utterance", text: "Hello." },
    { id: "b", at: 4000, speaker: "student", kind: "voice" === "x" ? "typed" : "utterance", text: "It is   rational\nI think" },
    { id: "c", at: 4000, speaker: "interviewer", kind: "interjection", text: "Hold on." },
  ] };
  const m = buildFeedbackMessages(TC, TC.styles[0], TS);
  console.log("SYS", JSON.stringify(m[0].content));
  console.log("USER\n" + m[1].content);
}
