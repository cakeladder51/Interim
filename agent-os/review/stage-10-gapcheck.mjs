// Runs stage-10-mutants.mjs --reviewer --skip-bugs on the labels the builder's tests missed in round 1.
//   node agent-os/review/stage-10-gapcheck.mjs
import { execFileSync } from "node:child_process";

const labels = ["N1: notices", "S1: start after dispose", "F2: already", "F3: finishing not", "F4: disposed", "F5: "];
for (const l of labels) {
  const out = execFileSync(process.execPath, ["agent-os/review/stage-10-mutants.mjs", "--only=session", "--reviewer", "--skip-bugs", `--label=${l}`], { encoding: "utf8" });
  for (const line of out.split("\n")) if (line && !line.startsWith("restore: all")) console.log(line);
}
