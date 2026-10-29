// Sanity reverts against the Stage 10 reference (proves the reviewer tests can fail). Restores the ref file.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const p = "agent-os/review/stage-10-ref/recording-session.ts";
const orig = readFileSync(p, "utf8");
const M = [
  ["mic requested before tab", "    const tabP = choice.video ? call(deps.getTab) : null;\n    const micP = call(deps.getMic);", "    const micP = call(deps.getMic);\n    const tabP = choice.video ? call(deps.getTab) : null;"],
  ["tab awaited before mic", "    const micP = call(deps.getMic);", "    if (tabP) await tabP.catch(() => null);\n    const micP = call(deps.getMic);"],
  ["no timeslice", "recorder.start(RECORDER_TIMESLICE_MS);", "recorder.start(0);"],
  ["S7 keeps mic", "      stopTracks(tab); stopTracks(mic); mixer?.dispose();\n      tab = null;", "      mixer?.dispose();\n      tab = null;"],
  ["empty chunks counted", "if (e.data.size > 0) chunks.push(e.data);", "chunks.push(e.data);"],
  ["Stop sharing ignored", 'if (t.kind === "video") t.addEventListener', 'if (t.kind === "none") t.addEventListener'],
  ["dispose keeps URLs", "      for (const f of snap.files) deps.revokeObjectURL(f.url);\n", ""],
];
let caught = 0;
try {
  for (const [label, a, b] of M) {
    if (orig.split(a).length !== 2) { console.log(`SKIPPED: ${label}`); continue; }
    writeFileSync(p, orig.replace(a, b));
    let out = "";
    try { out = execSync("node agent-os/review/stage-10-validate-ref.mjs", { encoding: "utf8" }); } catch (e) { out = e.stdout ?? ""; }
    if (/vitest exit [1-9]/.test(out)) caught++; else console.log(`MISSED: ${label}`);
  }
} finally { writeFileSync(p, orig); }
console.log(`caught ${caught}/${M.length}; ref restored: ${readFileSync(p, "utf8") === orig}`);
