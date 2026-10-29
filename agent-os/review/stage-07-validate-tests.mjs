// Runs the reviewer's Stage 7 test files (agent-os/review/stage-07-tests/*.test.ts.txt) without adding them to the suite.
// Usage (repo root):
//   node agent-os/review/stage-07-validate-tests.mjs ref         run against the reviewer's reference impls (%TEMP%/interim-review/s7-ref)
//   node agent-os/review/stage-07-validate-tests.mjs src         run against the builder's src/client/voice/*
//   node agent-os/review/stage-07-validate-tests.mjs src --lint  also eslint + tsc the copies
// Copies each file to tests/s7check-<name>.test.ts, runs vitest on those copies only, prints per-file pass/fail and the
// failing test names, then deletes the copies (also on error).
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const mode = process.argv[2] === "ref" ? "ref" : "src";
const lint = process.argv.includes("--lint");
const refDir = join(tmpdir(), "interim-review", "s7-ref").replace(/\\/g, "/");
const srcDir = join(repo, "agent-os/review/stage-07-tests");
const out = join(tmpdir(), "interim-review", `s7check-${mode}.json`);
const copies = [];
const cleanup = () => { for (const c of copies) if (existsSync(c)) rmSync(c); };
process.on("exit", cleanup);

for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".test.ts.txt"))) {
  let text = readFileSync(join(srcDir, f), "utf8");
  if (mode === "ref") {
    for (const m of ["tts-player", "relay-client", "voice-controller"]) {
      text = text.split(`"../src/client/voice/${m}"`).join(`"${refDir}/${m}"`);
    }
    text = text.split('"../src/server/tts-handler"').join(`"${refDir}/tts-handler"`);
  }
  const dest = join(repo, "tests", "s7check-" + f.replace(/\.txt$/, ""));
  writeFileSync(dest, text);
  copies.push(dest);
}
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
const nm = (p) => join(repo, "node_modules", p);
const rel = copies.map((c) => c.slice(repo.length + 1).replace(/\\/g, "/"));
const vt = spawnSync(process.execPath, [nm("vitest/vitest.mjs"), "run", ...rel, "--reporter=json", `--outputFile=${out}`], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
const all = vt.stdout + vt.stderr;
console.log(`vitest exit=${vt.status} ${/Unhandled (Rejection|Error)/.test(all) ? "UNHANDLED present" : "no unhandled"}`);
if (existsSync(out)) {
  const j = JSON.parse(readFileSync(out, "utf8"));
  for (const t of j.testResults) {
    const a = t.assertionResults;
    console.log(`${t.name.split(/[\\/]/).pop()}: ${a.filter((x) => x.status === "passed").length}/${a.length} pass${t.message ? " | " + t.message.split("\n")[0].slice(0, 160) : ""}`);
    for (const x of a.filter((y) => y.status !== "passed")) console.log(`  FAIL ${x.fullName} | ${(x.failureMessages[0] ?? "").split("\n")[0].slice(0, 160)}`);
  }
}
if (lint) {
  const es = spawnSync(process.execPath, [nm("eslint/bin/eslint.js"), "--max-warnings=0", ...rel], { cwd: repo, env, encoding: "utf8" });
  console.log(`eslint exit=${es.status}`);
  if (es.status) console.log((es.stdout + es.stderr).split("\n").filter((l) => /warning|error/.test(l)).slice(0, 12).join("\n"));
  const ts = spawnSync(process.execPath, [nm("typescript/bin/tsc"), "--noEmit"], { cwd: repo, env, encoding: "utf8" });
  const errs = (ts.stdout + ts.stderr).split("\n").filter((l) => /error TS/.test(l));
  console.log(`tsc exit=${ts.status} errors=${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 12).join("\n"));
}
cleanup();
