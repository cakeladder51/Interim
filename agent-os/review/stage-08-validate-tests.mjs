// Runs the reviewer's Stage 8 test files (agent-os/review/stage-08-tests/*.test.ts.txt) against the builder's src
// without adding them to the suite. Copies each to tests/s8rev-<name>.test.ts, runs vitest on the copies only,
// prints per-file pass/fail + failing test names, then deletes the copies (also on error).
//   node agent-os/review/stage-08-validate-tests.mjs            all files
//   node agent-os/review/stage-08-validate-tests.mjs voice      only files whose name contains "voice"
//   node agent-os/review/stage-08-validate-tests.mjs --lint     also eslint the copies
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const filter = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
const lint = process.argv.includes("--lint");
const srcDir = join(repo, "agent-os/review/stage-08-tests");
const out = join(tmpdir(), "interim-review", "s8rev.json");
const copies = [];
process.on("exit", () => {
  for (const c of copies) if (existsSync(c)) rmSync(c);
});
for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".test.ts.txt") && n.includes(filter))) {
  const dest = join(repo, "tests", "s8rev-" + f.replace(/\.txt$/, ""));
  writeFileSync(dest, readFileSync(join(srcDir, f)));
  copies.push(dest);
}
const rel = copies.map((c) => c.slice(repo.length + 1).replace(/\\/g, "/"));
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const vt = spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", ...rel, "--reporter=json", `--outputFile=${out}`], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
const all = vt.stdout + vt.stderr;
console.log(`vitest exit=${vt.status} ${/Unhandled (Rejection|Error)/.test(all) ? "UNHANDLED present" : "no unhandled"}`);
if (existsSync(out)) {
  const j = JSON.parse(readFileSync(out, "utf8"));
  for (const r of j.testResults) {
    const name = r.name.replace(/\\/g, "/").split("/").pop();
    const failed = r.assertionResults.filter((a) => a.status !== "passed");
    console.log(`${name}: ${r.assertionResults.length - failed.length}/${r.assertionResults.length}${r.message ? " SUITE: " + r.message.split("\n")[0].slice(0, 200) : ""}`);
    for (const a of failed) console.log(`  FAIL ${a.title}: ${(a.failureMessages[0] ?? "").split("\n")[0].slice(0, 200)}`);
  }
}
if (process.argv.includes("--tsc")) {
  const tc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit"], { cwd: repo, env, encoding: "utf8" });
  const errs = (tc.stdout.match(/error TS/g) ?? []).length;
  console.log(`tsc exit=${tc.status} errors=${errs}`);
  if (errs) console.log(tc.stdout.split("\n").filter((l) => l.includes("s8rev-")).slice(0, 10).join("\n"));
}
if (lint) {
  const es = spawnSync(process.execPath, [join(repo, "node_modules/eslint/bin/eslint.js"), "--max-warnings=0", ...rel], { cwd: repo, env, encoding: "utf8" });
  console.log(`eslint exit=${es.status}`);
  if (es.status !== 0) console.log(es.stdout.split("\n").filter((l) => /error|warning/.test(l)).slice(0, 15).join("\n"));
}
