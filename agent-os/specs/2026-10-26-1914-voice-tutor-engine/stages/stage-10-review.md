# Stage 10 review, round 1: fixes needed (recording)

You're starting a fresh session. Read `STATUS.md` and `stage-10-recording.md` (the brief) first; `plan.md` is historical. **This round changes one source file and adds one test file. Nothing else.**

**The brief and these fixes are correct. Never edit an expectation or a test to make it pass.** If something still fails after you apply the replacements exactly, stop and write it in `STAGE10_NOTES.md`.

## What passed
- **Scope:** only the brief's files changed. The 4 edited files hash to the brief's "after" values and reverse exactly to their pre-stage hashes (`agent-os/review/stage-10-unfreeze.mjs`). The 3 test files are byte-identical to their `.txt` sources, and all 12 reviewer test copies from Stages 7–10 are unchanged.
- **Checks** (checker `s10-r1-check-2`, spot-checked): tsc 0, eslint 0/0, no-key build OK. **vitest exits 0 (904, no Errors line)**, and no test names were lost against Stage 9's 873.
- **F5/F6** (the round-1 `newNotices` change): the empty-recording notices are collected in F5 and set in the single F6 change. This is correct.
- **`recording-format.ts`**, the **`browser-audio` tap**, **`browser-recording.ts`**, **`InterviewGate`**, **`RecordingBadge`**, **`RecordingDownloads`** and the page edits match §1, §2 and §4–§7:
  - `getTab` is called before `getMic`, synchronously inside the submit click.
  - The mic only goes to the mix, never to `ctx.destination`.
  - `setPlaybackTap(null)` runs on mixer dispose.
  - No browser API runs at import time.
  - The Gate disposes the session on unmount.
  - There's no `setState` in an effect.
  - `subscribe` and `snapshot` work unbound.
- **Accepted as equivalent; no change needed:**
  - `getMic`/`getTab` are `async` functions that throw, not functions returning `Promise.reject(...)`. An async body runs synchronously up to its first `await`, so `getDisplayMedia` is still called inside the click.
  - `createRecorder` casts to an inline type that's identical to `RecorderLike`.
- **Bundle:** 0 secret or prompt strings in `.next/static` or the prerendered output, with positive controls found ("Before you start", "Saving your recording"). **Offline `next dev`:** `/interview` shows the consent dialog first (2 checkboxes, no End button), and `/` shows the new line.
- **Revert checks** (`agent-os/review/stage-10-mutants.mjs`): format 18/18, tap 4/4, session 60/71. Of the 11 misses, 2 are equivalent; the other 9 are the gaps that T1 below covers.

## Bugs (all in `src/client/recording/recording-session.ts`)
Each one was reproduced against your code (`agent-os/review/stage-10-probe.ts`).

- **B1. An unhandled promise rejection when the tab share is refused while the mic prompt is still open.** S3 awaits `Promise.allSettled([micP])` and only then `Promise.allSettled([tabP])`, so while the mic is pending, a rejected `tabP` has no handler.
  - **Reproduced:** `getTab` rejects and `getMic` resolves 50 ms later → 1 `unhandledRejection` ("tab NotAllowedError").
  - In the browser this logs "Uncaught (in promise)", and in `next dev` it raises the error overlay. The brief says to wait with `Promise.allSettled`, which means one call over both promises.
- **B2. S5 and S6 are two changes; the brief says "Apply S5 and S6 together in one change".**
  - **Reproduced:** with both blocked, the emits are `starting`, then `audio failed` (1 notice), then `video failed` (2 notices), then `finished`. The brief requires one change in which both have failed.
- **B3. The snapshot changes after `dispose()` (N3: "after dispose(), nothing changes the snapshot").** `updateSnap` only skips the *emit* when the session is disposed, so a recorder's late `onstop` still replaces the snapshot.
  - **Reproduced:** dispose while recording → after a tick, `snapshot()` is a new object with `audio: "stopped"`.
- **B4. `start()` can reject, and `finish()` can hang.** This is a case the brief didn't cover, so it's specified here:
  - `createMixer` throwing (for example, no Web Audio) makes **`start()` reject**. That breaks "start never rejects": the Gate stays on "Waiting for permission…" forever, and the granted mic/tab streams are never released.
    - **Reproduced:** `start` rejected "no AudioContext", with phase `starting`.
  - `combine` throwing also makes `start()` reject.
  - `recorder.start()` throwing (`MediaRecorder.start` can throw `NotSupportedError`) is caught, but the recorder has **already been stored** with an unresolved stop promise. With audio+video, `finish()` then **never resolves**, and the ended screen shows "Saving your recording…" forever.
    - **Reproduced:** with only the video recorder's `start()` throwing, `finish()` was still pending after 200 ms (phase `finishing`).

  **The rule (it extends S8):**
  - `combine` throwing, or `recorder.start()` throwing, counts exactly as `createRecorder` throwing: that kind becomes `"failed"`, `NOTICE.audioUnsupported`/`videoUnsupported` is appended, and **the recorder isn't kept** (`finish` neither stops it nor waits for it).
  - `createMixer` throwing counts as `createRecorder` throwing for each kind that would have started, audio first. Then the existing "no recorder was created" path runs (stop every track, `phase: "finished"`); there's no mixer to dispose.

## Fixes: six exact replacements in `recording-session.ts`
Make each replacement exactly as written (LF line endings, same indentation). **Afterwards the file must hash to `d05c11bc`** (SHA-256 prefix; it's `ea510168` now). The reviewer applied these six to a copy of your file: tsc 0, eslint 0, and 44/44 across the 3 brief test files plus T1's file.

**R1 (B3).** Replace:
```ts
    appendNotices?: string[]
  ): void {
    const baseNotices = snapshot.notices;
```
with:
```ts
    appendNotices?: string[]
  ): void {
    if (disposed) return;
    const baseNotices = snapshot.notices;
```

**R2 (B4).** Replace the whole `startRecorder` function, from `  function startRecorder(stream: StreamLike, kind: RecordingKind): boolean {` through its closing `  }` (it ends with the three lines `      return false;`, `    }`, `  }`), with:
```ts
  function createMixerOrNull(mic: StreamLike | null): Mixer | null {
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
```

**R3 (B1).** Replace:
```ts
    // S3: wait for both promises to settle
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
```
with:
```ts
    // S3: wait for both promises in ONE allSettled, so no rejection is ever left unhandled (review-1 B1)
    const [tabResult, micResult] = await Promise.allSettled([
      tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null)),
      micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null)),
    ]);
```

**R4 (B2).** Replace:
```ts
    // S5/S6: handle blocked
    if (choice.audio && micRejected) {
      updateSnap({ audio: "failed" }, [NOTICE.micBlocked]);
    }
    if (choice.video && tabRejected) {
      updateSnap({ video: "failed" }, [NOTICE.tabBlocked]);
    }
```
with:
```ts
    // S5/S6: handle blocked, applied together in one change (review-1 B2)
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
```

**R5 (B4).** Replace:
```ts
    // S8: create mixer and recorders
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
```
with:
```ts
    // S8: create mixer and recorders. createMixer throwing counts as createRecorder throwing
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
```

**R6 (B4).** In the `if (!anyRecorder) {` block, replace:
```ts
      mixer.dispose();
      updateSnap({ phase: "finished", files: [] });
```
with:
```ts
      mixer?.dispose();
      updateSnap({ phase: "finished", files: [] });
```

## Test gaps
- **T1.** Copy `agent-os/review/stage-10-tests/recording-review.test.ts.txt` to `tests/recording-review.test.ts`, **byte for byte** (SHA-256 starts with `e16808a0`). It holds 13 tests:
  - **B1** (2): no unhandled rejection whichever prompt is refused first
  - **B2:** the exact emit sequence
  - **B3:** snapshot identity after dispose
  - **B4** (4): `start()` throwing for video only, for the only recorder; `createMixer` throwing; `combine` throwing
  - **G1:** `finish()` after S7 changes nothing and releases nothing twice. The revert "already-finished re-finishes" was missed.
  - **G2:** an empty audio recording gives `audio: "failed"` and `NOTICE.audioEmpty`; `audio/mp4` gives `.mp4`; an empty video `mimeType` falls back to `video/webm`. Five revert misses.
  - **G3:** dispose while `finish` waits resolves `[]` and builds no file. The F4 disposed check was missed.
  - **G4:** start after dispose calls nothing (missed).
  - **G5:** every method works unbound (N4).

  It was verified against the reviewer's reference (13/13). Against your current code, exactly the 6 B-tests fail and the G-tests pass. With R1–R6 applied, all 13 pass.

## Constraints for this pass
- **Allowed changes, and nothing else:**
  - `src/client/recording/recording-session.ts`: only R1–R6, so it hashes to `d05c11bc`
  - new: `tests/recording-review.test.ts`, a byte-identical copy (`e16808a0`)
  - `STAGE10_NOTES.md`: add a short "Round 2" section
- **Everything else is frozen**, including:
  - the other Stage 10 files: recording-format `56272d19`, browser-recording `9992ab97`, InterviewGate `191f94f8`, RecordingBadge `0474e7d3`, RecordingDownloads `c91955c7`, browser-audio `47d96cd3`, `app/page` `d80d1428`, `interview/page` `bfe5ccf3`, InterviewScreen `6a52d4e5`
  - every existing test file, and everything under `agent-os/`
- **Don't add, remove or rename any test.** Don't touch the three brief test files.

## Acceptance
1. `recording-session.ts` hashes to `d05c11bc`; `tests/recording-review.test.ts` is byte-identical to its `.txt` source; every other file is unchanged.
2. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 problems, and `npx next build` with no keys set passes.
3. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** It runs **917 tests** (904 + 13), and no test name disappears.
