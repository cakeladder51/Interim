// Stage 10 offline checks (no model is ever called):
//  1. next build (keys removed from env), then scan .next/static + prerendered output for secret config text,
//     Stage 4/9 prompt strings, with positive controls that must be found.
//  2. next dev (INTERIM_FAKE_MODEL=1): GET / and GET /interview show the Stage 10 text; the gate is shown first.
// Servers are killed by PID tree only.  Run: node agent-os/review/stage-10-offline.mjs
import { spawn, spawnSync, execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = "D:/CodeFiles/Interim";
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
for (const k of ["MODEL_API_KEY", "OPENAI_API_KEY", "RELAY_SECRET"]) delete env[k];
const next = join(repo, "node_modules/next/dist/bin/next");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = spawnSync(process.execPath, [next, "build"], { cwd: repo, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
console.log(`next build exit=${b.status}`);

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const secrets = new Map();
for (const id of ["maths-oxbridge", "cs-oxbridge"]) {
  const c = JSON.parse(readFileSync(`${repo}/configs/${id}.json`, "utf8"));
  for (const p of c.problems) {
    secrets.set(p.solutionSketch.slice(0, 40), `${id}/${p.id} solutionSketch`);
    p.hintLadder.forEach((h, i) => secrets.set(h.slice(0, 40), `${id}/${p.id} hint ${i}`));
    p.probes.forEach((h, i) => secrets.set(h.slice(0, 40), `${id}/${p.id} probe ${i}`));
    p.checkpoints.forEach((x) => secrets.set(x.description.slice(0, 40), `${id}/${p.id} checkpoint ${x.id}`));
    p.misconceptions.forEach((m) => {
      secrets.set(m.id, `${id}/${p.id} misconception id`);
      secrets.set(m.signal.slice(0, 40), `${id}/${p.id} misconception signal`);
      secrets.set(m.realign.slice(0, 40), `${id}/${p.id} realign`);
    });
  }
  secrets.set(c.fallbackPrompt.slice(0, 40), `${id} fallbackPrompt`);
}
for (const s of ["Model solution", "You are the silent assessor", "admissions interviewer writing feedback", "Return a JSON object with"]) secrets.set(s, "prompt text");
const controls = ["Before you start", "Saving your recording", "Preparing your feedback"];
const variants = (s) => [s, JSON.stringify(s).slice(1, -1), s.replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))];
const targets = walk(`${repo}/.next/static`);
const appDir = `${repo}/.next/server/app`;
if (existsSync(appDir)) targets.push(...walk(appDir).filter((p) => /\.(html|rsc|body|meta)$/.test(p)));
let hits = 0;
const found = new Set();
for (const f of targets) {
  const text = readFileSync(f, "utf8");
  for (const [needle, label] of secrets) if (variants(needle).some((v) => text.includes(v))) { hits++; console.log(`LEAK ${label} in ${f.replace(repo + "/", "")}`); }
  for (const c of controls) if (f.includes(".next/static") || f.includes(".next\\static")) if (text.includes(c)) found.add(c);
}
console.log(`scanned ${targets.length} files for ${secrets.size} secret strings -> ${hits} hit(s); controls found in static: ${[...found].join(", ") || "NONE"}`);

const port = 3111;
const child = spawn(process.execPath, [next, "dev", "-p", String(port)], { cwd: repo, env: { ...env, INTERIM_FAKE_MODEL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
try {
  for (let i = 0; i < 120; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(1000); } }
  const home = await (await fetch(`http://localhost:${port}/`)).text();
  console.log(`GET /: new text=${home.includes("You can choose to record the interview on the next screen.")} old text=${home.includes("Voice and whiteboard are coming soon")}`);
  const r = await fetch(`http://localhost:${port}/interview?config=maths-oxbridge&style=supportive`);
  const html = await r.text();
  console.log(`GET /interview: ${r.status} gate=${html.includes("Before you start")} startBtn=${html.includes("Start interview")} checkboxes=${(html.match(/type="checkbox"/g) ?? []).length} endBtn=${/>End</.test(html)}`);
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  const errs = (log.match(/(Error|⨯).*/g) ?? []).slice(0, 3);
  console.log(`dev log errors: ${errs.length ? errs.join(" | ") : "none"}`);
}
