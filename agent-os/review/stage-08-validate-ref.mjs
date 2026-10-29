// Run the builder's tests/turn-controller.test.ts against the reviewer reference (stage-08-ref.mjs).
// Copies it to tests/s8check-turn-ref.test.ts with the import re-pointed, runs vitest on it, deletes the copy.
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = process.cwd();
const dest = join(repo, "tests", "s8check-turn-ref.test.ts");
process.on("exit", () => {
  if (existsSync(dest)) rmSync(dest);
});
// Optional arg: another test source, e.g. agent-os/review/stage-08-tests/turn-controller.test.ts.txt
const text = readFileSync(join(repo, process.argv[2] ?? "tests/turn-controller.test.ts"), "utf8");
const re = '"../src/client/turn-controller"';
if (!text.includes(re)) {
  console.log("import anchor not found");
  process.exit(1);
}
writeFileSync(dest, text.split(re).join('"../agent-os/review/stage-08-ref.mjs"'));
const vt = spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "tests/s8check-turn-ref.test.ts"], {
  cwd: repo,
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  encoding: "utf8",
});
const all = vt.stdout + vt.stderr;
console.log(`vitest exit=${vt.status}`);
for (const l of all.split("\n")) if (/Tests\s+\d|FAIL|✗|×/.test(l)) console.log(l.trim());
