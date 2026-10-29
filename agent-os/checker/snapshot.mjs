// File-change tracker for the pre-review checker. Run from the repo root.
//   node agent-os/checker/snapshot.mjs save <name>     record sha256 of every project file
//   node agent-os/checker/snapshot.mjs diff <name>     list files CHANGED / ADDED / DELETED since that snapshot
//   node agent-os/checker/snapshot.mjs since <ISO>     list files modified after a timestamp (fallback when no snapshot exists)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".bridge", ".claude", "acl-repair"]);
const SKIP_PREFIX = ["agent-os/review/", "agent-os/checker/"];
const SKIP_FILES = new Set(["tsconfig.tsbuildinfo", "next-env.d.ts"]);
const snapDir = join(root, "agent-os", "checker", "snapshots");

function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const rel = relative(root, p).split(sep).join("/");
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out); continue; }
    if (SKIP_FILES.has(e) || SKIP_PREFIX.some((s) => rel.startsWith(s))) continue;
    out.push({ rel, p, mtime: st.mtimeMs });
  }
  return out;
}
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const [cmd, arg] = process.argv.slice(2);
if (cmd === "save" && arg) {
  const m = {};
  for (const f of walk(root, [])) m[f.rel] = hash(f.p);
  writeFileSync(join(snapDir, `${arg}.json`), JSON.stringify(m, null, 1));
  console.log(`saved ${Object.keys(m).length} files to snapshots/${arg}.json`);
} else if (cmd === "diff" && arg) {
  const file = join(snapDir, `${arg}.json`);
  if (!existsSync(file)) { console.log(`no snapshot ${arg}`); process.exit(2); }
  const old = JSON.parse(readFileSync(file, "utf8"));
  const now = {};
  for (const f of walk(root, [])) now[f.rel] = hash(f.p);
  const changed = [], added = [], deleted = [];
  for (const k of Object.keys(now)) { if (!(k in old)) added.push(k); else if (old[k] !== now[k]) changed.push(k); }
  for (const k of Object.keys(old)) if (!(k in now)) deleted.push(k);
  for (const k of changed.sort()) console.log(`CHANGED ${k}`);
  for (const k of added.sort()) console.log(`ADDED   ${k}`);
  for (const k of deleted.sort()) console.log(`DELETED ${k}`);
  console.log(`total: ${changed.length} changed, ${added.length} added, ${deleted.length} deleted`);
} else if (cmd === "since" && arg) {
  const t = Date.parse(arg);
  const hits = walk(root, []).filter((f) => f.mtime > t).map((f) => f.rel).sort();
  for (const k of hits) console.log(`MODIFIED ${k}`);
  console.log(`total: ${hits.length} files modified after ${arg}`);
} else {
  console.log("usage: snapshot.mjs save <name> | diff <name> | since <ISO time>");
  process.exit(1);
}
