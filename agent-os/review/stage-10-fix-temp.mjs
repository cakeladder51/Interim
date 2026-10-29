// Stage 10 review-1: temporarily applies the B1-B4 replacements from stage-10-review.md to
// src/client/recording/recording-session.ts, runs tsc + eslint + the 3 brief tests + recording-review,
// prints the after-hash, then restores the file (backup: os.tmpdir()/interim-review/backup-s10-fix).
//   node agent-os/review/stage-10-fix-temp.mjs          (apply, check, restore)
//   node agent-os/review/stage-10-fix-temp.mjs --restore (restore after a kill)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const file = join(repo, "src/client/recording/recording-session.ts");
const bdir = join(tmpdir(), "interim-review"); mkdirSync(bdir, { recursive: true });
const bak = join(bdir, "backup-s10-fix");
const revTest = join(repo, "tests/s10fix-recording-review.test.ts");
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
if (process.argv.includes("--restore")) {
  if (existsSync(bak)) writeFileSync(file, readFileSync(bak));
  if (existsSync(revTest)) rmSync(revTest);
  console.log(`restored ${h(readFileSync(file))}`); process.exit(0);
}

export const FIXES = [
  // B3
  ["    appendNotices?: string[]\n  ): void {\n    const baseNotices = snapshot.notices;\n",
   "    appendNotices?: string[]\n  ): void {\n    if (disposed) return;\n    const baseNotices = snapshot.notices;\n"],
  // B4: startRecorder + helpers
  [`  function startRecorder(stream: StreamLike, kind: RecordingKind): boolean {
    try {
      const recorder = deps.createRecorder(stream, kind);
      recorders[kind] = recorder;
      const kindChunks: Blob[] = [];
      chunks[kind] = kindChunks;
      stopPromises[kind] = deferred<void>();
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          kindChunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        stopPromises[kind]?.resolve();
        updateSnap({ [kind]: "stopped" });
      };
      recorder.onerror = () => {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      };
      recorder.start(RECORDER_TIMESLICE_MS);
      updateSnap({ [kind]: "recording" });
      return true;
    } catch {
      updateSnap(
        { [kind]: "failed" },
        [
          kind === "audio"
            ? NOTICE.audioUnsupported
            : NOTICE.videoUnsupported,
        ]
      );
      return false;
    }
  }
`, `  function createMixerOrNull(mic: StreamLike | null): Mixer | null {
    try {
      return deps.createMixer(mic);
    } catch {
      return null;
    }
  }

  function failUnsupported(kind: RecordingKind): false {
    updateSnap(
      { [kind]: "failed" },
      [kind === "audio" ? NOTICE.audioUnsupported : NOTICE.videoUnsupported]
    );
    return false;
  }

  // review-1 B4: getStream() (combine) or recorder.start() throwing counts as createRecorder throwing.
  // A recorder is kept only once it has started, so finish() never waits for one that can't stop.
  function startRecorder(getStream: () => StreamLike, kind: RecordingKind): boolean {
    let recorder: RecorderLike;
    try {
      recorder = deps.createRecorder(getStream(), kind);
    } catch {
      return failUnsupported(kind);
    }
    const kindChunks: Blob[] = [];
    const stopped = deferred<void>();
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        kindChunks.push(e.data);
      }
    };
    recorder.onstop = () => {
      stopped.resolve();
      updateSnap({ [kind]: "stopped" });
    };
    recorder.onerror = () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    };
    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch {
      return failUnsupported(kind);
    }
    recorders[kind] = recorder;
    chunks[kind] = kindChunks;
    stopPromises[kind] = stopped;
    updateSnap({ [kind]: "recording" });
    return true;
  }
`],
  // B1
  [`    // S3: wait for both promises to settle
    const micResult = micP
      ? (await Promise.allSettled([micP]))[0]
      : micThrew
        ? { status: "rejected" as const, reason: micThrew }
        : { status: "fulfilled" as const, value: null };
    const tabResult = tabP
      ? (await Promise.allSettled([tabP]))[0]
      : tabThrew
        ? { status: "rejected" as const, reason: tabThrew }
        : { status: "fulfilled" as const, value: null };
`, `    // S3: wait for both promises in ONE allSettled, so no rejection is ever left unhandled (review-1 B1)
    const [tabResult, micResult] = await Promise.allSettled([
      tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null)),
      micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null)),
    ]);
`],
  // B2
  [`    // S5/S6: handle blocked
    if (choice.audio && micRejected) {
      updateSnap({ audio: "failed" }, [NOTICE.micBlocked]);
    }
    if (choice.video && tabRejected) {
      updateSnap({ video: "failed" }, [NOTICE.tabBlocked]);
    }
`, `    // S5/S6: handle blocked, applied together in one change (review-1 B2)
    const blocked: Partial<RecordingSnapshot> = {};
    const blockedNotices: string[] = [];
    if (choice.audio && micRejected) {
      blocked.audio = "failed";
      blockedNotices.push(NOTICE.micBlocked);
    }
    if (choice.video && tabRejected) {
      blocked.video = "failed";
      blockedNotices.push(NOTICE.tabBlocked);
    }
    if (blockedNotices.length > 0) {
      updateSnap(blocked, blockedNotices);
    }
`],
  // B4: S8
  [`    // S8: create mixer and recorders
    mixer = deps.createMixer(micStream);

    let anyRecorder = false;

    if (canAudio) {
      if (startRecorder(mixer.stream, "audio")) {
        anyRecorder = true;
      }
    }

    if (canVideo) {
      const videoStream = deps.combine(tabStream!, mixer.stream);
      if (startRecorder(videoStream, "video")) {
        anyRecorder = true;
      }
    }
`, `    // S8: create mixer and recorders. createMixer throwing counts as createRecorder throwing
    // for each kind that would have started (review-1 B4).
    const mix = createMixerOrNull(micStream);
    mixer = mix;

    let anyRecorder = false;

    if (canAudio) {
      if (mix ? startRecorder(() => mix.stream, "audio") : failUnsupported("audio")) {
        anyRecorder = true;
      }
    }

    if (canVideo) {
      const tab = tabStream!;
      if (mix ? startRecorder(() => deps.combine(tab, mix.stream), "video") : failUnsupported("video")) {
        anyRecorder = true;
      }
    }
`],
  // B4: no mixer to dispose when createMixer threw
  ["      mixer.dispose();\n      updateSnap({ phase: \"finished\", files: [] });\n",
   "      mixer?.dispose();\n      updateSnap({ phase: \"finished\", files: [] });\n"],
];

const orig = readFileSync(file);
writeFileSync(bak, orig);
let s = orig.toString("utf8");
for (const [a, b] of FIXES) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log(`anchor found ${n} times: ${a.slice(0, 60)}`); process.exit(1); }
  s = s.replace(a, () => b);
}
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
const nm = (p) => join(repo, "node_modules", p);
const run = (args) => { const r = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "") }; };
try {
  writeFileSync(file, s);
  writeFileSync(revTest, readFileSync(join(repo, "agent-os/review/stage-10-tests/recording-review.test.ts.txt")));
  console.log(`before ${h(orig)} -> after ${h(Buffer.from(s, "utf8"))}`);
  const t = run([nm("typescript/bin/tsc"), "--noEmit"]);
  console.log(`tsc exit=${t.code}`); if (t.code) console.log(t.out.slice(0, 2000));
  const e = run([nm("eslint/bin/eslint.js"), "--max-warnings=0", "src/client/recording", "tests/s10fix-recording-review.test.ts"]);
  console.log(`eslint exit=${e.code}`); if (e.code) console.log(e.out.slice(0, 2000));
  const v = run([nm("vitest/vitest.mjs"), "run", "tests/recording-session.test.ts", "tests/recording-format.test.ts", "tests/recording-tap.test.ts", "tests/s10fix-recording-review.test.ts"]);
  console.log(`vitest exit=${v.code}`);
  for (const l of v.out.split("\n")) if (/^\s*(×|FAIL)|Tests\s|Errors|Unhandled|AssertionError/.test(l)) console.log(l.slice(0, 200));
} finally {
  writeFileSync(file, orig);
  if (existsSync(revTest)) rmSync(revTest);
  console.log(`restored ${h(readFileSync(file))}`);
}
