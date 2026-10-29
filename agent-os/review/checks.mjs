// Review checks (any stage), compact output: tsc, eslint, next build (no keys), vitest exit code + Errors/Unhandled,
// and a per-file test-name diff against the previous round. JSON reports live in %TEMP%/interim-review.
// Usage (repo root): node agent-os/review/checks.mjs <newJsonName> <baselineJsonName>   e.g. vitest-s7r0.json vitest-s6r3.json
// Runs ~5 min; run in the foreground (or background + in-turn poll).
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
const repo = "D:/CodeFiles/Interim";
const dir = "C:/Users/Aditya/AppData/Local/Temp/interim-review";
const [newName = "vitest-new.json", baseName = "vitest-s6r3.json"] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
for (const k of ["MODEL_API_KEY", "OPENAI_API_KEY", "RELAY_SECRET"]) delete env[k];
const run = (args) => { const r = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "") }; };
const nm = (p) => `${repo}/node_modules/${p}`;

const tsc = run([nm("typescript/bin/tsc"), "--noEmit"]);
console.log(`tsc exit=${tsc.code} errors=${(tsc.out.match(/error TS/g) ?? []).length}`);
if (tsc.code) console.log(tsc.out.split("\n").filter((l) => /error TS/.test(l)).slice(0, 5).join("\n"));

const lint = run([nm("eslint/bin/eslint.js"), "--max-warnings=0"]);
console.log(`eslint exit=${lint.code} ${(lint.out.match(/✖.*problems?.*/) ?? ["clean"])[0]}`);
if (lint.code) console.log(lint.out.split("\n").filter((l) => /^[A-Z]:|^\//.test(l) || /error|warning/.test(l)).slice(0, 8).join("\n"));

const build = run([nm("next/dist/bin/next"), "build"]);
console.log(`next build exit=${build.code} routes: relay-token=${/relay-token/.test(build.out)} tts=${build.out.includes("/api/tts")}`);
if (build.code) console.log(build.out.split("\n").slice(-15).join("\n"));

const vt = run([nm("vitest/vitest.mjs"), "run", "--reporter=default", "--reporter=json", `--outputFile.json=${dir}/${newName}`]);
console.log(`vitest exit=${vt.code} | ${(vt.out.match(/^\s*Tests\s+.*$/m) ?? [""])[0].trim()} | ${(vt.out.match(/Errors\s+.*$/m) ?? ["Errors: none"])[0]} | ${/Unhandled (Rejection|Error)/.test(vt.out) ? "UNHANDLED present" : "no unhandled"}`);

const names = (f) => { const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); const m = {}; for (const t of j.testResults) { const file = t.name.replace(/\\/g, "/").split("/tests/").pop(); m[file] = new Set(t.assertionResults.map((a) => a.fullName)); } return m; };
if (existsSync(`${dir}/${newName}`) && existsSync(`${dir}/${baseName}`)) {
  const a = names(baseName), b = names(newName); let lost = 0; const counts = [];
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const A = a[f] ?? new Set(), B = b[f] ?? new Set();
    for (const n of A) if (!B.has(n)) { lost++; console.log(`LOST: ${f} :: ${n}`); }
    if (A.size !== B.size) counts.push(`${f} ${A.size}→${B.size}`);
  }
  console.log(`test names lost=${lost}; changed counts: ${counts.join(", ") || "none"}`);
} else console.log("names diff: JSON missing");
