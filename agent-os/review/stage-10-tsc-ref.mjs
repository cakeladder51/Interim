// Type-check the Stage 10 reviewer tests against the reference interfaces: temporarily places
// stage-10-ref/*.ts in src/client/recording/, applies the browser-audio tap edits, runs tsc, restores.
// Refuses to run once the builder has created src/client/recording or the test files.
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
const ba = "src/client/voice/browser-audio.ts";
const baOrig = readFileSync(ba);
if (existsSync("src/client/recording")) { console.log("src/client/recording exists; refusing"); process.exit(1); }
const made = [];
const cleanup = () => { writeFileSync(ba, baOrig); for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true }); };
process.on("exit", cleanup);
const tests = ["recording-session", "recording-format", "recording-tap"];
for (const n of tests) if (existsSync(`tests/${n}.test.ts`)) { console.log(`tests/${n}.test.ts exists; refusing`); process.exit(1); }
mkdirSync("src/client/recording"); made.push("src/client/recording");
for (const f of ["recording-session.ts", "recording-format.ts"]) writeFileSync(`src/client/recording/${f}`, readFileSync(`agent-os/review/stage-10-ref/${f}`));
for (const n of tests) { const p = `tests/${n}.test.ts`; writeFileSync(p, readFileSync(`agent-os/review/stage-10-tests/${n}.test.ts.txt`)); made.push(p); }
let s = baOrig.toString("utf8");
s = s.replace("let workletLoaded = false;\n", "let workletLoaded = false;\nlet playbackTap: AudioNode | null = null;\n\n/** Stage 10 recording: TTS playback is also routed into this node while it's set. */\nexport function setPlaybackTap(node: AudioNode | null): void {\n  playbackTap = node;\n}\n");
s = s.replace("      source.connect(getAudioContext().destination);\n", "      source.connect(getAudioContext().destination);\n      if (playbackTap) source.connect(playbackTap);\n");
writeFileSync(ba, s);
let out = "";
try { execSync("npx tsc --noEmit", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); out = "tsc exit 0"; }
catch (e) { out = "tsc errors:\n" + (e.stdout ?? "").split("\n").slice(0, 30).join("\n"); }
cleanup();
console.log(out);
console.log(`restored browser-audio ${h(readFileSync(ba))}; recording dir gone: ${!existsSync("src/client/recording")}`);
