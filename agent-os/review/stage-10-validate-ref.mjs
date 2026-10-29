// Verify the Stage 10 reviewer test files before handing them to the builder.
//   node agent-os/review/stage-10-validate-ref.mjs [--lint] [--tsc]
// - recording-session / recording-format tests run against agent-os/review/stage-10-ref/*.ts
// - recording-tap runs against src/client/voice/browser-audio.ts with the brief's §2 edits applied
//   temporarily (backup in os.tmpdir()/interim-review/backup-s10-tap; restored and hash-checked).
// After the builder's round, use: node agent-os/review/stage-10-validate-ref.mjs --src  (runs all 3 against src, no edits)
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const src = process.argv.includes("--src");
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
const ba = join(repo, "src/client/voice/browser-audio.ts");
const baOrig = readFileSync(ba);
const bak = join(tmpdir(), "interim-review"); mkdirSync(bak, { recursive: true });
writeFileSync(join(bak, "backup-s10-tap"), baOrig);
export const TAP_EDITS = [
  ["let workletLoaded = false;\n", "let workletLoaded = false;\nlet playbackTap: AudioNode | null = null;\n\n/** Stage 10 recording: TTS playback is also routed into this node while it's set. */\nexport function setPlaybackTap(node: AudioNode | null): void {\n  playbackTap = node;\n}\n"],
  ["      source.connect(getAudioContext().destination);\n", "      source.connect(getAudioContext().destination);\n      if (playbackTap) source.connect(playbackTap);\n"],
];
const copies = [];
const put = (name, text) => { const p = join(repo, "tests", `s10ref-${name}.test.ts`); writeFileSync(p, text); copies.push(p); return `tests/s10ref-${name}.test.ts`; };
const restore = () => { writeFileSync(ba, baOrig); for (const c of copies) if (existsSync(c)) rmSync(c); };
process.on("exit", restore);

const files = [];
// Since round 1 the tap edits are in src: in ref mode, recording-tap is skipped (it runs with --src).
const tapInSrc = baOrig.toString("utf8").includes("setPlaybackTap");
for (const n of ["recording-session", "recording-format", "recording-tap", "recording-review"]) {
  if (!src && n === "recording-tap" && tapInSrc) continue;
  let t = readFileSync(join(repo, "agent-os/review/stage-10-tests", `${n}.test.ts.txt`), "utf8");
  if (!src && n !== "recording-tap") t = t.replaceAll("@/client/recording/", "../agent-os/review/stage-10-ref/");
  files.push(put(n, t));
}
if (!src && !tapInSrc) {
  let s = baOrig.toString("utf8");
  for (const [a, b] of TAP_EDITS) { if (s.split(a).length !== 2) { console.log("TAP anchor not unique:", a); process.exit(1); } s = s.replace(a, b); }
  writeFileSync(ba, s);
  console.log(`browser-audio ${h(baOrig)} -> with tap edits ${h(s)}`);
}
const run = (cmd) => {
  try { return { code: 0, out: execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
};
const v = run(`npx vitest run ${files.join(" ")}`);
console.log(`vitest exit ${v.code}`);
for (const l of v.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) if (/^\s*(×|FAIL)|Tests\s|Errors|Unhandled|AssertionError|Expected|Received|^\s+[-+] /.test(l)) console.log(l.slice(0, 200));
if (process.argv.includes("--lint")) { const r = run(`npx eslint --max-warnings=0 ${files.join(" ")} agent-os/review/stage-10-ref`); console.log(`eslint exit ${r.code}`); if (r.code) console.log(r.out.slice(0, 3000)); }
restore();
console.log(`restored browser-audio ${h(readFileSync(ba))}`);
