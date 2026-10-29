// Stage 9 (feedback) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-09-mutants.mjs --only=view --part=1/2    (~5 min; then --part=2/2)
//   node agent-os/review/stage-09-mutants.mjs --only=fake               (~3 min)
//   node agent-os/review/stage-09-mutants.mjs --only=handler            (~5 min)
//   node agent-os/review/stage-09-mutants.mjs --only=client             (~5 min)
//   node agent-os/review/stage-09-mutants.mjs --restore     (restore files from on-disk backups after a kill)
//   node agent-os/review/stage-09-mutants.mjs --list        (list mutation counts by group)
//   node agent-os/review/stage-09-mutants.mjs --only=handler --label="H7"   (only labels containing the substring)
//   node agent-os/review/stage-09-mutants.mjs --dry         (check every anchor resolves; "caught" = anchors found)
//   node agent-os/review/stage-09-mutants.mjs --reviewer    (also run the reviewer's test files in
//        agent-os/review/stage-09-tests/*.test.ts.txt, copied to tests/s9rev-*.test.ts for the run and deleted after;
//        a reviewer file named like a builder file replaces it, any other is added to every group's run)
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert, runs only the group's test files, records caught/missed.
// Every touched file is restored after each mutation and byte-verified at the end.
// On-disk backups (os.tmpdir()/interim-review/backup-s9) survive a hard kill: run --restore
// (first check the sources against the backups, see REVIEWER_HANDOFF §5).
// Output is compact: "caught X/Y", then one line per missed or skipped mutation.
// "SKIPPED: NOT FOUND" means the code moved; re-anchor that entry (don't drop it).
// Entries marked EQUIVALENT are expected to be MISSED.
//
// Round 2: tests/feedback-review.test.ts (review-1 T1) runs in every group; with it and B1 the sweep gives 166/168.
// Never add a mutant that drops `client` from generateReport: the real client would reach the network.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const reviewer = process.argv.includes("--reviewer");
// file key -> { path, group, tests }
const F = {
  view: { path: `${repo}/src/server/feedback.ts`, group: "view", tests: ["feedback-review", "feedback-view", "fake-feedback", "feedback-route", "e2e-feedback"] },
  fake: { path: `${repo}/src/server/fake-feedback.ts`, group: "fake", tests: ["feedback-review", "fake-feedback", "e2e-feedback"] },
  deps: { path: `${repo}/src/server/feedback-deps.ts`, group: "fake", tests: ["feedback-review", "fake-feedback"] },
  handler: { path: `${repo}/src/server/feedback-handler.ts`, group: "handler", tests: ["feedback-review", "feedback-route", "e2e-feedback"] },
  client: { path: `${repo}/src/client/feedback-client.ts`, group: "client", tests: ["feedback-review", "feedback-client", "e2e-feedback"] },
};
const GROUPS = [...new Set(Object.values(F).map((f) => f.group))];
const revDir = join(repo, "agent-os/review/stage-09-tests");
const revFiles = existsSync(revDir) ? readdirSync(revDir).filter((n) => n.endsWith(".test.ts.txt")) : [];
const revBase = (f) => f.replace(/\.test\.ts\.txt$/, "");
const testFiles = (key) => {
  const own = F[key].tests.map((n) => (reviewer && revFiles.includes(`${n}.test.ts.txt`) ? `tests/s9rev-${n}.test.ts` : `tests/${n}.test.ts`));
  const extra = reviewer ? revFiles.filter((f) => !Object.values(F).some((v) => v.tests.includes(revBase(f)))).map((f) => `tests/s9rev-${revBase(f)}.test.ts`) : [];
  return [...own, ...extra].join(" ");
};
const bdir = join(tmpdir(), "interim-review", "backup-s9");

// [label, fileKey, from, to, nth?]   nth = 0-based occurrence when `from` is not unique
const CC = '"Cache-Control": "no-store",';
const M = [
  // ---- view: src/server/feedback.ts (V1-V6, prompt, noAnswerView, generateReport) ----
  ["V1: summary not trimmed", "view", "const summary = report.summary.trim();", "const summary = report.summary;"],
  ["V1: empty summary accepted", "view", 'if (summary === "") {', "if (false) {"],
  ["V2: count check removed", "view", "if (report.criteria.length !== config.rubric.criteria.length) {", "if (false) {"],
  ["V3: duplicate allowed (EQUIVALENT: V2 count + every id present => each exactly once)", "view", "if (found.length !== 1) {", "if (found.length < 1) {"],
  ["V3: missing criterion allowed", "view", "if (found.length !== 1) {", "if (found.length > 1) {"],
  ["V3: unknown level accepted", "view", "if (!level) {", "if (false) {"],
  ["V3: not config order", "view", "for (const c of config.rubric.criteria) {\n    const found", "for (const c of [...config.rubric.criteria].reverse()) {\n    const found"],
  ["V3: maxScore = chosen score", "view", "const maxScore = Math.max(...c.levels.map((l) => l.score));\n    criteria.push", "const maxScore = level.score;\n    criteria.push"],
  ["V3: descriptor of lowest level", "view", "descriptor: level.descriptor,", "descriptor: c.levels[0].descriptor,"],
  ["V3: justification not trimmed", "view", "justification: reportEntry.justification.trim(),", "justification: reportEntry.justification,"],
  ["V4: strengths not trimmed", "view", ".map((s) => s.trim())", ".map((s) => s)", 0],
  ["V4: strengths keep empty", "view", '.filter((s) => s !== "")', ".filter(() => true)", 0],
  ["V4: strengths no cap", "view", ".slice(0, 5);\n\n  const improvements", ";\n\n  const improvements"],
  ["V4: strengths cap 3", "view", ".slice(0, 5);\n\n  const improvements", ".slice(0, 3);\n\n  const improvements"],
  ["V4: improvements not trimmed", "view", ".map((s) => s.trim())", ".map((s) => s)", 1],
  ["V4: improvements keep empty", "view", '.filter((s) => s !== "")', ".filter(() => true)", 1],
  ["V4: improvements no cap", "view", ".slice(0, 5);\n\n  // V5", ";\n\n  // V5"],
  ["V4: improvements cap 3", "view", ".slice(0, 5);\n\n  // V5", ".slice(0, 3);\n\n  // V5"],
  ["V5: empty quote kept", "view", 'if (normalizedQuote === "") continue;', ""],
  ["V5: empty note kept", "view", 'if (m.note.trim() === "") continue;', ""],
  ["V5: any speaker", "view", 'e.speaker === "student" &&\n        e.at === m.at', "e.at === m.at"],
  ["V5: any time", "view", "e.at === m.at &&\n", ""],
  ["V5: transcript text not normalized", "view", "normalizeText(e.text).includes(normalizedQuote)", "e.text.includes(normalizedQuote)"],
  ["V5: raw quote in output", "view", "quote: normalizedQuote,", "quote: m.quote,"],
  ["V5: note not trimmed", "view", "note: m.note.trim(),", "note: m.note,"],
  ["V5: no sort", "view", "validMoments.sort((a, b) => a.at - b.at);", ""],
  ["V5: sort descending", "view", "validMoments.sort((a, b) => a.at - b.at);", "validMoments.sort((a, b) => b.at - a.at);"],
  ["V5: unstable tie order", "view", "validMoments.sort((a, b) => a.at - b.at);", "validMoments.sort((a, b) => a.at - b.at || a.quote.localeCompare(b.quote));"],
  ["V5: no cap", "view", "const keyMoments = validMoments.slice(0, 5);", "const keyMoments = validMoments;"],
  ["V5: cap 3", "view", "const keyMoments = validMoments.slice(0, 5);", "const keyMoments = validMoments.slice(0, 3);"],
  ["V5: cap before sort", "view", "validMoments.sort((a, b) => a.at - b.at);\n  const keyMoments = validMoments.slice(0, 5);", "const keyMoments = validMoments.slice(0, 5);\n  keyMoments.sort((a, b) => a.at - b.at);"],
  ["V6: modelLabel key added", "view", "return { summary, criteria, strengths, improvements, keyMoments };", "return { summary, criteria, strengths, improvements, keyMoments, modelLabel: undefined };"],
  ["normalizeText: double-space join", "view", '    .join(" ");', '    .join("  ");'],
  ["prompt: system quotes", "view", 'address the student as "you"', "address the student as you"],
  ["prompt: subject ignored", "view", "practice interview in ${subject}.", "practice interview in maths."],
  ["prompt: title line", "view", "`Interview: ${config.title}`", "`Interview: ${config.id}`"],
  ["prompt: style label", "view", "`Interviewer style: ${style.label}`", "`Interviewer style: ${style.id}`"],
  ["prompt: problem numbering", "view", "`${i + 1}. ${p.title}: ${p.statement}`", "`${i}. ${p.title}: ${p.statement}`"],
  ["prompt: model-solution indent", "view", "`   Model solution", "`  Model solution"],
  ["prompt: criterion line", "view", "`- ${c.id} (${c.name}):`", "`- ${c.name}:`"],
  ["prompt: level indent", "view", "`  ${l.score}: ${l.descriptor}`", "` ${l.score}: ${l.descriptor}`"],
  ["prompt: interjection label", "view", '"Interviewer (interrupting)"', '"Interviewer"'],
  ["prompt: transcript not normalized", "view", ": ${normalizeText(e.text)}`", ": ${e.text}`"],
  ["prompt: return block text", "view", "- keyMoments: up to 3 moments", "- keyMoments: up to 5 moments"],
  ["prompt: blank line before return block", "view", '  // 12. Empty line\n  lines.push("");\n', "  // 12. Empty line\n"],
  ["noAnswer: highest level", "view", "const lowest = sorted[0];", "const lowest = sorted[sorted.length - 1];"],
  ["noAnswer: no sort (EQUIVALENT for ascending configs unless tested)", "view", "const sorted = [...c.levels].sort((a, b) => a.score - b.score);\n    const lowest", "const sorted = [...c.levels];\n    const lowest"],
  ["noAnswer: maxScore = lowest", "view", "const maxScore = Math.max(...c.levels.map((l) => l.score));\n    return {", "const maxScore = lowest.score;\n    return {"],
  ["noAnswer: justification", "view", '"No answer was given."', '"No answer."'],
  ["noAnswer: improvements text", "view", '"Answer out loud, even', '"Answer aloud, even'],
  ["noAnswer: summary text", "view", "so there's nothing to score yet.", "so there is nothing to score yet."],
  ["generateReport: retry true", "view", "retry: false,", "retry: true,"],
  ["generateReport: default timeout", "view", "timeoutMs: FEEDBACK_TIMEOUT_MS,", ""],
  ["generateReport: timeout 8 s", "view", "export const FEEDBACK_TIMEOUT_MS = 20_000;", "export const FEEDBACK_TIMEOUT_MS = 8_000;"],
  ["generateReport: signal dropped", "view", "    signal,\n    client,\n  });", "    client,\n  });"],
  ["generateReport: schemaName", "view", 'schemaName: "Report",', 'schemaName: "report",'],

  // ---- fake: src/server/fake-feedback.ts + feedback-deps.ts ----
  ["fake: plural for 0", "fake", 'k === 1 ? "" : "s"', 'k <= 1 ? "" : "s"'],
  ["fake: ceil", "fake", "Math.floor(n / 3)", "Math.ceil(n / 3)"],
  ["fake: n/2", "fake", "Math.floor(n / 3)", "Math.floor(n / 2)"],
  ["fake: no clamp", "fake", "Math.min(sorted.length - 1, Math.floor(n / 3))", "Math.floor(n / 3)"],
  ["fake: no sort (EQUIVALENT for ascending configs unless tested)", "fake", "[...c.levels].sort((a, b) => a.score - b.score)", "[...c.levels]"],
  ["fake: counts every entry", "fake", 'state.transcript.filter((e) => e.speaker === "student")', "state.transcript"],
  ["fake: summary word", "fake", 'you answered ${plural(n, "time")}', 'you answered ${plural(n, "answer")}'],
  ["fake: justification", "fake", 'Offline estimate from ${plural(n, "answer")}.', "Offline estimate from ${n} answers."],
  ["fake: strengths text", "fake", '"You kept going and shared your thinking."', '"You kept going."'],
  ["fake: improvements text", "fake", '"Justify each step before moving on."', '"Justify each step."'],
  ["fake: quote 7 words", "fake", ".slice(0, 8)", ".slice(0, 7)"],
  ["fake: quote not normalized", "fake", 'normalizeText(students[0].text).split(" ")', 'students[0].text.split(" ")'],
  ["fake: last student's at", "fake", "at: students[0].at,", "at: students[n - 1].at,"],
  ["fake: note text", "fake", '"Your first answer."', '"First answer."'],
  ["fake: moment when n = 0", "fake", "n > 0\n", "n >= 0\n"],
  ["fakeGenerate: no delay", "fake", "setTimeout(resolve, FAKE_FEEDBACK_DELAY_MS)", "setTimeout(resolve, 0)"],
  ["fakeGenerate: delay 100", "fake", "FAKE_FEEDBACK_DELAY_MS = 300;", "FAKE_FEEDBACK_DELAY_MS = 100;"],
  ["fakeGenerate: abort ignored", "fake", "if (args.signal?.aborted) {", "if (false) {"],
  ["fakeGenerate: abort name", "fake", 'err.name = "AbortError";', ""],
  ["deps: truthy flag", "deps", 'env.INTERIM_FAKE_MODEL === "1"', "!!env.INTERIM_FAKE_MODEL"],
  ["deps: production allowed", "deps", ' && env.NODE_ENV !== "production"', ""],
  ["deps: no modelLabel", "deps", 'modelLabel: "fake",', ""],
  ["deps: real generate in fake mode", "deps", "generate: fakeGenerate,", "generate: generateReport,"],

  // ---- handler: src/server/feedback-handler.ts (H1-H8) ----
  ["H1: >= limit", "handler", "parseInt(contentLength, 10) > FEEDBACK_MAX_BODY_BYTES", "parseInt(contentLength, 10) >= FEEDBACK_MAX_BODY_BYTES"],
  ["H1: removed", "handler", "if (contentLength && parseInt", "if (false && parseInt"],
  ["H1: status 400", "handler", "status: 413,", "status: 400,"],
  ["H2: status 500", "handler", "status: 400,", "status: 500,", 0],
  ["H2: code", "handler", 'code: "bad_request",', 'code: "invalid_json",', 0],
  ["H3: schema check removed", "handler", "if (!parseResult.success) {", "if (false) {"],
  ["H3: code", "handler", 'code: "bad_request",', 'code: "invalid_state",', 1],
  ["H4: config errors rethrown", "handler", "if (err instanceof ConfigError) {", "if (false) {"],
  ["H5: phase check removed", "handler", 'if (state.phase !== "done") {', "if (false) {"],
  ["H5: code", "handler", 'code: "not_finished",', 'code: "bad_request",'],
  ["H5: after H6", "handler", ['    // H5: Check phase is done\n    if (state.phase !== "done") {', "    // H7: Try up to"], ['    // H5: Check phase is done\n    if (false) {', '    if (state.phase !== "done") return new Response(JSON.stringify({ error: { code: "not_finished", message: "The interview hasn\'t finished yet." } }), { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });\n    // H7: Try up to']],
  ["H6: removed", "handler", "if (!hasStudentEntry) {", "if (false) {"],
  ["H6: any entry counts", "handler", 'state.transcript.some((e) => e.speaker === "student")', "state.transcript.length > 0"],
  ["H6: modelLabel dropped", "handler", "const response: FeedbackView = deps.modelLabel", "const response: FeedbackView = false && deps.modelLabel", 0],
  ["H7: modelLabel dropped", "handler", "const response: FeedbackView = deps.modelLabel", "const response: FeedbackView = false && deps.modelLabel", 1],
  ["H7: signal not passed", "handler", "signal: request.signal,", "signal: undefined,"],
  ["H7: request-abort check removed", "handler", "request.signal.aborted || (err", "(err"],
  ["H7: AbortError-name check removed (EQUIVALENT: an abort error is never FeedbackInvalidError/retryable MetaError)", "handler", ' || (err instanceof Error && err.name === "AbortError")', ""],
  ["H7: invalid report not retried", "handler", "const retryable =\n          err instanceof FeedbackInvalidError ||\n", "const retryable =\n"],
  ["H7: MetaError.retryable ignored", "handler", "(err instanceof MetaError && err.retryable);", "(err instanceof MetaError);"],
  ["H7: MetaError never retried", "handler", "(err instanceof MetaError && err.retryable);", "false;"],
  ["H7: retries everything", "handler", "if (retryable && !isLastAttempt) {", "if (!isLastAttempt) {"],
  ["H7: sleeps after last attempt", "handler", "if (retryable && !isLastAttempt) {", "if (retryable) {"],
  ["H7: no sleep", "handler", "await sleep(FEEDBACK_RETRY_DELAY_MS);\n", ""],
  ["H7: sleep 0", "handler", "await sleep(FEEDBACK_RETRY_DELAY_MS);", "await sleep(0);"],
  ["H7: retry delay 300", "handler", "FEEDBACK_RETRY_DELAY_MS = 400;", "FEEDBACK_RETRY_DELAY_MS = 300;"],
  ["H7: default sleep 0", "handler", "setTimeout(resolve, ms)", "setTimeout(resolve, 0)"],
  ["B1: abort during the wait ignored (needs the review-1 B1 line)", "handler", "          if (request.signal.aborted) break;\n", ""],
  ["H7: 3 attempts", "handler", "FEEDBACK_ATTEMPTS = 2;", "FEEDBACK_ATTEMPTS = 3;"],
  ["H8: retryable always true", "handler", "const retryable =\n      lastError instanceof FeedbackInvalidError ||\n      (lastError instanceof MetaError && lastError.retryable);", "const retryable = true;"],
  ["H8: invalid not retryable", "handler", "lastError instanceof FeedbackInvalidError ||\n      (lastError", "(lastError"],
  ["H8: status 500", "handler", "status: 502,", "status: 500,"],
  ["H8: code", "handler", 'code: "feedback_failed",', 'code: "failed",'],
  ["H8: message", "handler", "message: \"We couldn't prepare your feedback.\",", 'message: "Failed.",'],
  ["H8: log code invalid", "handler", 'code = "invalid";', 'code = "error";'],
  ["H8: log MetaError code", "handler", "code = lastError.code;", 'code = "error";'],
  ["H8: log attempts off by one", "handler", "attempts = attempt + 1;", "attempts = attempt;"],
  ["H8: no log", "handler", 'console.warn("Interim: feedback failed", {\n      attempts,\n      code,\n    });', ""],
  ["H8: logs transcript", "handler", "      attempts,\n      code,\n    });", "      attempts,\n      code,\n      text: state.transcript.map((e) => e.text).join(\" \"),\n    });"],
  ["headers: 413 cache", "handler", CC, '"Cache-Control": "private",', 0],
  ["headers: 400 bad_request cache", "handler", CC, '"Cache-Control": "private",', 1],
  ["headers: 400 not_finished cache", "handler", CC, '"Cache-Control": "private",', 4],
  ["headers: 200 no-answer cache", "handler", CC, '"Cache-Control": "private",', 5],
  ["headers: 200 report cache", "handler", CC, '"Cache-Control": "private",', 6],
  ["headers: 502 cache", "handler", CC, '"Cache-Control": "private",', 7],
  ["headers: 502 content-type", "handler", '"Content-Type": "application/json",', '"Content-Type": "text/plain",', 7],

  // ---- client: src/client/feedback-client.ts (C1-C3, describe, formatAt, R1-R6) ----
  ["C1: method", "client", 'method: "POST",', 'method: "PUT",'],
  ["C1: header", "client", 'headers: { "Content-Type": "application/json" },', "headers: {},"],
  ["C1: body", "client", "body: JSON.stringify({ state }),", "body: JSON.stringify(state),"],
  ["C1: signal", "client", "signal: opts?.signal,", "signal: undefined,"],
  ["C1: default endpoint", "client", '?? "/api/feedback"', '?? "/api/feedback/"'],
  ["C1: endpoint ignored", "client", 'opts?.endpoint ?? "/api/feedback"', '"/api/feedback"'],
  ["C1: signal-aborted rethrow removed", "client", "if (opts?.signal?.aborted || (err", "if ((err"],
  ["C1: AbortError-name rethrow removed", "client", ' || (err instanceof Error && err.name === "AbortError")) {\n      throw err;', ") {\n      throw err;"],
  ["C1: aborts wrapped", "client", 'if (opts?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {', "if (false) {"],
  ["C1: network status", "client", 'new FeedbackError(0, "network", true)', 'new FeedbackError(503, "network", true)'],
  ["C1: network not retryable", "client", 'new FeedbackError(0, "network", true)', 'new FeedbackError(0, "network", false)'],
  ["C2: default code", "client", 'let code = "http";', 'let code = "error";'],
  ["C2: body code ignored", "client", "code = error.code;", ""],
  ["C2: 500 not retryable", "client", "response.status >= 500", "response.status > 500"],
  ["C2: always retryable", "client", "response.status >= 500", "true"],
  ["C2: status 0", "client", "throw new FeedbackError(response.status, code,", "throw new FeedbackError(0, code,"],
  ["C3: invalid JSON code", "client", '} catch {\n    throw new FeedbackError(response.status, "protocol", true);', '} catch {\n    throw new FeedbackError(response.status, "http", true);'],
  ["C3: schema skipped", "client", "if (!result.success) {", "if (false) {"],
  ["C3: protocol not retryable", "client", 'if (!result.success) {\n    throw new FeedbackError(response.status, "protocol", true);', 'if (!result.success) {\n    throw new FeedbackError(response.status, "protocol", false);'],
  ["describe: 400 generic", "client", "err.status === 400 || ", ""],
  ["describe: 413 generic", "client", " || err.status === 413", ""],
  ["describe: message", "client", "\"This interview can't be scored.\"", "\"Can't score.\""],
  ["describe: 4xx retryable", "client", "retryable: false,\n      };", "retryable: true,\n      };"],
  ["describe: default message", "client", "\"We couldn't prepare your feedback. Please try again.\"", "\"We couldn't prepare your feedback.\""],
  ["formatAt: minutes rounded", "client", "Math.floor(ms / 60000)", "Math.round(ms / 60000)"],
  ["formatAt: seconds rounded", "client", "Math.floor(ms / 1000) % 60", "Math.round(ms / 1000) % 60"],
  ["formatAt: no pad", "client", 'padStart(2, "0")', 'padStart(1, "0")'],
  ["R1: start emits loading", "client", "currentRun = { controller, token };\n", 'currentRun = { controller, token };\n    deps.onChange({ status: "loading" });\n'],
  ["R1: previous run not aborted", "client", "    if (currentRun !== null) {\n      currentRun.controller.abort();\n", "    if (currentRun !== null) {\n", 0],
  ["R1: lastState not stored", "client", "lastState = state;", ""],
  ["R1: signal not passed", "client", "deps.fetchFeedback(state, controller.signal)", "deps.fetchFeedback(state, new AbortController().signal)"],
  ["R2: stale success emits", "client", "(view) => {\n        // R2: Only if still current\n        if (currentRun?.token !== token) return;", "(view) => {\n"],
  ["R2: run not cleared", "client", 'if (currentRun?.token !== token) return;\n        currentRun = null;\n        deps.onChange({ status: "ready"', 'if (currentRun?.token !== token) return;\n        deps.onChange({ status: "ready"'],
  ["R3: abort() doesn't abort", "client", "    if (currentRun !== null) {\n      currentRun.controller.abort();\n", "    if (currentRun !== null) {\n", 1],
  ["R3: abort() doesn't clear", "client", "currentRun.controller.abort();\n      currentRun = null;\n    }\n  };", "currentRun.controller.abort();\n    }\n  };"],
  ["R4: stale failure emits", "client", "(err) => {\n        // R4: Only if still current\n        if (currentRun?.token !== token) return;", "(err) => {\n"],
  ["R4: run not cleared", "client", "if (currentRun?.token !== token) return;\n        currentRun = null;\n\n        // R4: Ignore abort", "if (currentRun?.token !== token) return;\n\n        // R4: Ignore abort"],
  ["R4: AbortError reported", "client", 'if (err instanceof Error && err.name === "AbortError") return;', ""],
  ["R4: describe ignored", "client", "const { message, retryable } = describeFeedbackError(err);", "const { message, retryable } = { message: \"We couldn't prepare your feedback. Please try again.\", retryable: true };"],
  ["R5: retry before start", "client", "if (lastState === null || currentRun !== null) return;", "if (currentRun !== null) return;"],
  ["R5: retry while in flight", "client", "if (lastState === null || currentRun !== null) return;", "if (lastState === null) return;"],
  ["R5: no loading", "client", 'deps.onChange({ status: "loading" });\n    start(lastState);', "start(lastState);"],
  ["R5: copies state", "client", "start(lastState);", "start({ ...lastState });"],
];

if (process.argv.includes("--list")) {
  for (const g of GROUPS) console.log(`${g}: ${M.filter((m) => F[m[1]].group === g).length}`);
  process.exit(0);
}
if (process.argv.includes("--restore")) {
  let n = 0;
  for (const [k, v] of Object.entries(F)) if (existsSync(join(bdir, k))) { writeFileSync(v.path, readFileSync(join(bdir, k))); n++; }
  for (const f of readdirSync(join(repo, "tests"))) if (f.startsWith("s9rev-")) rmSync(join(repo, "tests", f));
  console.log(`restored ${n} file(s) from ${bdir}`); process.exit(0);
}

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const groups = only.length ? only : GROUPS;
const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8);
const orig = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, readFileSync(v.path)]));
mkdirSync(bdir, { recursive: true });
for (const k of Object.keys(F)) writeFileSync(join(bdir, k), orig[k]);
const copies = [];
if (reviewer) {
  for (const f of revFiles) {
    const dest = join(repo, "tests", "s9rev-" + f.replace(/\.txt$/, ""));
    writeFileSync(dest, readFileSync(join(revDir, f)));
    copies.push(dest);
  }
}
const restore = () => { for (const [k, v] of Object.entries(F)) writeFileSync(v.path, orig[k]); };
process.on("exit", () => { restore(); for (const c of copies) if (existsSync(c)) rmSync(c); });
process.on("SIGINT", () => { process.exit(1); });

function replaceNth(src, from, to, nth) {
  const idxs = []; let i = -1;
  while ((i = src.indexOf(from, i + 1)) !== -1) idxs.push(i);
  if (idxs.length === 0) return { err: "NOT FOUND" };
  if (nth === undefined && idxs.length > 1) return { err: `AMBIGUOUS (${idxs.length})` };
  if ((nth ?? 0) >= idxs.length) return { err: "NOT FOUND (nth)" };
  return { out: src.slice(0, idxs[nth ?? 0]) + to + src.slice(idxs[nth ?? 0] + from.length) };
}
// `from`/`to` may be parallel arrays: a multi-spot revert (each anchor must be unique), applied in order.
function applyMutation(src, from, to, nth) {
  if (!Array.isArray(from)) return replaceNth(src, from, to, nth);
  let out = src;
  for (let i = 0; i < from.length; i++) {
    const r = replaceNth(out, from[i], to[i]);
    if (r.err) return r;
    out = r.out;
  }
  return { out };
}
const runTests = (files) => {
  let o = "";
  try { o = execSync(`npx vitest run ${files}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, timeout: 240000 }); }
  catch (e) { o = (e.stdout ?? "") + (e.stderr ?? ""); }
  return o.replace(/\x1b\[[0-9;]*m/g, "");
};

const [partK, partN] = ((process.argv.find((a) => a.startsWith("--part=")) ?? "--part=1/1").slice(7)).split("/").map(Number);
const selected = M.filter(([label, key]) => groups.includes(F[key].group) && (!labelFilter || label.includes(labelFilter)));
const sliceLen = Math.ceil(selected.length / partN);
const mine = selected.slice((partK - 1) * sliceLen, partK * sliceLen);

let total = 0, caught = 0; const lines = [];
for (const [label, key, from, to, nth] of mine) {
  total++;
  restore();
  const r = applyMutation(orig[key].toString("utf8"), from, to, nth);
  if (r.err) { lines.push(`SKIPPED (${r.err}): ${label}`); continue; }
  if (process.argv.includes("--dry")) { caught++; continue; }
  writeFileSync(F[key].path, r.out);
  const out = runTests(testFiles(key));
  const summary = (out.match(/Tests\s+.*$/m) ?? [""])[0];
  if (/\d+ failed/.test(summary) || /Failed Suites|Error:/.test(out) && !/passed \(\d+\)\s*$/.test(summary)) caught++;
  else lines.push(`MISSED: ${label}`);
}
restore();
const bad = Object.entries(F).filter(([k, v]) => !readFileSync(v.path).equals(orig[k])).map(([k]) => k);
console.log(`groups=${groups.join(",")}${reviewer ? " (reviewer tests)" : ""} caught ${caught}/${total}`);
for (const l of lines) console.log(l);
console.log(bad.length ? `RESTORE MISMATCH: ${bad.join(",")} — run with --restore` : "restore: all files byte-identical");
