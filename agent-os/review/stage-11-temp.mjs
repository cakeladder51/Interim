// Stage 11 brief check: temporarily applies the brief's H1 (src/lib/meta.ts) and H2 (tests/step-route.test.ts)
// edits, copies the reviewer test file(s), runs tsc + eslint + the affected tests, prints the after-hashes,
// then restores everything (backups: os.tmpdir()/interim-review/backup-s11-*).
//   node agent-os/review/stage-11-temp.mjs            (with the edits)
//   node agent-os/review/stage-11-temp.mjs --before   (reviewer tests against the unedited code: H1 tests must fail)
//   node agent-os/review/stage-11-temp.mjs --restore  (after a kill)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
const bdir = join(tmpdir(), "interim-review"); mkdirSync(bdir, { recursive: true });

export const H1_HELPER = `/** Stage 11: a missing or invalid server env is a non-retryable MetaError("config"), so callers fall back. */
function serverEnv(): ReturnType<typeof getServerEnv> {
  try {
    return getServerEnv();
  } catch (err) {
    throw new MetaError("config", err instanceof Error ? err.message : String(err), false);
  }
}

`;
export const H2_FROM = `    const responsePromise = handler(
      new Request("http://localhost/api/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, event: { type: "turn_complete", text: "test", source: "voice" } }),
        signal: controller.signal,
      }) as NextRequest
    );
`;
export const H2_TO = `    // Stage 11 H2: a Request stand-in whose signal IS the test's own signal. A real Request follows its
    // creator's abort only weakly (undici), which made this test fail about 1 run in 300 under load.
    const requestBody = { state, event: { type: "turn_complete", text: "test", source: "voice" } };
    const responsePromise = handler({
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => requestBody,
      signal: controller.signal,
    } as unknown as NextRequest);
`;
export const H2_ASSERT_FROM = "    expect(events.length).toBeLessThanOrEqual(3);\n";
export const H2_ASSERT_TO = "    expect(events.length).toBeLessThanOrEqual(3);\n    expect(events.map((e) => e.event)).toEqual([\"move\", \"token\"]);\n";

const files = {
  meta: join(repo, "src/lib/meta.ts"),
  route: join(repo, "tests/step-route.test.ts"),
};
const copies = { "config-error": join(repo, "tests/config-error.test.ts") };
if (process.argv.includes("--restore")) {
  for (const [k, p] of Object.entries(files)) if (existsSync(join(bdir, `backup-s11-${k}`))) writeFileSync(p, readFileSync(join(bdir, `backup-s11-${k}`)));
  for (const p of Object.values(copies)) if (existsSync(p) && !existsSync(p + ".keep")) rmSync(p);
  console.log("restored"); process.exit(0);
}
const orig = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p)]));
for (const [k, b] of Object.entries(orig)) writeFileSync(join(bdir, `backup-s11-${k}`), b);
const preexisting = Object.fromEntries(Object.entries(copies).map(([k, p]) => [k, existsSync(p)]));

function edit(text, from, to, count = 1) {
  const n = text.split(from).length - 1;
  if (n !== count) { console.log(`anchor found ${n} times (want ${count}): ${from.slice(0, 50)}`); process.exit(1); }
  return text.split(from).join(to);
}
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
for (const k of ["MODEL_API_KEY", "OPENAI_API_KEY", "RELAY_SECRET"]) delete env[k];
const nm = (p) => join(repo, "node_modules", p);
const run = (args) => { const r = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "") }; };
const before = process.argv.includes("--before");
try {
  for (const [k, p] of Object.entries(copies)) if (!preexisting[k]) writeFileSync(p, readFileSync(join(repo, `agent-os/review/stage-11-tests/${k}.test.ts.txt`)));
  if (!before) {
    let m = orig.meta.toString("utf8");
    m = edit(m, "getServerEnv();", "serverEnv();", 3);
    m = edit(m, "let metaClient: OpenAI | null = null;\n", H1_HELPER + "let metaClient: OpenAI | null = null;\n");
    writeFileSync(files.meta, m);
    let r = orig.route.toString("utf8");
    r = edit(r, H2_FROM, H2_TO);
    r = edit(r, H2_ASSERT_FROM, H2_ASSERT_TO);
    writeFileSync(files.route, r);
    console.log(`meta ${h(orig.meta)} -> ${h(Buffer.from(m))}; step-route ${h(orig.route)} -> ${h(Buffer.from(r))}; config-error ${h(readFileSync(copies["config-error"]))}`);
    const t = run([nm("typescript/bin/tsc"), "--noEmit"]);
    console.log(`tsc exit=${t.code}`); if (t.code) console.log(t.out.slice(0, 2000));
    const e = run([nm("eslint/bin/eslint.js"), "--max-warnings=0", "src/lib/meta.ts", "tests/step-route.test.ts", "tests/config-error.test.ts"]);
    console.log(`eslint exit=${e.code}`); if (e.code) console.log(e.out.slice(0, 2000));
  }
  const tests = before ? ["tests/config-error.test.ts"] : ["tests/config-error.test.ts", "tests/step-route.test.ts", "tests/meta.test.ts", "tests/meta.sdk.test.ts", "tests/speak.test.ts", "tests/assess.test.ts", "tests/e2e-text-interview.test.ts", "tests/feedback-route.test.ts"];
  const v = run([nm("vitest/vitest.mjs"), "run", ...tests]);
  console.log(`vitest exit=${v.code}`);
  for (const l of v.out.split("\n")) if (/^\s*(×|FAIL)|Tests\s|Errors|Unhandled|AssertionError/.test(l)) console.log(l.slice(0, 220));
} finally {
  for (const [k, p] of Object.entries(files)) writeFileSync(p, orig[k]);
  for (const [k, p] of Object.entries(copies)) if (!preexisting[k] && existsSync(p)) rmSync(p);
  console.log(`restored meta ${h(readFileSync(files.meta))} step-route ${h(readFileSync(files.route))}`);
}
