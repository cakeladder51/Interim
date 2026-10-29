// Replicates tests/step-route.test.ts "step-handler abort mid-speak" N times under CPU load and prints the
// event sequence whenever more than 3 events arrive. Run from repo root:
//   npx tsx --conditions=react-server agent-os/review/step-abort-probe.ts
import { Worker } from "node:worker_threads";
import { createStepHandler } from "@/server/step-handler";
import { parseSSE, type StepStreamEvent, type Assessment } from "@/contracts";
import { createInitialState } from "@/engine/state";
import { getConfig } from "@/config/load";

const burners = [0, 1, 2].map(() => new Worker("const e=Date.now()+60000; while(Date.now()<e){}", { eval: true }));

async function once(): Promise<string[]> {
  const controller = new AbortController();
  const handler = createStepHandler({
    assess: async () => ({ status: "progressing", confidence: 0.5, checkpointsHit: [], misconceptionId: null, evidence: "test" }) as Assessment,
    speak: async function* () {
      yield "First";
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      yield "Second";
    },
    now: () => Date.now(),
  });
  const config = getConfig("maths-oxbridge");
  const state = createInitialState(config.id, config.styles[0].id, Date.now());
  const state2 = { ...state, phase: "problem" as const };
  const res = await handler(new Request("http://localhost/api/step", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: state2, event: { type: "turn_complete", text: "test", source: "voice" } }),
    signal: controller.signal,
  }));
  const events: StepStreamEvent[] = [];
  try { for await (const e of parseSSE(res.body as ReadableStream<Uint8Array>)) { events.push(e); if (events.length > 5) break; } } catch { /* interrupted */ }
  return events.map((e) => e.event + (e.event === "token" ? ":" + e.data.text : e.event === "error" ? ":" + e.data.code : ""));
}

(async () => {
  let over = 0;
  const seen = new Map<string, number>();
  for (let i = 0; i < 300; i++) {
    const ev = await once();
    const key = ev.join(",");
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (ev.length > 3) over++;
  }
  console.log(`runs=300 over3=${over}`);
  for (const [k, v] of seen) console.log(`  ${v}x ${k}`);
  for (const b of burners) await b.terminate();
  process.exit(0);
})();
