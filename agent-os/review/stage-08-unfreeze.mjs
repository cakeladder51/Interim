// Reverse the Stage 8 §1 edits to interview-model.ts in memory; the hash must return to 5baca0e9.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const repo = "D:/CodeFiles/Interim";
let s = readFileSync(`${repo}/src/client/interview-model.ts`, "utf8");
const eol = s.includes("\r\n") ? "\r\n" : "\n";
s = s.replace(/\r\n/g, "\n");
const cut = (a, b = "") => {
  if (!s.includes(a)) {
    console.log("NOT FOUND:", JSON.stringify(a.slice(0, 60)));
    return;
  }
  s = s.replace(a, b);
};
cut("import type { EngineEvent, EngineState,", "import type { EngineState,");
cut('\nexport type BackgroundEvent = Extract<EngineEvent, { type: "partial" | "silence" | "canvas" }>;\n');
cut('  background: "none" | "pending" | "speaking";\n');
cut('label: string }\n  | { type: "bg_request"; request: StepRequest }\n  | { type: "bg_move"; move: Move }\n  | { type: "bg_failed" };', "label: string };");
cut('  background: "none",\n};', "};");
cut('        lastRequest: { request: action.request, studentText: action.studentText },\n        background: "none",\n', "        lastRequest: { request: action.request, studentText: action.studentText },\n");
cut('        status: newStatus,\n        background: "none",\n', "        status: newStatus,\n");
const bgCases = s.indexOf('    case "bg_request":');
const endSwitch = s.indexOf("  }\n}\n", bgCases);
if (bgCases > 0 && endSwitch > 0) s = s.slice(0, bgCases) + s.slice(endSwitch);
else console.log("NOT FOUND: bg cases");
const bb = s.indexOf("/**\n * Build a background step request");
const vt = s.indexOf("/**\n * Visible transcript entries");
if (bb > 0 && vt > bb) s = s.slice(0, bb) + s.slice(vt);
else console.log("NOT FOUND: bg builders");
const out = s.replace(/\n/g, eol);
console.log("interview-model reversed:", createHash("sha256").update(out).digest("hex").slice(0, 8), "(want 5baca0e9)");

// voice-controller: reverse §5 (V1-V5); try the plausible original onTurnStart forms.
let v = readFileSync(`${repo}/src/client/voice/voice-controller.ts`, "utf8");
const veol = v.includes("\r\n") ? "\r\n" : "\n";
v = v.replace(/\r\n/g, "\n");
const vcut = (a, b = "") => {
  if (!v.includes(a)) console.log("VC NOT FOUND:", JSON.stringify(a.slice(0, 60)));
  v = v.replace(a, b);
};
vcut("export const INTERJECTION_BARGE_IN_WORDS = 4;\n");
vcut("  let interjectBaseline: number | null = null;\n");
vcut("              const threshold = interjectBaseline === null ? BARGE_IN_MIN_WORDS : interjectBaseline + INTERJECTION_BARGE_IN_WORDS;\n              if (wordCount >= threshold) {", "              if (wordCount >= BARGE_IN_MIN_WORDS) {");
vcut("                suppressed = true;\n                interjectBaseline = null;\n", "                suppressed = true;\n");
const baseReset = "            if (interjectBaseline !== null) {\n              interjectBaseline = 0;\n            }\n";
vcut("            if (disposed || gen !== generation) return;\n" + baseReset + "            updateSnapshot({ partial: null });", "            if (disposed || gen !== generation) return;\n            updateSnapshot({ partial: null });");
vcut("    tts.stop();\n    interjectBaseline = null;\n  }", "    tts.stop();\n  }");
vcut("        suppressed = false;\n        interjectBaseline = null;\n        break;", "        suppressed = false;\n        break;");
const extraFailed = "        chunker.reset();\n        interjectBaseline = null;\n        break;\n\n      case \"bg_move\":";
vcut(extraFailed, "        chunker.reset();\n        break;\n\n      case \"bg_move\":");
const bm = v.indexOf('      case "bg_move":');
const df = v.indexOf("      default:", bm);
if (bm > 0 && df > bm) v = v.slice(0, bm) + v.slice(df);
else console.log("VC NOT FOUND: bg cases");
const tsStart = "          onTurnStart: () => {\n            if (disposed || gen !== generation) return;\n" + baseReset + "          },\n";
const variants = {
  absent: "",
  empty: "          onTurnStart: () => {},\n",
  emptyBlock: "          onTurnStart: () => {\n          },\n",
  guardOnly: "          onTurnStart: () => {\n            if (disposed || gen !== generation) return;\n          },\n",
  comment: "          onTurnStart: () => {\n            // no-op\n          },\n",
};
if (!v.includes(tsStart)) console.log("VC NOT FOUND: onTurnStart block");
for (const [k, rep] of Object.entries(variants)) {
  const o = v.replace(tsStart, rep).replace(/\n/g, veol);
  console.log("voice-controller reversed (" + k + "):", createHash("sha256").update(o).digest("hex").slice(0, 8), "(want ed6ccd4f)");
}
// Show the reversed onTurnStart region for a manual look if no variant matches
if (process.argv.includes("--show")) {
  const i = v.indexOf("onTurnStart");
  console.log(v.slice(i - 200, i + 200));
}
