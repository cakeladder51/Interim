// Recover pre-Stage-8 sources from .next dev source maps (sourcesContent) and check their hashes.
// Writes matches to %TEMP%/interim-review/s8-pristine/<name> for diffing.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const repo = "D:/CodeFiles/Interim";
const outDir = join(process.env.TEMP ?? "C:/Temp", "interim-review", "s8-pristine");
mkdirSync(outDir, { recursive: true });
const want = {
  "voice-controller.ts": "ed6ccd4f",
  "use-interview.ts": "fc6ddf83",
  "InterviewScreen.tsx": "921eb254",
  "interview-model.ts": "5baca0e9",
};
const maps = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".map")) maps.push(p);
  }
};
walk(join(repo, ".next"));
const found = {};
for (const m of maps) {
  let j;
  try {
    j = JSON.parse(readFileSync(m, "utf8"));
  } catch {
    continue;
  }
  const sections = j.sections ? j.sections.map((s) => s.map) : [j];
  for (const sec of sections) {
    (sec.sources ?? []).forEach((src, i) => {
      const name = Object.keys(want).find((n) => src.endsWith("/" + n));
      const content = sec.sourcesContent?.[i];
      if (!name || typeof content !== "string") return;
      for (const c of [content, content.replace(/\r?\n/g, "\r\n"), content.replace(/\r\n/g, "\n")]) {
        const h = createHash("sha256").update(c).digest("hex").slice(0, 8);
        if (h === want[name] && !found[name]) {
          found[name] = true;
          writeFileSync(join(outDir, name), c);
        }
      }
    });
  }
}
for (const n of Object.keys(want)) console.log(n, found[n] ? "recovered " + want[n] : "not recovered");
