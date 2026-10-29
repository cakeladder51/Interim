// Stage 8 brief vectors: run background events through the frozen step handler + offline fake model.
// Run: npx tsx --conditions=react-server agent-os/review/stage-08-vectors.ts
import { createStepHandler } from "../../src/server/step-handler";
import { fakeAssess, fakeSpeak } from "../../src/server/fake-model";
import { runStepRequest } from "../../src/client/step-client";
import type { EngineEvent, EngineState, StepRequest } from "../../src/contracts";

let t = 1_000_000;
const handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now: () => t });
const fetchImpl = (url: string, init?: RequestInit) => handler(new Request("http://test" + url, init));

async function step(state: EngineState | null, event: EngineEvent) {
  const request = { state, event } as StepRequest;
  let interrupt = false;
  const r = await runStepRequest(request, {
    fetchImpl,
    callbacks: { onMove: (_m, i) => { interrupt = i; }, onToken: () => {}, onModelLabel: () => {} },
  });
  return { ...r, interrupt };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const show = (label: string, r: Awaited<ReturnType<typeof step>>) => {
  const last = r.state.transcript[r.state.transcript.length - 1];
  console.log(label, JSON.stringify({ move: r.move, interrupt: r.interrupt, lastInterjectAt: r.state.lastInterjectAt, turnWordBaseline: r.state.turnWordBaseline, hintRung: r.state.hintRung, n: r.state.transcript.length, lastKind: last?.kind, lastSpeaker: last?.speaker, utterWords: words(r.utterance) }));
};

async function main() {
for (const styleId of ["supportive", "rigorous"]) {
  t = 1_000_000;
  const s0 = (await step(null, { type: "start", configId: "maths-oxbridge", styleId })).state;
  t += 5000;
  const p11 = "I think the answer is wrong because two is not a perfect square here";
  const p7 = "I think this is wrong because two";
  console.log(styleId, "p11 words", words(p11), "p7 words", words(p7));
  show(`${styleId} partial p7`, await step(s0, { type: "partial", text: p7 }));
  const r1 = await step(s0, { type: "partial", text: p11 });
  show(`${styleId} partial p11`, r1);
  t += 1000;
  show(`${styleId} partial p11+3 during cooldown`, await step(r1.state, { type: "partial", text: p11 + " so it is irrational" }));
  show(`${styleId} canvas`, await step(s0, { type: "canvas", image: "data:image/png;base64,iVBORw0KGgo=" }));
  show(`${styleId} silence 10000`, await step(s0, { type: "silence", ms: 10000 }));
  const sil = await step(s0, { type: "silence", ms: 20000 });
  show(`${styleId} silence 20000`, sil);
}
}
void main();
