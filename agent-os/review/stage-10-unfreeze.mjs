// Stage 10 unfrozen-file edits (brief §2, §6, §7). From the repo root:
//   node agent-os/review/stage-10-unfreeze.mjs           reverse the edits in memory; each file must give its pre-stage hash
//   node agent-os/review/stage-10-unfreeze.mjs --forward apply the edits in memory to the pre-stage files; print expected hashes
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
export const EDITS = {
  "src/client/voice/browser-audio.ts": {
    pre: "9e74711f",
    edits: [
      ["let workletLoaded = false;\n", "let workletLoaded = false;\nlet playbackTap: AudioNode | null = null;\n\n/** Stage 10 recording: TTS playback is also routed into this node while it's set. */\nexport function setPlaybackTap(node: AudioNode | null): void {\n  playbackTap = node;\n}\n"],
      ["      source.connect(getAudioContext().destination);\n", "      source.connect(getAudioContext().destination);\n      if (playbackTap) source.connect(playbackTap);\n"],
    ],
  },
  "src/app/page.tsx": {
    pre: "2ca9dfa5",
    edits: [["Text mode. Voice and whiteboard are coming soon.", "You can choose to record the interview on the next screen."]],
  },
  "src/app/interview/page.tsx": {
    pre: "5d3f77bd",
    edits: [
      ['import InterviewScreen from "./InterviewScreen";\n', 'import InterviewGate from "./InterviewGate";\n'],
      ["return <InterviewScreen config={publicConfig} styleId={styleId} />;", "return <InterviewGate config={publicConfig} styleId={styleId} />;"],
    ],
  },
  "src/app/interview/InterviewScreen.tsx": {
    pre: "ee37d724",
    edits: [
      ['import FeedbackPanel from "./FeedbackPanel";\n', 'import FeedbackPanel from "./FeedbackPanel";\nimport RecordingBadge from "./RecordingBadge";\nimport RecordingDownloads from "./RecordingDownloads";\n'],
      ['import type { PublicConfig } from "@/config/public";\n', 'import type { PublicConfig } from "@/config/public";\nimport type { RecordingSession } from "@/client/recording/recording-session";\n'],
      ["  styleId: string;\n}\n", "  styleId: string;\n  recording?: RecordingSession | null;\n}\n"],
      ["export default function InterviewScreen({ config, styleId }: InterviewScreenProps) {", "export default function InterviewScreen({ config, styleId, recording = null }: InterviewScreenProps) {"],
      ['        <div className="flex items-center gap-4">\n          {view.engine && (\n', '        <div className="flex items-center gap-4">\n          {recording && <RecordingBadge session={recording} />}\n          {view.engine && (\n'],
      ["          {view.engine && <FeedbackPanel state={view.engine} />}\n", "          {view.engine && <FeedbackPanel state={view.engine} />}\n          {recording && <RecordingDownloads session={recording} />}\n"],
    ],
  },
};
const forward = process.argv.includes("--forward");
for (const [path, { pre, edits }] of Object.entries(EDITS)) {
  let s = readFileSync(path, "utf8");
  if (s.includes("\r\n")) { console.log(`${path}: CRLF line endings; anchors assume LF`); continue; }
  let ok = true;
  for (const [a, b] of edits) {
    const [from, to] = forward ? [a, b] : [b, a];
    const n = s.split(from).length - 1;
    if (n !== 1) { ok = false; console.log(`${path}: anchor found ${n}x: ${JSON.stringify(from.slice(0, 60))}`); continue; }
    s = s.replace(from, to);
  }
  console.log(forward ? `${path}: now ${h(readFileSync(path))}, after edits ${h(s)}${ok ? "" : " (INCOMPLETE)"}` : `${path}: reversed ${h(s)} (want ${pre})${ok ? "" : " (INCOMPLETE)"}`);
}
