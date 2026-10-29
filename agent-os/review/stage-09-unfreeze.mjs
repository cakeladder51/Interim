// Stage 9: reverse the 3 §7 InterviewScreen edits in memory (expect 0789eeab) and
// byte-compare the reviewer test copies (Stage 7 + Stage 8) with tests/.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
let s = readFileSync("src/app/interview/InterviewScreen.tsx", "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const edits = [
  ['import Scratchpad from "./Scratchpad";' + nl + 'import FeedbackPanel from "./FeedbackPanel";', 'import Scratchpad from "./Scratchpad";'],
  ['"border-t p-6 flex flex-col items-center gap-4 overflow-y-auto max-h-[70vh]"', '"border-t p-6 flex flex-col items-center justify-center"'],
  ["{view.engine && <FeedbackPanel state={view.engine} />}", '<p className="text-sm opacity-60 mb-4">Your feedback report is coming in a later stage.</p>'],
];
for (const [a, b] of edits) { console.log("occurrences", s.split(a).length - 1); s = s.replace(a, b); }
console.log("reversed InterviewScreen hash", h(s), "(want 0789eeab)");
for (const d of ["stage-07-tests", "stage-08-tests"]) for (const f of readdirSync("agent-os/review/" + d)) {
  if (!f.endsWith(".test.ts.txt")) continue;
  const t = "tests/" + f.replace(/\.txt$/, "");
  try { console.log(d, f, readFileSync(t).equals(readFileSync("agent-os/review/" + d + "/" + f)) ? "IDENTICAL" : "DIFFERS"); } catch { console.log(d, f, "missing target"); }
}
