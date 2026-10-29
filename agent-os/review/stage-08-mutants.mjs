// Stage 8 (mid-answer + canvas) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-08-mutants.mjs --only=model,bgrunner      (~4 min)
//   node agent-os/review/stage-08-mutants.mjs --only=turn                (~4 min)
//   node agent-os/review/stage-08-mutants.mjs --only=voice               (~4 min)
//   node agent-os/review/stage-08-mutants.mjs --restore     (restore files from on-disk backups after a kill)
//   node agent-os/review/stage-08-mutants.mjs --list        (list mutation counts by group)
//   node agent-os/review/stage-08-mutants.mjs --only=turn --label="T9"    (only labels containing the substring)
//   node agent-os/review/stage-08-mutants.mjs --only=turn --part=1/2      (first half; then --part=2/2)
//   node agent-os/review/stage-08-mutants.mjs --dry         (check every anchor resolves; "caught" = anchors found)
//   node agent-os/review/stage-08-mutants.mjs --reviewer    (run against the reviewer's test files in
//        agent-os/review/stage-08-tests/*.test.ts.txt, copied to tests/s8rev-*.test.ts for the run and deleted after)
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert, runs only the group's test files, records caught/missed.
// Every touched file is restored after each mutation and byte-verified at the end.
// On-disk backups (os.tmpdir()/interim-review/backup-s8) survive a hard kill: run --restore.
// Output is compact: "caught X/Y", then one line per missed or skipped mutation.
// "SKIPPED: NOT FOUND" means the code moved; re-anchor that entry (don't drop it).
// Entries marked EQUIVALENT are expected to be MISSED.
//
// Round 1 (stage-08-review.md): all four groups written against the builder's first build.
//   Builder tests: model 21/27, bgrunner 11/15, turn 50/71, voice 8/20.
//   Reviewer tests (--reviewer, agent-os/review/stage-08-tests): model 27/27, bgrunner 12/15, turn 67/71, voice 20/20;
//   every remaining miss is labelled EQUIVALENT (8 in total).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const reviewer = process.argv.includes("--reviewer");
const F = {
  model: { path: `${repo}/src/client/interview-model.ts`, tests: ["interview-model"] },
  bgrunner: { path: `${repo}/src/client/background-runner.ts`, tests: ["background-runner", "e2e-mid-answer"] },
  turn: { path: `${repo}/src/client/turn-controller.ts`, tests: ["turn-controller"] },
  voice: { path: `${repo}/src/client/voice/voice-controller.ts`, tests: ["voice-interjection", "voice-controller"] },
};
const revDir = join(repo, "agent-os/review/stage-08-tests");
const testFiles = (key) =>
  F[key].tests
    .map((n) => (reviewer && existsSync(join(revDir, `${n}.test.ts.txt`)) ? `tests/s8rev-${n}.test.ts` : `tests/${n}.test.ts`))
    .join(" ");
const bdir = join(tmpdir(), "interim-review", "backup-s8");

const B = "interjectBaseline";
// [label, group, from, to, nth?]   nth = 0-based occurrence when `from` is not unique
const M = [
  // ---- model (§1) ----
  ["model: initialView background pending", "model", 'modelLabel: null,\n  background: "none",', 'modelLabel: null,\n  background: "pending",'],
  ["model: request keeps background", "model", 'studentText: action.studentText },\n        background: "none",', "studentText: action.studentText },"],
  ["model: done keeps background", "model", 'status: newStatus,\n        background: "none",', "status: newStatus,"],
  ["model: bg_request no-op", "model", 'return { ...view, background: "pending" };', "return view;"],
  ["model: bg_request sets sending", "model", 'return { ...view, background: "pending" };', 'return { ...view, background: "pending", status: "sending" };'],
  ["model: bg_request clears streamingText", "model", 'return { ...view, background: "pending" };', 'return { ...view, background: "pending", streamingText: "" };'],
  ["model: bg_request clears lastRequest", "model", 'return { ...view, background: "pending" };', 'return { ...view, background: "pending", lastRequest: null };'],
  ["model: bg_move silent copies view", "model", 'if (action.move.type === "silent") return view;', 'if (action.move.type === "silent") return { ...view };'],
  ["model: bg_move silent treated as spoken", "model", 'if (action.move.type === "silent") return view;', ""],
  ["model: bg_move no sending", "model", 'status: "sending",\n        background: "speaking",', 'background: "speaking",'],
  ["model: bg_move no speaking", "model", 'background: "speaking",\n        streamingText: "",', 'streamingText: "",'],
  ["model: bg_move keeps streamingText", "model", 'streamingText: "",\n        lastMove: action.move,', "lastMove: action.move,"],
  ["model: bg_move no lastMove", "model", "lastMove: action.move,\n        slow: false,", "slow: false,"],
  ["model: bg_move keeps slow", "model", "lastMove: action.move,\n        slow: false,", "lastMove: action.move,"],
  ["model: bg_failed speaking branch dropped", "model", 'if (view.background === "speaking") {', "if (false) {"],
  ["model: bg_failed speaking keeps status", "model", 'background: "none", status: "ready", streamingText: ""', 'background: "none", streamingText: ""'],
  ["model: bg_failed speaking keeps streamingText", "model", 'background: "none", status: "ready", streamingText: ""', 'background: "none", status: "ready"'],
  ["model: bg_failed pending no-op", "model", '      return { ...view, background: "none" };', "      return view;"],
  ["model: bg_failed pending clears streamingText", "model", '      return { ...view, background: "none" };', '      return { ...view, background: "none", streamingText: "" };'],
  ["model: bg_failed pending sets ready", "model", '      return { ...view, background: "none" };', '      return { ...view, background: "none", status: "ready" };'],
  ["model: buildBackgroundRequest no throw", "model", 'if (view.engine === null) {\n    throw new Error("Cannot build background request without engine");\n  }', ""],
  ["model: map request passthrough", "model", 'return { type: "bg_request", request: action.request };', "return action;"],
  ["model: map request copies request", "model", 'return { type: "bg_request", request: action.request };', 'return { type: "bg_request", request: { ...action.request } };'],
  ["model: map move passthrough", "model", 'return { type: "bg_move", move: action.move };', "return action;"],
  ["model: map failed passthrough", "model", 'return { type: "bg_failed" };', "return action;"],
  ["model: map slow passthrough", "model", 'case "slow":\n      return null;', 'case "slow":\n      return action;'],
  ["model: map default drops", "model", "default:\n      return action;", "default:\n      return null;"],
  // ---- bgrunner (§2 rules 1-5) ----
  ["bg R1: lastMove not recorded", "bgrunner", "      lastMove = action.move;\n", ""],
  ["bg R1: no mapping", "bgrunner", "const m = mapBackgroundAction(action);", "const m = action;"],
  ["bg R1: null not dropped", "bgrunner", "if (m !== null) {\n      deps.dispatch(m);\n    }", "deps.dispatch(m ?? action);"],
  ["bg R1: settle before dispatch", "bgrunner",
    ["    const m = mapBackgroundAction(action);\n    if (m !== null) {\n      deps.dispatch(m);\n    }\n", '    } else if (action.type === "failed") {\n      settle(null);\n    }\n'],
    ["", '    } else if (action.type === "failed") {\n      settle(null);\n    }\n    const m = mapBackgroundAction(action);\n    if (m !== null) {\n      deps.dispatch(m);\n    }\n']],
  ["bg R1: done does not settle", "bgrunner", "      settle(lastMove);\n", ""],
  ["bg R1: done settles null", "bgrunner", "settle(lastMove);", "settle(null);"],
  ["bg R1: failed does not settle", "bgrunner", '} else if (action.type === "failed") {\n      settle(null);\n    }', "}"],
  ["bg R2: run keeps lastMove (EQUIVALENT: every stream starts with move)", "bgrunner", "    lastMove = null;\n    active = true;", "    active = true;"],
  ["bg R2: run not active", "bgrunner", "    lastMove = null;\n    active = true;", "    lastMove = null;"],
  ["bg R3: active cleared after onSettled", "bgrunner", "    active = false;\n    deps.onSettled(move);", "    deps.onSettled(move);\n    active = false;"],
  ["bg R3: settle unguarded (EQUIVALENT: only the current run's done/failed or a guarded abort call settle)", "bgrunner", "    if (!active) return;\n    active = false;", "    active = false;"],
  ["bg R4: abort keeps inner running", "bgrunner", "    inner.abort();\n    settle(null);", "    settle(null);"],
  ["bg R4: abort does not settle", "bgrunner", "    inner.abort();\n    settle(null);", "    inner.abort();"],
  ["bg R4: abort unguarded (EQUIVALENT: settle has its own guard)", "bgrunner", "    if (!active) return;\n    inner.abort();", "    inner.abort();"],
  ["bg R5: inFlight always false", "bgrunner", "return active;", "return false;"],
  // ---- turn (§4 T1-T10 + constants) ----
  ["turn const: PARTIAL_MIN_NEW_WORDS 9", "turn", "PARTIAL_MIN_NEW_WORDS = 8;", "PARTIAL_MIN_NEW_WORDS = 9;"],
  ["turn const: PARTIAL_MAX_WAIT_MS 3500", "turn", "PARTIAL_MAX_WAIT_MS = 3000;", "PARTIAL_MAX_WAIT_MS = 3500;"],
  ["turn const: SILENCE_FIRST_MS 25000", "turn", "SILENCE_FIRST_MS = 20_000;", "SILENCE_FIRST_MS = 25_000;"],
  ["turn const: SILENCE_REPEAT_MS 15000", "turn", "SILENCE_REPEAT_MS = 10_000;", "SILENCE_REPEAT_MS = 15_000;"],
  ["turn const: SILENCE_MAX_PROMPTS 3", "turn", "SILENCE_MAX_PROMPTS = 2;", "SILENCE_MAX_PROMPTS = 3;"],
  ["turn const: CANVAS_IDLE_MS 5000", "turn", "CANVAS_IDLE_MS = 4000;", "CANVAS_IDLE_MS = 5000;"],
  ["turn const: CANVAS_MAX_CHARS 2000000", "turn", "CANVAS_MAX_CHARS = 1_500_000;", "CANVAS_MAX_CHARS = 2_000_000;"],
  ["turn hash: offset basis", "turn", "let h = 0x811c9dc5;", "let h = 0x811c9dc4;"],
  ["turn hash: no unsigned shift", "turn", "h = Math.imul(h, 0x01000193) >>> 0;", "h = Math.imul(h, 0x01000193);"],
  ["turn hash: no pad", "turn", 'return h.toString(16).padStart(8, "0");', "return h.toString(16);"],
  ["turn T1: no cap", "turn", "    if (prompts >= SILENCE_MAX_PROMPTS) {\n      return;\n    }\n", ""],
  ["turn T1: cap > not >=", "turn", "prompts >= SILENCE_MAX_PROMPTS", "prompts > SILENCE_MAX_PROMPTS"],
  ["turn T1: arm does not clear", "turn", "    deps.clearTimer(silenceTimer);\n    silenceTimer = null;\n    if (prompts", "    if (prompts"],
  ["turn T2: ignores idle (EQUIVALENT: the silence timer only exists while idle)", "turn", "if (disposed || !idle || since === null) return;", "if (disposed || since === null) return;"],
  ["turn T2: busy does not re-arm", "turn", "    if (busy) {\n      armSilence(SILENCE_REPEAT_MS);\n      return;\n    }", "    if (busy) {\n      return;\n    }"],
  ["turn T2: busy ignored", "turn", "    if (busy) {\n      armSilence(SILENCE_REPEAT_MS);\n      return;\n    }", ""],
  ["turn T2: ms = first", "turn", "Math.max(1, Math.round(deps.now() - since))", "SILENCE_FIRST_MS"],
  ["turn T2: send false does not re-arm", "turn", '      lastKind = "silence";\n    } else {\n      armSilence(SILENCE_REPEAT_MS);\n    }', '      lastKind = "silence";\n    }'],
  ["turn T2: send not busy", "turn", '      busy = true;\n      lastKind = "silence";', '      lastKind = "silence";'],
  ["turn T2: lastKind not silence", "turn", 'lastKind = "silence";', "lastKind = null;"],
  ["turn T3: flush ignores idle", "turn", "if (disposed || !idle || busy) return;", "if (disposed || busy) return;"],
  ["turn T3: flush ignores busy", "turn", "if (disposed || !idle || busy) return;", "if (disposed || !idle) return;"],
  ["turn T3: min words >", "turn", "latestWords - sentWords >= PARTIAL_MIN_NEW_WORDS", "latestWords - sentWords > PARTIAL_MIN_NEW_WORDS"],
  ["turn T3: wait >", "turn", "deps.now() - firstUnsentAt >= PARTIAL_MAX_WAIT_MS", "deps.now() - firstUnsentAt > PARTIAL_MAX_WAIT_MS"],
  ["turn T3: no wait path", "turn", "if (minNewReached || waitExpired) {", "if (minNewReached) {"],
  ["turn T3: partial no return", "turn", "          partialTimer = null;\n        }\n        return;\n      }", "          partialTimer = null;\n        }\n      }"],
  ["turn T3: partial not busy", "turn", '          busy = true;\n          lastKind = "partial";', '          lastKind = "partial";'],
  ["turn T3: sentWords not updated", "turn", "          sentWords = latestWords;\n", ""],
  ["turn T3: firstUnsentAt kept after send", "turn", "          firstUnsentAt = null;\n          deps.clearTimer(partialTimer);", "          deps.clearTimer(partialTimer);"],
  ["turn T3: partial timer kept after send", "turn", "          deps.clearTimer(partialTimer);\n          partialTimer = null;\n        }\n        return;", "          partialTimer = null;\n        }\n        return;"],
  ["turn T3: canvasDue not cleared", "turn", "      canvasDue = false;\n      const image = getImage();", "      const image = getImage();"],
  ["turn T3: no size cap", "turn", "image === null || image.length > CANVAS_MAX_CHARS", "image === null"],
  ["turn T3: size cap >=", "turn", "image.length > CANVAS_MAX_CHARS", "image.length >= CANVAS_MAX_CHARS"],
  ["turn T3: no dedup", "turn", "      if (h === lastHash) {\n        return;\n      }\n", ""],
  ["turn T3: lastHash not stored", "turn", "        lastHash = h;\n", ""],
  ["turn T3: canvas not busy", "turn", '        busy = true;\n        lastKind = "canvas";', '        lastKind = "canvas";'],
  ["turn T3: canvas send false not retried", "turn", "      } else {\n        canvasDue = true;\n      }", "      }"],
  ["turn T4: setIdle no since", "turn", "      idle = true;\n      since = deps.now();", "      idle = true;"],
  ["turn T4: setIdle no arm", "turn", "      since = deps.now();\n      armSilence(SILENCE_FIRST_MS);\n    } else if (!v && idle) {", "      since = deps.now();\n    } else if (!v && idle) {"],
  ["turn T4: setIdle(false) keeps timer", "turn", "      idle = false;\n      deps.clearTimer(silenceTimer);", "      idle = false;"],
  ["turn T4: setIdle(false) keeps since (EQUIVALENT: since is reset on idle)", "turn", "      since = null;\n    }\n    if (idle) {", "    }\n    if (idle) {"],
  ["turn T4: setIdle no flush", "turn", "    if (idle) {\n      flush();\n    }\n  }\n\n  // T5", "  }\n\n  // T5"],
  ["turn T5: prompts not reset", "turn", "    prompts = 0;\n    if (idle) {", "    if (idle) {"],
  ["turn T5: activity keeps since", "turn", "    if (idle) {\n      since = deps.now();\n      armSilence(SILENCE_FIRST_MS);\n    }\n  }\n\n  // T6", "    if (idle) {\n      armSilence(SILENCE_FIRST_MS);\n    }\n  }\n\n  // T6"],
  ["turn T5: activity no re-arm", "turn", "      since = deps.now();\n      armSilence(SILENCE_FIRST_MS);\n    }\n  }\n\n  // T6", "      since = deps.now();\n    }\n  }\n\n  // T6"],
  ["turn T6: no new-turn reset", "turn", "    if (w < sentWords) {\n      sentWords = 0;\n    }\n", ""],
  ["turn T6: partial no activity", "turn", "    latestWords = w;\n    activity();", "    latestWords = w;"],
  ["turn T6: firstUnsentAt not set", "turn", "      firstUnsentAt = deps.now();\n", ""],
  ["turn T6: timer restarts every partial", "turn", "if (w > sentWords && firstUnsentAt === null) {", "if (w > sentWords) {"],
  ["turn T6: no partial timer", "turn", "      partialTimer = deps.setTimer(() => {\n        partialTimer = null;\n        flush();\n      }, PARTIAL_MAX_WAIT_MS);", ""],
  ["turn T6: partial no flush", "turn", "    }\n    flush();\n  }\n\n  // T7", "    }\n  }\n\n  // T7"],
  ["turn T7: sentWords kept", "turn", "    sentWords = 0;\n    firstUnsentAt = null;\n    deps.clearTimer(partialTimer);", "    firstUnsentAt = null;\n    deps.clearTimer(partialTimer);"],
  ["turn T7: firstUnsentAt kept", "turn", "    firstUnsentAt = null;\n    deps.clearTimer(partialTimer);\n    partialTimer = null;\n    activity();", "    deps.clearTimer(partialTimer);\n    partialTimer = null;\n    activity();"],
  ["turn T7: latest kept (EQUIVALENT: latestWords=0 blocks the send; the next partial overwrites latest)", "turn", "    latest = null;\n    latestWords = 0;\n    sentWords = 0;", "    sentWords = 0;"],
  ["turn T7: no activity", "turn", "    partialTimer = null;\n    activity();\n  }\n\n  // T8", "    partialTimer = null;\n  }\n\n  // T8"],
  ["turn T8: canvasDue kept", "turn", "    getImage = g;\n    canvasDue = false;", "    getImage = g;"],
  ["turn T8: timer not restarted", "turn", "    deps.clearTimer(canvasTimer);\n    canvasTimer = deps.setTimer(", "    canvasTimer = deps.setTimer("],
  ["turn T8: no activity", "turn", "    }, CANVAS_IDLE_MS);\n    activity();", "    }, CANVAS_IDLE_MS);"],
  ["turn T9: no busy guard", "turn", "    if (!busy) return;\n    busy = false;", "    busy = false;"],
  ["turn T9: any spoken move counts", "turn", 'if (lastKind === "silence" && spoke) {', "if (spoke) {"],
  ["turn T9: silent silence counts", "turn", 'if (lastKind === "silence" && spoke) {', 'if (lastKind === "silence") {'],
  ["turn T9: spoke keeps since", "turn", "      if (spoke) {\n        since = deps.now();\n        armSilence(SILENCE_FIRST_MS);", "      if (spoke) {\n        armSilence(SILENCE_FIRST_MS);"],
  ["turn T9: spoke re-arms repeat", "turn", "        armSilence(SILENCE_FIRST_MS);\n      } else if", "        armSilence(SILENCE_REPEAT_MS);\n      } else if"],
  ["turn T9: not spoke no re-arm", "turn", "      } else if (silenceTimer === null && since !== null) {\n        armSilence(SILENCE_REPEAT_MS);\n      }", "      }"],
  ["turn T9: not spoke re-arms over a live timer", "turn", "} else if (silenceTimer === null && since !== null) {", "} else if (since !== null) {"],
  ["turn T9: no flush", "turn", "      }\n      flush();\n    }\n  }\n\n  // T10", "      }\n    }\n  }\n\n  // T10"],
  ["turn T10: not disposed", "turn", "    disposed = true;\n    idle = false;", "    idle = false;"],
  ["turn T10: partial timer kept", "turn", "    deps.clearTimer(partialTimer);\n    deps.clearTimer(silenceTimer);\n    deps.clearTimer(canvasTimer);", "    deps.clearTimer(silenceTimer);\n    deps.clearTimer(canvasTimer);"],
  ["turn T10: silence timer kept", "turn", "    deps.clearTimer(partialTimer);\n    deps.clearTimer(silenceTimer);\n    deps.clearTimer(canvasTimer);", "    deps.clearTimer(partialTimer);\n    deps.clearTimer(canvasTimer);"],
  ["turn T10: canvas timer kept", "turn", "    deps.clearTimer(partialTimer);\n    deps.clearTimer(silenceTimer);\n    deps.clearTimer(canvasTimer);", "    deps.clearTimer(partialTimer);\n    deps.clearTimer(silenceTimer);"],
  ["turn T10: settled after dispose (EQUIVALENT: dispose sets idle=false, so settled does nothing)", "turn", "    if (disposed) return;\n    if (!busy) return;", "    if (!busy) return;"],
  // ---- voice (§5 V1-V5) ----
  ["voice V1: interjection words 5", "voice", "INTERJECTION_BARGE_IN_WORDS = 4;", "INTERJECTION_BARGE_IN_WORDS = 5;"],
  ["voice V2: baseline ignored", "voice", `const threshold = ${B} === null ? BARGE_IN_MIN_WORDS : ${B} + INTERJECTION_BARGE_IN_WORDS;`, "const threshold = BARGE_IN_MIN_WORDS;"],
  ["voice V2: barge-in keeps baseline", "voice", `suppressed = true;\n                ${B} = null;`, "suppressed = true;"],
  ["voice V3: onTurnStart unguarded", "voice", "onTurnStart: () => {\n            if (disposed || gen !== generation) return;", "onTurnStart: () => {"],
  ["voice V3: onTurnStart no reset", "voice", `onTurnStart: () => {\n            if (disposed || gen !== generation) return;\n            if (${B} !== null) {\n              ${B} = 0;\n            }`, "onTurnStart: () => {\n            if (disposed || gen !== generation) return;"],
  ["voice V3: onTurnStart resets when null", "voice", `onTurnStart: () => {\n            if (disposed || gen !== generation) return;\n            if (${B} !== null) {\n              ${B} = 0;\n            }`, `onTurnStart: () => {\n            if (disposed || gen !== generation) return;\n            ${B} = 0;`],
  ["voice V3: onTurnComplete no reset", "voice", `            if (${B} !== null) {\n              ${B} = 0;\n            }\n            updateSnapshot({ partial: null });`, "            updateSnapshot({ partial: null });"],
  ["voice V3: onTurnComplete reset before guard", "voice",
    `onTurnComplete: (_turnId: string, text: string) => {\n            if (disposed || gen !== generation) return;\n            if (${B} !== null) {\n              ${B} = 0;\n            }`,
    `onTurnComplete: (_turnId: string, text: string) => {\n            if (${B} !== null) {\n              ${B} = 0;\n            }\n            if (disposed || gen !== generation) return;`],
  ["voice V4: request keeps baseline", "voice", `        suppressed = false;\n        ${B} = null;\n        break;\n\n      case "token":`, '        suppressed = false;\n        break;\n\n      case "token":'],
  ["voice V4: bg_move silent acts", "voice", '        if (action.move.type === "silent") {\n          // do nothing\n          break;\n        }\n', ""],
  ["voice V4: bg_move no tts.stop", "voice", '        tts.stop();\n        chunker.reset();\n        suppressed = false;\n        if (action.move.type === "realign")', '        chunker.reset();\n        suppressed = false;\n        if (action.move.type === "realign")'],
  ["voice V4: bg_move no chunker reset", "voice", '        chunker.reset();\n        suppressed = false;\n        if (action.move.type === "realign")', '        suppressed = false;\n        if (action.move.type === "realign")'],
  ["voice V4: bg_move keeps suppression", "voice", '        suppressed = false;\n        if (action.move.type === "realign")', '        if (action.move.type === "realign")'],
  ["voice V4: bg_move hint sets baseline", "voice", 'if (action.move.type === "realign") {', "if (true) {"],
  ["voice V4: bg_move baseline 0", "voice", `${B} = partialText.trim().split(/\\s+/).filter(Boolean).length;`, `${B} = 0;`],
  ["voice V4: bg_move hint keeps old baseline", "voice", `        } else {\n          ${B} = null;\n        }`, "        }"],
  ["voice V4: bg_failed no chunker reset", "voice", 'case "bg_failed":\n        chunker.reset();', 'case "bg_failed":'],
  ["voice V4: bg_failed keeps baseline", "voice", `case "bg_failed":\n        chunker.reset();\n        ${B} = null;`, 'case "bg_failed":\n        chunker.reset();'],
  ["voice V4: bg_request stops tts", "voice", 'case "bg_request":\n        // do nothing, and in particular don\'t stop the TTS\n        break;', 'case "bg_request":\n        tts.stop();\n        break;'],
  ["voice V5: disable keeps baseline", "voice", `    tts.stop();\n    ${B} = null;\n  }`, "    tts.stop();\n  }"],
];

if (process.argv.includes("--list")) {
  for (const g of Object.keys(F)) console.log(`${g}: ${M.filter((m) => m[1] === g).length}`);
  process.exit(0);
}
if (process.argv.includes("--restore")) {
  let n = 0;
  for (const [k, v] of Object.entries(F)) if (existsSync(join(bdir, k))) { writeFileSync(v.path, readFileSync(join(bdir, k))); n++; }
  for (const f of readdirSync(join(repo, "tests"))) if (f.startsWith("s8rev-")) rmSync(join(repo, "tests", f));
  console.log(`restored ${n} file(s) from ${bdir}`); process.exit(0);
}

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const groups = only.length ? only : Object.keys(F);
const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8);
const orig = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, readFileSync(v.path)]));
mkdirSync(bdir, { recursive: true });
for (const k of Object.keys(F)) writeFileSync(join(bdir, k), orig[k]);
const copies = [];
if (reviewer && existsSync(revDir)) {
  for (const f of readdirSync(revDir).filter((n) => n.endsWith(".test.ts.txt"))) {
    const dest = join(repo, "tests", "s8rev-" + f.replace(/\.txt$/, ""));
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
const selected = M.filter(([label, key]) => groups.includes(key) && (!labelFilter || label.includes(labelFilter)));
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
