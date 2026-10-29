// Re-runs one vitest file N times and reports pass/fail counts plus the failing test names (read-only).
// Usage (repo root): node agent-os/review/flaky-check.mjs tests/step-route.test.ts 8
import { spawnSync } from "node:child_process";
const [file, nArg = "5"] = process.argv.slice(2);
const n = Number(nArg);
let fails = 0;
const names = new Map();
for (let i = 0; i < n; i++) {
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", file], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) {
    fails++;
    for (const m of out.matchAll(/(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)) names.set(m[1].trim(), (names.get(m[1].trim()) ?? 0) + 1);
  }
}
console.log(`${file}: ${n - fails}/${n} runs passed`);
for (const [k, v] of names) console.log(`  failed ${v}x: ${k}`);
