// Live eval CLI script
// Must exit 2 without MODEL_API_KEY without touching the network

// Importing these modules performs no network or env access (getServerEnv is lazy),
// and the key check below runs before any call.
const apiKey = process.env.MODEL_API_KEY;

if (!apiKey || apiKey === "") {
  console.log("MODEL_API_KEY is not set. The live eval is on hold until a key is available.");
  process.exit(2);
}

// Now safe to import modules that may access getServerEnv
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScripts } from "../src/eval/load-scripts";
import { replayScript } from "../src/eval/replay";
import { checkScript } from "../src/eval/expect";
import { scoreLive, summarize, type ScoreRow } from "../src/eval/score";
import { assess } from "../src/server/assess";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = parseArgs({
  options: {
    "min-pass": {
      type: "string",
      default: "0.8",
    },
  },
  strict: false,
});

const minPassStr = args.values["min-pass"] as string;
const minPassNum = Number(minPassStr);
if (Number.isNaN(minPassNum) || minPassNum < 0 || minPassNum > 1) {
  console.log("--min-pass must be a number between 0 and 1");
  process.exit(1);
}
const minPass = minPassNum;

async function main() {
  const scriptsDir = join(process.cwd(), "evals", "scripts");
  let scripts;
  try {
    scripts = loadScripts(scriptsDir);
  } catch (err) {
    console.error(`Failed to load scripts: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`Loaded ${scripts.length} scripts\n`);

  const allRows: ScoreRow[] = [];
  let allPassed = true;
  const allOutcomes: Map<string, Awaited<ReturnType<typeof replayScript>>> = new Map();

  for (const script of scripts) {
    console.log(`Running script: ${script.id}`);

    const outcomes = await replayScript(script, {
      live: {
        assess: async (args) => {
          return assess({
            config: args.config,
            style: args.style,
            state: args.state,
            event: args.event,
            signal: args.signal,
          });
        },
      },
    });
    allOutcomes.set(script.id, outcomes);

    // Check deterministic expectations
    const checkErrors = checkScript(script, outcomes);
    if (checkErrors.length > 0) {
      console.error(`  FAIL: ${checkErrors.join("\n  ")}`);
      allPassed = false;
    } else {
      console.log("  PASS (deterministic)");
    }

    // Score live results
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i]!;
      const outcome = outcomes[i + 1];
      if (step.live && outcome && outcome.live) {
        const result = scoreLive(step.live, outcome.live.assessment);
        allRows.push({
          scriptId: script.id,
          index: i,
          eventType: step.event.type,
          pass: result.pass,
          latencyMs: outcome.live.latencyMs,
        });
      }
    }
  }

  // Print table
  console.log("\n| script | step | event | expected statuses | actual status | pass | latency ms | why |");
  console.log("|--------|------|-------|-------------------|----------------|------|------------|-----|");

  for (const row of allRows) {
    const script = scripts.find((s) => s.id === row.scriptId)!;
    const step = script.steps[row.index]!;
    const outcomes = allOutcomes.get(row.scriptId)!;
    const outcome = outcomes.find((_: unknown, idx: number) => idx === row.index + 1);
    const actualStatus = outcome?.live?.assessment?.status ?? null;
    const result = step.live ? scoreLive(step.live, outcome?.live?.assessment ?? null) : { why: "N/A" };
    console.log(`| ${row.scriptId} | ${row.index} | ${row.eventType} | [${step.live?.status.join(", ")}] | ${actualStatus ?? "null"} | ${row.pass ? "✓" : "✗"} | ${row.latencyMs} | ${result.why} |`);
  }

  // Print summary
  const summary = summarize(allRows);
  console.log("\nSummary:");
  console.log(`  Total: ${summary.total}`);
  console.log(`  Passed: ${summary.passed}`);
  console.log(`  Pass rate: ${(summary.passRate * 100).toFixed(1)}%`);
  console.log(`  p50 partial: ${summary.p50.partial ?? "N/A"} ms`);
  console.log(`  p50 turn_complete: ${summary.p50.turn_complete ?? "N/A"} ms`);
  console.log(`  p95 partial: ${summary.p95.partial ?? "N/A"} ms`);
  console.log(`  p95 turn_complete: ${summary.p95.turn_complete ?? "N/A"} ms`);

  // Write results to file
  const outDir = join(__dirname, "out");
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `eval-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify({ rows: allRows, summary }, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  // Final exit
  if (!allPassed) {
    console.error("\nSome checks failed.");
    process.exit(1);
  }

  if (summary.passRate < minPass) {
    console.error(`\nPass rate ${(summary.passRate * 100).toFixed(1)}% < min ${minPass * 100}%`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
