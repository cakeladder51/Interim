// Per-file test-name diff between two vitest JSON reports: node stage-09-namediff.mjs <old.json> <new.json>
import { readFileSync } from "node:fs";
const load = (p) => {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const m = new Map();
  for (const f of j.testResults) {
    const file = f.name.replace(/\\/g, "/").replace(/^.*\/tests\//, "tests/");
    m.set(file, new Set(f.assertionResults.map((a) => a.fullName)));
  }
  return { m, total: j.numTotalTests, failed: j.numFailedTests, ok: j.success };
};
const [a, b] = [load(process.argv[2]), load(process.argv[3])];
let lost = 0;
for (const [file, names] of a.m) for (const n of names) if (!b.m.get(file)?.has(n)) { lost++; console.log(`LOST ${file} :: ${n}`); }
console.log(`old ${a.total} new ${b.total} (failed ${b.failed}, success ${b.ok}) lost ${lost}`);
