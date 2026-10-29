// Run the reviewer's Stage 9 test files (agent-os/review/stage-09-tests/*.test.ts.txt) against src.
//   node agent-os/review/stage-09-validate-tests.mjs [--lint] [--tsc]
// Copies each to tests/s9rev-*.test.ts for the run and deletes the copies afterwards.
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const revDir = join(repo, "agent-os/review/stage-09-tests");
const copies = readdirSync(revDir).filter((f) => f.endsWith(".test.ts.txt")).map((f) => {
  const dest = join(repo, "tests", "s9rev-" + f.replace(/\.txt$/, ""));
  writeFileSync(dest, readFileSync(join(revDir, f)));
  return dest;
});
process.on("exit", () => { for (const c of copies) if (existsSync(c)) rmSync(c); });
const run = (cmd) => {
  try { return { code: 0, out: execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
};
const rel = copies.map((c) => "tests/" + c.split(/[\\/]/).pop());
const v = run(`npx vitest run ${rel.join(" ")}`);
const lines = v.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
console.log(`vitest exit ${v.code}`);
for (const l of lines) if (/^\s*(×|✗|FAIL)|Tests\s|Errors|Unhandled|AssertionError|Expected|Received/.test(l)) console.log(l.slice(0, 200));
if (process.argv.includes("--lint")) { const r = run(`npx eslint --max-warnings=0 ${rel.join(" ")}`); console.log(`eslint exit ${r.code}`); if (r.code) console.log(r.out.slice(0, 2000)); }
if (process.argv.includes("--tsc")) { const r = run("npx tsc --noEmit"); console.log(`tsc exit ${r.code}`); if (r.code) console.log(r.out.split("\n").filter((l) => l.includes("s9rev")).slice(0, 20).join("\n")); }
