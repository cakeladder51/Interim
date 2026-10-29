// Leftover check after an interrupted Stage 8 review: compares the mutant targets with the backup-s8 copies
// and lists any reviewer temp test copies (tests/s8rev-*, tests/s8check-*). Restores nothing.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const bdir = join(tmpdir(), "interim-review", "backup-s8");
const F = {
  model: "src/client/interview-model.ts",
  bgrunner: "src/client/background-runner.ts",
  turn: "src/client/turn-controller.ts",
  voice: "src/client/voice/voice-controller.ts",
};
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
for (const [k, p] of Object.entries(F)) {
  const cur = readFileSync(join(repo, p));
  const bk = existsSync(join(bdir, k)) ? readFileSync(join(bdir, k)) : null;
  console.log(`${k}: current ${sha(cur)} backup ${bk ? sha(bk) : "none"} ${bk && cur.equals(bk) ? "IDENTICAL" : "DIFFERS"} mtime ${statSync(join(repo, p)).mtime.toISOString()}`);
}
const temps = readdirSync(join(repo, "tests")).filter((f) => f.startsWith("s8rev-") || f.startsWith("s8check-"));
console.log("temp test copies: " + (temps.length ? temps.join(", ") : "none"));
