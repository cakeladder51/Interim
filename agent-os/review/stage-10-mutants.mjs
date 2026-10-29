// Stage 10 (recording) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-10-mutants.mjs --only=format,tap          (~3 min)
//   node agent-os/review/stage-10-mutants.mjs --only=session --part=1/2  (~5 min; then --part=2/2)
//   node agent-os/review/stage-10-mutants.mjs --restore     (restore files from on-disk backups after a kill)
//   node agent-os/review/stage-10-mutants.mjs --list        (list mutation counts by group)
//   node agent-os/review/stage-10-mutants.mjs --label="F5"  (only labels containing the substring)
//   node agent-os/review/stage-10-mutants.mjs --dry         (check every anchor resolves; "caught" = anchors found)
//   node agent-os/review/stage-10-mutants.mjs --reviewer    (also run agent-os/review/stage-10-tests/*.test.ts.txt that
//        are not yet in tests/ (round 1: recording-review), copied to tests/s10rev-*.test.ts for the run and deleted after)
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert, runs only the group's test files, records caught/missed.
// Every touched file is restored after each mutation and byte-verified at the end.
// On-disk backups (os.tmpdir()/interim-review/backup-s10) survive a hard kill: run --restore
// (first check the sources against the backups, see REVIEWER_HANDOFF §5).
// Output is compact: "caught X/Y", then one line per missed or skipped mutation.
// "SKIPPED: NOT FOUND" means the code moved; re-anchor that entry (don't drop it).
// Entries marked EQUIVALENT are expected to be MISSED.
//
// Anchors are against the round-2 builder code (recording-session d05c11bc): the S8 entries were re-anchored
// after review-1 R1-R6, and the B1-B4 reverts appended. tests/recording-review.test.ts is in the session group.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const reviewer = process.argv.includes("--reviewer");
const F = {
  format: { path: `${repo}/src/client/recording/recording-format.ts`, group: "format", tests: ["recording-format", "recording-session"] },
  session: { path: `${repo}/src/client/recording/recording-session.ts`, group: "session", tests: ["recording-session"] },
  tap: { path: `${repo}/src/client/voice/browser-audio.ts`, group: "tap", tests: ["recording-tap"] },
};
const GROUPS = [...new Set(Object.values(F).map((f) => f.group))];
const revDir = join(repo, "agent-os/review/stage-10-tests");
// reviewer files not already copied into tests/ (the 3 brief files are; recording-review is round-1's addition)
const revFiles = existsSync(revDir)
  ? readdirSync(revDir).filter((n) => n.endsWith(".test.ts.txt") && !existsSync(join(repo, "tests", n.replace(/\.txt$/, ""))))
  : [];
const revBase = (f) => f.replace(/\.test\.ts\.txt$/, "");
const inTests = (n) => existsSync(join(repo, "tests", `${n}.test.ts`));
const testFiles = (key) => {
  const own = F[key].tests.map((n) => `tests/${n}.test.ts`);
  // recording-review covers session only; once copied into tests/ it joins the session group automatically
  const extra = key === "session" ? (inTests("recording-review") ? ["tests/recording-review.test.ts"] : reviewer ? revFiles.map((f) => `tests/s10rev-${revBase(f)}.test.ts`) : []) : [];
  return [...own, ...extra].join(" ");
};
const bdir = join(tmpdir(), "interim-review", "backup-s10");

// [label, fileKey, from, to, nth?]   nth = 0-based occurrence when `from` is not unique
const M = [
  // ---- format: src/client/recording/recording-format.ts (§1) ----
  ["pick: audio order swapped", "format", '["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]', '["audio/webm", "audio/webm;codecs=opus", "audio/mp4"]'],
  ["pick: audio mp4 dropped", "format", '"audio/webm", "audio/mp4"]', '"audio/webm"]'],
  ["pick: video vp9 dropped", "format", '["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus",', '["video/webm;codecs=vp8,opus",'],
  ["pick: video mp4 dropped", "format", '"video/webm", "video/mp4"]', '"video/webm"]'],
  ["pick: vp8 before vp9", "format", '"video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"', '"video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus"'],
  ["pick: none supported -> first candidate", "format", '  return "";\n}', "  return candidates[0];\n}"],
  ["pick: last supported wins", "format", "      return candidate;\n", "      void candidate;\n"],
  ["ext: video/mp4 not mp4", "format", ' || mimeType.startsWith("video/mp4")', ""],
  ["ext: audio/mp4 not mp4", "format", 'mimeType.startsWith("audio/mp4") || ', ""],
  ["ext: any mp4 substring", "format", 'if (mimeType.startsWith("audio/mp4") || mimeType.startsWith("video/mp4")) {', 'if (mimeType.includes("mp4") || mimeType === "") {'],
  ["stamp: seconds instead of minutes", "format", "${iso.slice(14, 16)}", "${iso.slice(17, 19)}"],
  ["stamp: no dash after date", "format", "${iso.slice(0, 10)}-${", "${iso.slice(0, 10)}${"],
  ["stamp: local hours", "format", "${iso.slice(11, 13)}", "${String(new Date(ms).getHours() + 1).padStart(2, \"0\")}"],
  ["bytes: threshold 1_000_000", "format", "bytes < 999_500", "bytes < 1_000_000"],
  ["bytes: no minimum 1 KB", "format", "Math.max(1, Math.round(bytes / 1000))", "Math.round(bytes / 1000)"],
  ["bytes: floor", "format", "Math.max(1, Math.round(bytes / 1000))", "Math.max(1, Math.floor(bytes / 1000))"],
  ["bytes: 2 decimals", "format", "toFixed(1)", "toFixed(2)"],
  ["bytes: KiB", "format", "Math.round(bytes / 1000)", "Math.round(bytes / 1024)"],

  // ---- tap: src/client/voice/browser-audio.ts (§2) ----
  ["tap: playback not routed to tap", "tap", "      if (playbackTap) source.connect(playbackTap);\n", ""],
  ["tap: clearing ignored", "tap", "  playbackTap = node;", "  playbackTap = node ?? playbackTap;"],
  ["tap: tap replaces speakers", "tap", "      source.connect(getAudioContext().destination);\n      if (playbackTap)", "      if (!playbackTap) source.connect(getAudioContext().destination);\n      if (playbackTap)"],
  ["tap: tap before speakers", "tap", "      source.connect(getAudioContext().destination);\n      if (playbackTap) source.connect(playbackTap);\n", "      if (playbackTap) source.connect(playbackTap);\n      source.connect(getAudioContext().destination);\n"],

  // ---- session: src/client/recording/recording-session.ts (§3) ----
  ["N1: snapshot copied on read", "session", "    return snapshot;\n  }\n\n  function subscribe", "    return { ...snapshot };\n  }\n\n  function subscribe"],
  ["N1: notices replaced, not appended (caught only by review-1 B2/B4 tests)", "session", "? [...baseNotices, ...appendNotices]", "? [...appendNotices]"],
  ["N2: unsubscribe does nothing", "session", "      listeners.delete(listener);\n", ""],
  ["N3: emits after dispose (EQUIVALENT since round 2: updateSnap, the only caller of emit, returns first when disposed)", "session", ["    if (disposed) return;\n    for (const listener", "    listeners.clear();\n"], ["    for (const listener", ""]],
  ["S1: nothing chosen still requests", "session", "    if (!choice.audio && !choice.video) {\n      // S1", "    if (false) {\n      // S1"],
  ["S1: start not once (both guards)", "session", ["      if (startPromise) return startPromise;\n", "if (started || disposed"], ["", "if (disposed"]],
  ["S1: start after finish runs", "session", " || startCompleted || finishPromise) {", " || startCompleted) {"],
  ["S1: start after dispose runs", "session", "if (started || disposed || ", "if (started || "],
  ["S2: kinds not set to starting", "session", "updateSnap({ phase: \"starting\", audio: audioStatus, video: videoStatus });", "updateSnap({ phase: \"starting\" });"],
  ["S2: await before requests", "session", "    let micP: Promise<StreamLike> | null = null;\n", "    await Promise.resolve();\n    let micP: Promise<StreamLike> | null = null;\n"],
  ["S2: mic before tab", "session", ["        micP = deps.getMic();", "        tabP = deps.getTab();"], ["        micP = micP ?? deps.getMic();", "        micP = deps.getMic(); tabP = deps.getTab();"]],
  ["S2: no mic for video only", "session", "    if (choice.audio || choice.video) {\n      try {\n        micP", "    if (choice.audio) {\n      try {\n        micP"],
  ["S2: tab requested for audio only", "session", "    if (choice.video) {\n      try {\n        tabP", "    if (true) {\n      try {\n        tabP"],
  ["S3: sync mic throw escapes", "session", "        micThrew = e instanceof Error ? e : new Error(String(e));", "        throw e;"],
  ["S4: disposed-while-waiting check removed", "session", "    if (disposed) {\n      // S4", "    if (false) {\n      // S4"],
  ["S4: late mic not released", "session", "        stopAllTracks(micResult.value);\n", ""],
  ["S4: late tab not released", "session", "        stopAllTracks(tabResult.value);\n", ""],
  ["S5: mic blocked not reported", "session", "    if (choice.audio && micRejected) {", "    if (false) {"],
  ["S5: mic notice text", "session", "\"Microphone access was blocked, so your audio isn't being recorded.\"", "\"Microphone access was blocked.\""],
  ["S6: tab blocked not reported", "session", "    if (choice.video && tabRejected) {", "    if (false) {"],
  ["S6: tab notice text", "session", "\"Screen sharing was cancelled or blocked, so video isn't being recorded.\"", "\"Screen sharing was blocked.\""],
  ["S7: canAudio ignores the mic", "session", "const canAudio = choice.audio && micGranted;", "const canAudio = choice.audio;"],
  ["S7: canVideo ignores the tab", "session", "const canVideo = choice.video && tabGranted;", "const canVideo = choice.video;"],
  ["S7: granted mic kept", "session", "    if (!canAudio && !canVideo) {\n      stopAllTracks(micStream);\n", "    if (!canAudio && !canVideo) {\n"],
  ["S7: phase not finished", "session", "      updateSnap({ phase: \"finished\", files: [] });\n      startCompleted = true;\n      return;\n    }\n\n    // S8", "      startCompleted = true;\n      return;\n    }\n\n    // S8"],
  // round 2: S8 entries re-anchored to the R2/R5/R6 code (recording-session d05c11bc)
  ["S8: mixer without the mic", "session", "const mix = createMixerOrNull(micStream);", "const mix = createMixerOrNull(null);"],
  ["S8: video without the mix", "session", "startRecorder(() => deps.combine(tab, mix.stream), \"video\")", "startRecorder(() => tab, \"video\")"],
  ["S8: timeslice 0", "session", "recorder.start(RECORDER_TIMESLICE_MS);", "recorder.start(0);"],
  ["S8: timeslice constant 500", "session", "export const RECORDER_TIMESLICE_MS = 1000;", "export const RECORDER_TIMESLICE_MS = 500;"],
  ["S8: kind not set recording", "session", "    stopPromises[kind] = stopped;\n    updateSnap({ [kind]: \"recording\" });\n", "    stopPromises[kind] = stopped;\n"],
  ["S8: unsupported notices swapped", "session", "[kind === \"audio\" ? NOTICE.audioUnsupported : NOTICE.videoUnsupported]", "[kind === \"audio\" ? NOTICE.videoUnsupported : NOTICE.audioUnsupported]"],
  ["S8: unsupported kind not failed", "session", "      { [kind]: \"failed\" },\n      [kind ===", "      {},\n      [kind ==="],
  ["S8: no recorder: tracks kept", "session", "    if (!anyRecorder) {\n      stopAllTracks(micStream);\n", "    if (!anyRecorder) {\n"],
  ["S8: no recorder: mixer kept", "session", "      mixer?.dispose();\n      updateSnap({ phase: \"finished\", files: [] });", "      updateSnap({ phase: \"finished\", files: [] });"],
  ["S8: phase not recording", "session", "    updateSnap({ phase: \"recording\" });\n", ""],
  ["S8: empty chunks kept (EQUIVALENT: size-0 blobs add no bytes)", "session", "      if (e.data.size > 0) {", "      if (true) {"],
  ["S8: onerror does nothing", "session", "      if (recorder.state !== \"inactive\") {\n        recorder.stop();\n      }\n    };\n    try {", "      if (false) {\n        recorder.stop();\n      }\n    };\n    try {"],
  ["S8: onstop status not set", "session", "      updateSnap({ [kind]: \"stopped\" });\n", ""],
  ["S8: onstop never resolves", "session", "      stopped.resolve();\n", ""],
  // round 2: review-1 B1-B4 reverts
  ["B1: sequential awaits, mic first", "session",
    "    const [tabResult, micResult] = await Promise.allSettled([\n      tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null)),\n      micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null)),\n    ]);\n",
    "    const micResult = (await Promise.allSettled([micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null))]))[0];\n    const tabResult = (await Promise.allSettled([tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null))]))[0];\n"],
  ["B1: sequential awaits, tab first", "session",
    "    const [tabResult, micResult] = await Promise.allSettled([\n      tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null)),\n      micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null)),\n    ]);\n",
    "    const tabResult = (await Promise.allSettled([tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null))]))[0];\n    const micResult = (await Promise.allSettled([micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null))]))[0];\n"],
  ["B2: S5 applied as its own change", "session", "      blocked.audio = \"failed\";\n      blockedNotices.push(NOTICE.micBlocked);\n", "      updateSnap({ audio: \"failed\" }, [NOTICE.micBlocked]);\n"],
  ["B3: updateSnap ignores dispose", "session", "    if (disposed) return;\n    const baseNotices", "    const baseNotices"],
  ["B4: createMixer throw escapes", "session", "      return deps.createMixer(mic);\n    } catch {\n      return null;", "      return deps.createMixer(mic);\n    } catch (e) {\n      throw e;"],
  ["B4: no mixer: audio not failed", "session", ": failUnsupported(\"audio\")", ": false"],
  ["B4: no mixer: video not failed", "session", ": failUnsupported(\"video\")", ": false"],
  ["B4: recorder.start() throw not caught", "session", "    try {\n      recorder.start(RECORDER_TIMESLICE_MS);\n    } catch {\n      return failUnsupported(kind);\n    }\n", "    recorder.start(RECORDER_TIMESLICE_MS);\n"],
  ["B4: recorder kept before start()", "session",
    ["    try {\n      recorder.start(RECORDER_TIMESLICE_MS);", "    recorders[kind] = recorder;\n    chunks[kind] = kindChunks;\n    stopPromises[kind] = stopped;\n    updateSnap"],
    ["    recorders[kind] = recorder;\n    chunks[kind] = kindChunks;\n    stopPromises[kind] = stopped;\n    try {\n      recorder.start(RECORDER_TIMESLICE_MS);", "    updateSnap"]],
  ["B4: combine outside the try", "session", "if (mix ? startRecorder(() => deps.combine(tab, mix.stream), \"video\")", "if (mix ? ((s) => startRecorder(() => s, \"video\"))(deps.combine(tab, mix.stream))"],
  ["S9: no Stop sharing listener", "session", "        if (track.kind === \"video\") {", "        if (false) {"],
  ["S9: Stop sharing stops audio too", "session", "              vidRecorder.stop();\n", "              vidRecorder.stop();\n              recorders.audio?.stop();\n"],
  ["F1: not idempotent", "session", "    if (finishPromise) {\n      return finishPromise;", "    if (false) {\n      return finishPromise;"],
  ["F1: finish-before-start not finished", "session", "      updateSnap({ phase: \"finished\" });\n      finishPromise = Promise.resolve([]);", "      finishPromise = Promise.resolve([]);"],
  ["F2: does not wait for start", "session", "    if (startPromise && !startCompleted) {\n      await startPromise;", "    if (false) {\n      await startPromise;"],
  ["F2: already-finished re-finishes", "session", "    if (snapshot.phase === \"finished\") {\n      return snapshot.files;", "    if (false) {\n      return snapshot.files;"],
  ["F3: finishing not synchronous (EQUIVALENT in rounds 1-2: doFinishInner sets finishing before its first await)", "session", "    if (startCompleted && snapshot.phase === \"recording\") {\n      updateSnap({ phase: \"finishing\" });\n    }\n", ""],
  ["F3: recorders not stopped", "session", "    // Stop any running recorders\n    for (const kind of [\"audio\", \"video\"] as RecordingKind[]) {", "    // Stop any running recorders\n    for (const kind of [] as RecordingKind[]) {"],
  ["F3: no wait for onstop", "session", "    await Promise.all(stopPs);\n", ""],
  ["F4: disposed during wait not checked", "session", "    await Promise.all(stopPs);\n\n    if (disposed) {\n      return [];\n    }\n", "    await Promise.all(stopPs);\n"],
  ["F4: mic kept after finish", "session", "    // F4: stop streams and dispose mixer\n    stopAllTracks(micStream);\n", "    // F4: stop streams and dispose mixer\n"],
  ["F4: tab kept after finish", "session", "    stopAllTracks(tabStream);\n    if (mixer) {\n      mixer.dispose();\n    }\n\n    // F5", "    if (mixer) {\n      mixer.dispose();\n    }\n\n    // F5"],
  ["F4: mixer kept after finish", "session", "    if (mixer) {\n      mixer.dispose();\n    }\n\n    // F5", "\n    // F5"],
  ["F5: empty audio makes a file", "session", "      if (audioBytes === 0) {", "      if (false) {"],
  ["F5: empty video makes a file", "session", "      if (videoBytes === 0) {", "      if (false) {"],
  ["F5: empty audio not failed", "session", "        newFailedKinds.audio = \"failed\";\n", ""],
  ["F5: audioEmpty notice dropped", "session", "        newNotices.push(NOTICE.audioEmpty);\n", ""],
  ["F5: videoEmpty notice dropped", "session", "        newNotices.push(NOTICE.videoEmpty);\n", ""],
  ["F5: audio mime fallback dropped", "session", "rec.mimeType || \"audio/webm\"", "rec.mimeType"],
  ["F5: video mime fallback dropped", "session", "rec.mimeType || \"video/webm\"", "rec.mimeType"],
  ["F5: blob untyped", "session", "new Blob(audioChunks, { type: mimeType })", "new Blob(audioChunks)"],
  ["F5: audio extension fixed webm", "session", "-audio.${extensionFor(mimeType)}", "-audio.webm"],
  ["F5: video extension fixed webm", "session", "-video.${extensionFor(mimeType)}", "-video.webm"],
  ["F5: filename stamp from 0", "session", "interim-${fileStamp(deps.now())}-audio", "interim-${fileStamp(0)}-audio"],
  ["F6: notices not set", "session", "newNotices.length > 0 ? newNotices : undefined", "undefined"],
  ["F6: failed kinds not set", "session", "        ...newFailedKinds,\n", ""],
  ["F6: files not in snapshot", "session", "        phase: \"finished\",\n        files,\n", "        phase: \"finished\",\n"],
  ["D1: not idempotent", "session", "    if (disposed) return;\n    disposed = true;", "    disposed = true;"],
  ["D1: recorders not stopped", "session", "      if (rec && rec.state !== \"inactive\") {\n        rec.stop();\n      }\n    }\n\n    // Stop streams", "    }\n\n    // Stop streams"],
  ["D1: mic not stopped", "session", "    // Stop streams\n    stopAllTracks(micStream);\n", "    // Stop streams\n"],
  ["D1: mixer not disposed", "session", "    // Dispose mixer\n    if (mixer) {", "    // Dispose mixer\n    if (false) {"],
  ["D1: URLs not revoked", "session", "      deps.revokeObjectURL(file.url);\n", ""],
];

if (process.argv.includes("--list")) {
  for (const g of GROUPS) console.log(`${g}: ${M.filter((m) => F[m[1]].group === g).length}`);
  process.exit(0);
}
if (process.argv.includes("--restore")) {
  let n = 0;
  for (const [k, v] of Object.entries(F)) if (existsSync(join(bdir, k))) { writeFileSync(v.path, readFileSync(join(bdir, k))); n++; }
  for (const f of readdirSync(join(repo, "tests"))) if (f.startsWith("s10rev-")) rmSync(join(repo, "tests", f));
  console.log(`restored ${n} file(s) from ${bdir}`); process.exit(0);
}

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const groups = only.length ? only : GROUPS;
const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8);
const orig = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, readFileSync(v.path)]));
mkdirSync(bdir, { recursive: true });
for (const k of Object.keys(F)) writeFileSync(join(bdir, k), orig[k]);
const copies = [];
if (reviewer) {
  for (const f of revFiles) {
    const dest = join(repo, "tests", "s10rev-" + f.replace(/\.txt$/, ""));
    writeFileSync(dest, readFileSync(join(revDir, f)));
    copies.push(dest);
  }
}
const restore = () => { for (const [k, v] of Object.entries(F)) writeFileSync(v.path, orig[k]); };
process.on("exit", () => { restore(); for (const c of copies) if (existsSync(c)) rmSync(c); });
process.on("SIGINT", () => { process.exit(1); });

function replaceNth(src, from, to, nth) {
  const idxs = []; let i = -1;
  while ((i = src.indexOf(from, i + 1)) !== -1) idxs.push(i);
  if (idxs.length === 0) return { err: "NOT FOUND" };
  if (nth === undefined && idxs.length > 1) return { err: `AMBIGUOUS (${idxs.length})` };
  if ((nth ?? 0) >= idxs.length) return { err: "NOT FOUND (nth)" };
  return { out: src.slice(0, idxs[nth ?? 0]) + to + src.slice(idxs[nth ?? 0] + from.length) };
}
// `from`/`to` may be parallel arrays: a multi-spot revert (each anchor must be unique), applied in order.
function applyMutation(src, from, to, nth) {
  if (!Array.isArray(from)) return replaceNth(src, from, to, nth);
  let out = src;
  for (let i = 0; i < from.length; i++) {
    const r = replaceNth(out, from[i], to[i]);
    if (r.err) return r;
    out = r.out;
  }
  return { out };
}
const runTests = (files) => {
  let o = "";
  // --skip-bugs: leave out the review-1 B1-B4 tests (they fail on the unfixed round-1 code) so --reviewer can
  // measure the G-gap tests before round 2. Drop the flag once B1-B4 are fixed.
  const t = process.argv.includes("--skip-bugs") ? ' -t "^(?!.*B[1-4][: ]).*$"' : "";
  try { o = execSync(`npx vitest run ${files}${t}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, timeout: 240000 }); }
  catch (e) { o = (e.stdout ?? "") + (e.stderr ?? ""); }
  return o.replace(/\x1b\[[0-9;]*m/g, "");
};

const [partK, partN] = ((process.argv.find((a) => a.startsWith("--part=")) ?? "--part=1/1").slice(7)).split("/").map(Number);
const selected = M.filter(([label, key]) => groups.includes(F[key].group) && (!labelFilter || label.includes(labelFilter)));
const sliceLen = Math.ceil(selected.length / partN);
const mine = selected.slice((partK - 1) * sliceLen, partK * sliceLen);

let total = 0, caught = 0; const lines = [];
for (const [label, key, from, to, nth] of mine) {
  total++;
  restore();
  const r = applyMutation(orig[key].toString("utf8"), from, to, nth);
  if (r.err) { lines.push(`SKIPPED (${r.err}): ${label}`); continue; }
  if (process.argv.includes("--dry")) { caught++; continue; }
  writeFileSync(F[key].path, r.out);
  const out = runTests(testFiles(key));
  const summary = (out.match(/Tests\s+.*$/m) ?? [""])[0];
  // an unhandled error (vitest "Errors" line) also counts as caught: the suite exits non-zero
  if (/\d+ failed/.test(summary) || /Errors\s+\d+ error/.test(out) || /Failed Suites|Error:/.test(out) && !/passed \(\d+\)\s*$/.test(summary)) caught++;
  else lines.push(`MISSED: ${label}`);
}
restore();
const bad = Object.entries(F).filter(([k, v]) => !readFileSync(v.path).equals(orig[k])).map(([k]) => k);
console.log(`groups=${groups.join(",")}${reviewer ? " (reviewer tests)" : ""} caught ${caught}/${total}`);
for (const l of lines) console.log(l);
console.log(bad.length ? `RESTORE MISMATCH: ${bad.join(",")} — run with --restore` : "restore: all files byte-identical");
