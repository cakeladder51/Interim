// Stage 11 (hardening) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-11-mutants.mjs            (~2 min; one group, meta)
//   node agent-os/review/stage-11-mutants.mjs --restore  (restore meta.ts from the on-disk backup after a kill)
//   node agent-os/review/stage-11-mutants.mjs --list | --dry | --label="H1"
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert to src/lib/meta.ts (92eaa326), runs config-error + meta + meta.sdk + speak +
// assess, records caught/missed. The file is restored after each mutation and byte-verified at the end.
// Output: "caught X/Y", then one line per missed or skipped mutation. Entries marked EQUIVALENT are expected MISSED.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const F = { meta: { path: `${repo}/src/lib/meta.ts`, group: "meta", tests: ["config-error", "meta", "meta.sdk", "speak", "assess"] } };
const GROUPS = [...new Set(Object.values(F).map((f) => f.group))];
const testFiles = (key) => F[key].tests.map((n) => `tests/${n}.test.ts`).join(" ");
const bdir = join(tmpdir(), "interim-review", "backup-s11");

const THROW = 'throw new MetaError("config", err instanceof Error ? err.message : String(err), false);';
// [label, fileKey, from, to, nth?]
const M = [
  ["H1: catch rethrows the plain Error", "meta", THROW, "throw err;"],
  ["H1: retryable true", "meta", THROW, 'throw new MetaError("config", err instanceof Error ? err.message : String(err), true);'],
  ["H1: code upstream, not config", "meta", THROW, 'throw new MetaError("upstream", err instanceof Error ? err.message : String(err), false);'],
  ["H1: message dropped", "meta", THROW, 'throw new MetaError("config", "config", false);'],
  ["H1: wrapper swallows the error (returns undefined env)", "meta", THROW, "return undefined as unknown as ReturnType<typeof getServerEnv>;"],
  ["H1: getMetaClient calls getServerEnv directly", "meta", "const env = serverEnv();", "const env = getServerEnv();", 0],
  ["H1: chatJSON calls getServerEnv directly", "meta", "const env = serverEnv();", "const env = getServerEnv();", 1],
  ["H1: chatStream calls getServerEnv directly", "meta", "const env = serverEnv();", "const env = getServerEnv();", 2],
];

if (process.argv.includes("--list")) {
  for (const g of GROUPS) console.log(`${g}: ${M.filter((m) => F[m[1]].group === g).length}`);
  process.exit(0);
}
if (process.argv.includes("--restore")) {
  let n = 0;
  for (const [k, v] of Object.entries(F)) if (existsSync(join(bdir, k))) { writeFileSync(v.path, readFileSync(join(bdir, k))); n++; }
  console.log(`restored ${n} file(s) from ${bdir}`); process.exit(0);
}

const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8);
const orig = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, readFileSync(v.path)]));
mkdirSync(bdir, { recursive: true });
for (const k of Object.keys(F)) writeFileSync(join(bdir, k), orig[k]);
const restore = () => { for (const [k, v] of Object.entries(F)) writeFileSync(v.path, orig[k]); };
process.on("exit", restore);
process.on("SIGINT", () => { process.exit(1); });

function replaceNth(src, from, to, nth) {
  const idxs = []; let i = -1;
  while ((i = src.indexOf(from, i + 1)) !== -1) idxs.push(i);
  if (idxs.length === 0) return { err: "NOT FOUND" };
  if (nth === undefined && idxs.length > 1) return { err: `AMBIGUOUS (${idxs.length})` };
  if ((nth ?? 0) >= idxs.length) return { err: "NOT FOUND (nth)" };
  return { out: src.slice(0, idxs[nth ?? 0]) + to + src.slice(idxs[nth ?? 0] + from.length) };
}
const runTests = (files) => {
  let o = "";
  try { o = execSync(`npx vitest run ${files}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, timeout: 240000 }); }
  catch (e) { o = (e.stdout ?? "") + (e.stderr ?? ""); }
  return o.replace(/\x1b\[[0-9;]*m/g, "");
};

const selected = M.filter(([label]) => !labelFilter || label.includes(labelFilter));
let total = 0, caught = 0; const lines = [];
for (const [label, key, from, to, nth] of selected) {
  total++;
  restore();
  const r = replaceNth(orig[key].toString("utf8"), from, to, nth);
  if (r.err) { lines.push(`SKIPPED (${r.err}): ${label}`); continue; }
  if (process.argv.includes("--dry")) { caught++; continue; }
  writeFileSync(F[key].path, r.out);
  const out = runTests(testFiles(key));
  const summary = (out.match(/Tests\s+.*$/m) ?? [""])[0];
  if (/\d+ failed/.test(summary) || /Errors\s+\d+ error/.test(out) || /Failed Suites|Error:/.test(out) && !/passed \(\d+\)\s*$/.test(summary)) caught++;
  else lines.push(`MISSED: ${label}`);
}
restore();
const bad = Object.entries(F).filter(([k, v]) => !readFileSync(v.path).equals(orig[k])).map(([k]) => k);
console.log(`groups=meta caught ${caught}/${total}`);
for (const l of lines) console.log(l);
console.log(bad.length ? `RESTORE MISMATCH: ${bad.join(",")} — run with --restore` : "restore: all files byte-identical");
