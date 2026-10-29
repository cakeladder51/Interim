// Stage 9 offline probe (localhost only). Run from the repo root: node agent-os/review/stage-09-offline.mjs
// next dev + INTERIM_FAKE_MODEL=1: done state -> fake report (modelLabel "fake"); unfinished -> 400 not_finished;
//   no student lines -> noAnswerView + modelLabel "fake".
// next start + INTERIM_FAKE_MODEL=1 (production): ONLY paths that never call the model (.env.local may hold a real key):
//   no student lines -> noAnswerView WITHOUT modelLabel (proves the fake deps are not selected); unfinished -> 400.
// Servers are killed by PID tree only.
import { spawn, execSync } from "node:child_process";

const T = [
  { id: "e1", at: 0, speaker: "interviewer", kind: "utterance", text: "Welcome. Let's begin." },
  { id: "e2", at: 5000, speaker: "student", kind: "typed", text: "I think   the answer is\nroot two" },
  { id: "e3", at: 5000, speaker: "interviewer", kind: "utterance", text: "Why is that?" },
];
const base = { version: 1, configId: "maths-oxbridge", styleId: "supportive", startedAt: 1000, phase: "done", problemIdx: 0, hintRung: -1, checkpointsHit: [], lastInterjectAt: null, turnWordBaseline: 0, probesAsked: 0, transcript: T };
const done = base, unfinished = { ...base, phase: "problem" }, noAnswer = { ...base, transcript: [T[0]] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(port, state) {
  const r = await fetch(`http://localhost:${port}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
  const b = await r.json();
  return { status: r.status, cache: r.headers.get("cache-control"), b };
}
async function withServer(args, port, env, fn) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", ...args, "-p", String(port)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 120; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(1000); } }
    await fn();
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
    const leaks = ["root two", "Welcome. Let", "MODEL_API_KEY"].filter((s) => log.includes(s));
    console.log(`  server log leaks: ${leaks.length ? leaks.join(", ") : "none"}; warn lines: ${(log.match(/feedback failed.*/g) ?? []).join(" | ") || "none"}`);
  }
}
const show = (name, r, extra = "") => console.log(`${name}: ${r.status} cache=${r.cache} ${extra}`);

console.log("next dev (INTERIM_FAKE_MODEL=1)");
await withServer(["dev"], 3109, { INTERIM_FAKE_MODEL: "1" }, async () => {
  const a = await post(3109, done);
  show("  done", a, `modelLabel=${a.b.modelLabel} summary=${JSON.stringify(a.b.summary)} scores=${a.b.criteria?.map((c) => c.score).join("")} moments=${JSON.stringify(a.b.keyMoments)}`);
  const b = await post(3109, unfinished); show("  unfinished", b, JSON.stringify(b.b));
  const c = await post(3109, noAnswer); show("  no answer", c, `modelLabel=${c.b.modelLabel} scores=${c.b.criteria?.map((x) => x.score).join("")}`);
});
console.log("next start (INTERIM_FAKE_MODEL=1, production)");
await withServer(["start"], 3110, { INTERIM_FAKE_MODEL: "1" }, async () => {
  const c = await post(3110, noAnswer); show("  no answer", c, `modelLabel=${c.b.modelLabel} (want undefined)`);
  const b = await post(3110, unfinished); show("  unfinished", b, JSON.stringify(b.b));
});
