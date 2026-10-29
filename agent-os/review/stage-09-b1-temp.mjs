// Temporarily apply the stage-09-review B1 fix to feedback-handler.ts so the reviewer tests can be measured
// before the builder lands it.  node agent-os/review/stage-09-b1-temp.mjs apply|revert
// apply: backs up the builder's file (os.tmpdir()/interim-review/backup-s9-b1) and inserts the B1 line.
// revert: restores the backup and prints the hash (builder's round-1 file).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = "src/server/feedback-handler.ts";
const dir = join(tmpdir(), "interim-review"); mkdirSync(dir, { recursive: true });
const bak = join(dir, "backup-s9-b1");
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
const anchor = "          await sleep(FEEDBACK_RETRY_DELAY_MS);\n";
const fix = anchor + "          if (request.signal.aborted) break;\n";
if (process.argv[2] === "apply") {
  const src = readFileSync(path, "utf8");
  if (src.includes(fix)) { console.log("already applied"); process.exit(0); }
  if (src.split(anchor).length !== 2) { console.log("anchor not unique/not found"); process.exit(1); }
  writeFileSync(bak, src);
  writeFileSync(path, src.replace(anchor, fix));
  console.log(`applied; original ${h(src)}`);
} else if (process.argv[2] === "revert") {
  if (!existsSync(bak)) { console.log("no backup"); process.exit(1); }
  writeFileSync(path, readFileSync(bak));
  console.log(`reverted; now ${h(readFileSync(path))}`);
}
