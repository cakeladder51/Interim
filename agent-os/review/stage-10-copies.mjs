// Byte-compares every reviewer test copy (agent-os/review/stage-NN-tests/*.test.ts.txt) with tests/.
import fs from "node:fs";
import path from "node:path";

const root = "D:/CodeFiles/Interim";
let ok = 0;
const bad = [];
for (const st of ["07", "08", "09", "10"]) {
  const dir = path.join(root, `agent-os/review/stage-${st}-tests`);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.ts.txt"))) {
    const target = path.join(root, "tests", f.replace(/\.txt$/, ""));
    const a = fs.readFileSync(path.join(dir, f));
    const b = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (b && a.equals(b)) ok++;
    else bad.push(`${st}/${f}`);
  }
}
console.log(`identical ${ok}; mismatched/missing: ${bad.join(", ") || "none"}`);
