// Reviewer check for the Stage 9 e2e row: start -> "I don't know" -> end through the frozen engine + fake model,
// then the reference fake report/view. Run: npx tsx --conditions=react-server agent-os/review/stage-09-vectors.ts
import { createStepHandler } from "../../src/server/step-handler";
import { fakeAssess, fakeSpeak } from "../../src/server/fake-model";
import { runStepRequest } from "../../src/client/step-client";
import { getConfig } from "../../src/config/load";
import type { EngineEvent, EngineState } from "../../src/contracts";
// @ts-expect-error plain .mjs reference without types
import { fakeReport, toFeedbackView } from "./stage-09-ref.mjs";

let t = 1_000_000;
const handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now: () => t });
async function step(state: EngineState | null, event: EngineEvent): Promise<EngineState> {
  const r = await runStepRequest({ state, event } as never, {
    fetchImpl: (url, init) => handler(new Request("http://test" + String(url), init)),
    callbacks: {},
  });
  return r.state;
}

async function main() {
  let s = await step(null, { type: "start", configId: "maths-oxbridge", styleId: "supportive" });
  t = 1_010_000;
  s = await step(s, { type: "turn_complete", text: "I don't know", source: "typed" });
  t = 1_020_000;
  s = await step(s, { type: "end" });
  console.log("phase", s.phase, "entries", s.transcript.map((e) => `${e.speaker}/${e.kind}@${e.at}`).join(" "));
  const config = getConfig("maths-oxbridge");
  console.log("view", JSON.stringify(toFeedbackView(config, s, fakeReport(config, s))));
}
void main();
