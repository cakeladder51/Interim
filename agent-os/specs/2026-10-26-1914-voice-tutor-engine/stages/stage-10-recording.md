# Stage 10 brief: Recording (B4 consent, B8) (handoff to the external model)

## Goal
Before an interview starts, the student sees a short **consent dialog** with two optional checkboxes: **Audio** and **Video**. Then:
- If they tick something, the browser asks for permission (microphone; tab sharing for video), and recording starts as the interview starts.
- **Audio** is a mix of the student's microphone and the interviewer's TTS voice.
- **Video** is a capture of this browser tab, with the same mixed audio.
- When the interview ends, the recording stops, and the ended screen offers **downloads**.
- **Nothing is uploaded, and there is no server code in this stage.**

**Build and test everything offline:**
- Never call any external API.
- Never read or add keys.
- Tests run in vitest's node environment with fakes. Real-browser checks are held (see the end of this brief).

---

## What already exists: read this first
You're starting in a fresh session.
- **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win.
- `STATUS.md` lists completed stages, frozen file hashes and held items.
- **This repo uses Next.js 16.4 with breaking changes.** Read the relevant guide in `node_modules/next/dist/docs/` (client components) before writing UI code, and heed deprecation notices.

**Stack:**
- Next.js 16.4 App Router with `cacheComponents: true`. React 19.3, TypeScript strict, zod v4.
- vitest runs in a **node environment** (no DOM, no `window`). Tests go in `tests/` and run with `npx vitest run`. `@/*` maps to `src/*`.
- ESLint is `eslint-config-next` (core-web-vitals + typescript, including the React hooks/compiler rules):
  - **No `any`.**
  - Don't read `ref.current` during render.
  - **Don't call `setState` synchronously inside an effect body.** The design below avoids it, so keep to it.
- **`reactStrictMode` is on in dev,** so effects run mount → cleanup → mount.

**The interview flow today:**
- **`src/app/page.tsx`** (server component; start page): a GET form with Subject and Interviewer style radios that submits to `/interview?config=…&style=…`. Below the button it shows `Text mode. Voice and whiteboard are coming soon.`, which is out of date.
- **`src/app/interview/page.tsx`** (server component): it validates the params inside `<Suspense>`, then ends with `return <InterviewScreen config={publicConfig} styleId={styleId} />;`.
  - `PublicConfig` (from `@/config/public`) has `id`, `subject`, `styles: { id, label }[]`, `timing.maxMinutes` and more. It never has the solutions.
- **`src/app/interview/InterviewScreen.tsx`** (`"use client"`) has props `{ config: PublicConfig; styleId: string }`.
  - It calls `useInterview(config.id, styleId, …)`, which **starts the interview as soon as it mounts**.
  - Its header's right-hand `<div className="flex items-center gap-4">` holds the timer and the End button.
  - When the interview ends (`isEnded`), the bottom area shows "Interview complete.", then `<FeedbackPanel …/>`, then a "Start another interview" link to `/`.
- **`src/client/voice/browser-audio.ts`** (frozen since Stage 7; §2 unfreezes two exact edits):
  - `getAudioContext()` returns the app's single shared `AudioContext`.
  - `playAudioBuffer(bytes)` plays provider TTS audio: it decodes the bytes, creates an `AudioBufferSourceNode`, and runs `source.connect(getAudioContext().destination)`.
  - `speakWithSynthesis(text)` is the `speechSynthesis` fallback that's used when `/api/tts` has no key (always, offline). **Browser speech-synthesis output can't be captured**, so offline the interviewer's voice won't be in the recording. That's expected; just note it in `STAGE10_NOTES.md`.
- **Voice mode** has its own microphone stream (`startBrowserMic`). The recording uses a **separate** `getUserMedia` stream, so voice mode and recording don't depend on each other.

**Why the dialog is on `/interview`, not on the start page:**
- Permission prompts (`getUserMedia`, `getDisplayMedia`) need a click on the page that will record.
- A full-page navigation from `/` would drop any streams.

So the dialog is the first thing `/interview` shows, and `InterviewScreen`, which starts the interview, mounts only after the student submits it.

---

## Constraints
- **New files allowed:**
  - `src/client/recording/recording-format.ts`
  - `src/client/recording/recording-session.ts`
  - `src/client/recording/browser-recording.ts`
  - `src/app/interview/InterviewGate.tsx`
  - `src/app/interview/RecordingBadge.tsx`
  - `src/app/interview/RecordingDownloads.tsx`
  - `tests/recording-session.test.ts`, `tests/recording-format.test.ts` and `tests/recording-tap.test.ts`, as **byte-identical copies** of the reviewer's files (see "Tests")
  - `STAGE10_NOTES.md`
- **Modified files allowed,** with the exact edits below and nothing else:

  | File | Edits | SHA-256 now | SHA-256 after |
  |---|---|---|---|
  | `src/client/voice/browser-audio.ts` | §2 | `9e74711f` | `47d96cd3` |
  | `src/app/page.tsx` | §6 | `2ca9dfa5` | `d80d1428` |
  | `src/app/interview/page.tsx` | §6 | `5d3f77bd` | `bfe5ccf3` |
  | `src/app/interview/InterviewScreen.tsx` | §7 | `ee37d724` | `6a52d4e5` |

  These "after" hashes assume the edits are made exactly as written, with LF line endings, which the files already use.
- **Frozen; SHA-256 checked:** every other file under `src/`, plus:
  - `public/`, `relay/`, `configs/`, `evals/`, `scripts/`, `tests/helpers/`
  - **every existing test file**, including the reviewer copies listed in `STATUS.md`
  - `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
  - `.env.example`, `.env.local`
  - everything under `agent-os/`
- **No new dependencies.**
- **Never edit a frozen file to get around a problem,** and **never edit a test to make it pass.** The three test files were verified by the reviewer against a reference implementation (31/31 passing, tsc and eslint clean). If something blocks you, stop and write it in `STAGE10_NOTES.md`.
- **Add tests if you like; don't delete or weaken any.** Test names are compared file by file.
- **No file in this stage may import from `src/server/*`, `src/lib/*` or `src/config/load.ts`.**
- **Nothing in this stage logs anything,** and nothing is sent over the network.

---

## 1. `src/client/recording/recording-format.ts` (new; pure)
```ts
export type RecordingKind = "audio" | "video";
export function pickMimeType(kind: RecordingKind, isTypeSupported: (type: string) => boolean): string;
export function extensionFor(mimeType: string): "webm" | "mp4";
export function fileStamp(ms: number): string;
export function formatBytes(bytes: number): string;
```
- **`pickMimeType`** checks these candidates **in order** and returns the first one for which `isTypeSupported` returns true, or `""` if none is supported. It stops at the first supported one.
  - audio: `"audio/webm;codecs=opus"`, `"audio/webm"`, `"audio/mp4"`
  - video: `"video/webm;codecs=vp9,opus"`, `"video/webm;codecs=vp8,opus"`, `"video/webm"`, `"video/mp4"`
- **`extensionFor`** returns `"mp4"` if `mimeType` starts with `"audio/mp4"` or `"video/mp4"`. Otherwise it returns `"webm"` (including for `""`).
- **`fileStamp(ms)`** gives the UTC time as `YYYY-MM-DD-HHMM`: take `iso = new Date(ms).toISOString()`, then return `` `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}` ``. For example, `Date.UTC(2026, 9, 29, 14, 5, 59)` gives `"2026-10-29-1405"`.
- **`formatBytes(n)`:**
  - if `n < 999_500`, return `` `${Math.max(1, Math.round(n / 1000))} KB` ``
  - otherwise return `` `${(n / 1_000_000).toFixed(1)} MB` ``

## 2. `src/client/voice/browser-audio.ts` (exactly two edits; nothing else)
1. Directly after the line `let workletLoaded = false;`, insert:
   ```ts
   let playbackTap: AudioNode | null = null;

   /** Stage 10 recording: TTS playback is also routed into this node while it's set. */
   export function setPlaybackTap(node: AudioNode | null): void {
     playbackTap = node;
   }
   ```
2. In `playAudioBuffer`, directly after `      source.connect(getAudioContext().destination);`, insert this line with the same 6-space indentation:
   ```ts
         if (playbackTap) source.connect(playbackTap);
   ```

## 3. `src/client/recording/recording-session.ts` (new; React-free, DOM-free, all I/O injected)
Copy this declaration block **exactly**; the tests import these names:
```ts
import { extensionFor, fileStamp, type RecordingKind } from "./recording-format";

export type { RecordingKind };
export interface RecordingChoice { audio: boolean; video: boolean }
export interface TrackLike { readonly kind: string; stop(): void; addEventListener(type: "ended", listener: () => void): void }
export interface StreamLike { getTracks(): TrackLike[] }
export interface BlobEventLike { data: Blob }
export interface RecorderLike {
  readonly mimeType: string;
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((e: BlobEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs: number): void;
  stop(): void;
}
export interface Mixer { stream: StreamLike; dispose(): void }
export interface RecordingDeps {
  getMic(): Promise<StreamLike>;
  getTab(): Promise<StreamLike>;
  createMixer(mic: StreamLike | null): Mixer;
  combine(tab: StreamLike, audio: StreamLike): StreamLike;
  createRecorder(stream: StreamLike, kind: RecordingKind): RecorderLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
}
export type KindStatus = "off" | "starting" | "recording" | "stopped" | "failed";
export interface RecordingFile { kind: RecordingKind; url: string; filename: string; bytes: number; mimeType: string }
export interface RecordingSnapshot {
  phase: "idle" | "starting" | "recording" | "finishing" | "finished";
  audio: KindStatus;
  video: KindStatus;
  files: RecordingFile[];
  notices: string[];
}
export interface RecordingSession {
  start(choice: RecordingChoice): Promise<void>;
  finish(): Promise<RecordingFile[]>;
  dispose(): void;
  snapshot(): RecordingSnapshot;
  subscribe(listener: () => void): () => void;
}

export const RECORDER_TIMESLICE_MS = 1000;
export const NOTICE = {
  micBlocked: "Microphone access was blocked, so your audio isn't being recorded.",
  tabBlocked: "Screen sharing was cancelled or blocked, so video isn't being recorded.",
  audioUnsupported: "This browser can't record audio.",
  videoUnsupported: "This browser can't record video.",
  audioEmpty: "The audio recording was empty.",
  videoEmpty: "The video recording was empty.",
} as const;

export function createRecordingSession(deps: RecordingDeps): RecordingSession;
```

**State and notifications:**
- **N1:** the initial snapshot is `{ phase: "idle", audio: "off", video: "off", files: [], notices: [] }`.
  - `snapshot()` returns **the same object** until something changes.
  - Every change replaces it with a new object and calls every subscribed listener synchronously.
  - New notices are **appended**, in the order the rules below produce them.
- **N2:** `subscribe(listener)` returns an unsubscribe function.
- **N3:** after `dispose()`, nothing changes the snapshot and no listener is called again.
- **N4:** build the session from closures, not a class. The methods must work when called unbound, because `useSyncExternalStore(session.subscribe, session.snapshot)` passes them unbound.

**`start(choice)`.** It **never rejects**.
- **S1:**
  - `start` runs at most once. It's ignored (returning the existing start promise, or an already-resolved promise) if it already ran, if `dispose()` was called, or if `finish()` was already called.
  - If neither `audio` nor `video` is chosen, it calls no dependency and changes nothing; the phase stays `"idle"`.
- **S2:**
  1. Synchronously, set `phase: "starting"`, with `audio`/`video` set to `"starting"` for each chosen kind and `"off"` for the others.
  2. Then, **before any `await`**, call `deps.getTab()` if `video` is chosen, **and then** `deps.getMic()`. The mic is requested whenever anything is chosen, because video also carries the mixed audio.

  Browsers only allow these prompts inside the click, which is why the calls must be synchronous, with the tab first.
- **S3:**
  - A dependency that throws synchronously counts as a rejection.
  - Wait for both promises to settle (`Promise.allSettled`). A rejection means "blocked".
- **S4:** if `dispose()` was called while waiting, call `stop()` on every track of any stream that was granted, and do nothing else.
- **S5:** if `audio` was chosen and the mic was blocked, set `audio: "failed"` and append `NOTICE.micBlocked`. Video can still record, using an interviewer-only mix.
- **S6:** if `video` was chosen and the tab was blocked, set `video: "failed"` and append `NOTICE.tabBlocked`.

  Apply S5 and S6 together in one change.
- **S7:** if nothing can record (that is, not both audio chosen and mic granted, **and** not both video chosen and tab granted):
  - stop every track of the granted streams
  - don't create a mixer
  - set `phase: "finished"` with `files: []`, and return
- **S8:** otherwise:
  1. Create `mixer = deps.createMixer(mic or null)`.
  2. If audio was chosen and the mic was granted, start a recorder of kind `"audio"` on `mixer.stream`.
  3. Then, if video was chosen and the tab was granted, start a recorder of kind `"video"` on `deps.combine(tab, mixer.stream)`.

  **Starting a recorder:**
  - Call `deps.createRecorder(stream, kind)`. If it throws, set that kind to `"failed"`, append `NOTICE.audioUnsupported` or `NOTICE.videoUnsupported`, and move on.
  - Otherwise keep a list of chunks, and set:
    - `ondataavailable`: push `e.data` when `e.data.size > 0`
    - `onstop`: set the kind to `"stopped"` and resolve that recorder's "stopped" promise
    - `onerror`: call `recorder.stop()` if `recorder.state !== "inactive"`
  - Then call `recorder.start(RECORDER_TIMESLICE_MS)` and set the kind to `"recording"`.

  **If no recorder was created:** stop all mic and tab tracks, call `mixer.dispose()`, set `phase: "finished"` with `files: []`, and return. **Otherwise** set `phase: "recording"`.
- **S9 ("Stop sharing"):** for every track of the tab stream whose `kind === "video"`, add an `"ended"` listener. It calls the video recorder's `stop()` if that recorder's `state !== "inactive"`. Only the video recording stops; audio carries on.

**`finish()`.** It resolves to the files and **never rejects**.
- **F1:** it's idempotent: every call returns **the same promise**. If `start()` was never called (and the session isn't disposed), it sets `phase: "finished"` and resolves `[]`. A later `start()` is then ignored (S1).
- **F2:** if `start` hasn't completed yet, first wait for it.
  - Then, if the session is disposed, resolve `[]`.
  - If the phase is already `"finished"` (S7/S8), resolve the current `files`.
- **F3:**
  1. Set `phase: "finishing"`. When `start` had already completed, this happens synchronously inside the `finish()` call.
  2. Call `stop()` on every recorder whose `state !== "inactive"`.
  3. Wait until **every** recorder has fired `onstop`, including any that had already stopped.
- **F4:** stop every mic and tab track, then call `mixer.dispose()`. If the session was disposed meanwhile, resolve `[]`.
- **F5:** for each recorder, audio first and then video:
  - `bytes` is the sum of its chunk sizes.
  - If `bytes === 0`, set that kind to `"failed"`, append `NOTICE.audioEmpty` or `NOTICE.videoEmpty`, and make no file.
  - Otherwise, build the file:
    - `mimeType = recorder.mimeType`, or `"audio/webm"`/`"video/webm"` if it's `""`
    - `blob = new Blob(chunks, { type: mimeType })`
    - `url = deps.createObjectURL(blob)`
    - `filename = interim-${fileStamp(deps.now())}-${kind}.${extensionFor(mimeType)}`
    - the file is `{ kind, url, filename, bytes, mimeType }`
- **F6:** in one change, set `phase: "finished"`, `files`, any failed kinds and the notices. Then resolve `files`.

**`dispose()`:**
- **D1:**
  - Make it idempotent.
  - Mark the session disposed **first**: from then on, nothing emits (N3) and listeners are dropped.
  - Then stop every recorder whose `state !== "inactive"` and every mic and tab track, call `mixer.dispose()` if there's a mixer, and call `deps.revokeObjectURL` for every file URL in the current snapshot.
- **D2:** if it's called while `start` is waiting for permission, S4 applies.

## 4. `src/client/recording/browser-recording.ts` (new; the only file in this stage that touches browser APIs)
`export function createBrowserRecordingDeps(): RecordingDeps`.
- **Nothing may run at import time.** Cast DOM objects with `as unknown as StreamLike`/`MediaStream` where TypeScript needs it; no `any`.
- **`getMic`:**
  - If `navigator.mediaDevices?.getUserMedia` is missing, return `Promise.reject(new Error("getUserMedia unsupported"))`.
  - Otherwise return `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })`.
- **`getTab`:**
  - If `navigator.mediaDevices?.getDisplayMedia` is missing, return `Promise.reject(new Error("getDisplayMedia unsupported"))`.
  - Otherwise call `navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions)` with `const options = { video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" };`.
- **`createMixer(mic)`:**
  ```ts
  const ctx = getAudioContext();                 // from "@/client/voice/browser-audio"
  const dest = ctx.createMediaStreamDestination();
  const source = mic ? ctx.createMediaStreamSource(mic as unknown as MediaStream) : null;
  source?.connect(dest);                         // never connect the mic to ctx.destination (echo)
  setPlaybackTap(dest);                          // TTS playback now also feeds the mix (§2)
  return { stream: dest.stream as unknown as StreamLike, dispose() { setPlaybackTap(null); source?.disconnect(); } };
  ```
- **`combine(tab, audio)`** returns `new MediaStream([...tabStream.getVideoTracks(), ...audioStream.getAudioTracks()])`, where `tabStream` and `audioStream` are the arguments cast to `MediaStream`.
- **`createRecorder(stream, kind)`:**
  - If `typeof MediaRecorder === "undefined"`, throw `new Error("MediaRecorder unsupported")`.
  - Otherwise:
    - `const mimeType = pickMimeType(kind, (t) => MediaRecorder.isTypeSupported(t));`
    - return `new MediaRecorder(stream as unknown as MediaStream, mimeType ? { mimeType } : undefined)`, cast to `RecorderLike`
- `createObjectURL` is `(b) => URL.createObjectURL(b)`, `revokeObjectURL` is `(u) => URL.revokeObjectURL(u)`, and `now` is `() => Date.now()`.

## 5. UI components (new, `"use client"`; not unit-tested, so keep them small and exactly as specified)
### `src/app/interview/InterviewGate.tsx`
- **Props:** `{ config: PublicConfig; styleId: string }`.
- **State:**
  - `stage: "consent" | "starting" | "started"` (initially `"consent"`)
  - `audio` and `video` booleans (both `false`)
  - `session: RecordingSession | null` (`null`)
- **Effect, deps `[session]`:** `if (!session) return; return () => session.dispose();`. It disposes on leave, for example "Start another interview".
- **The form's `onSubmit(e: FormEvent<HTMLFormElement>)`:**
  ```ts
  e.preventDefault();
  if (!audio && !video) { setStage("started"); return; }
  const s = createRecordingSession(createBrowserRecordingDeps());
  setSession(s);
  setStage("starting");
  void s.start({ audio, video }).then(() => setStage("started"));   // start() is called inside the click
  ```
- **When `stage === "started"`:** `return <InterviewScreen config={config} styleId={styleId} recording={session} />;`.
- **Otherwise, render exactly this.** `styleLabel` is `config.styles.find((s) => s.id === styleId)?.label ?? styleId`, and the `…` is the single Unicode ellipsis character.
  ```tsx
  <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
    <form onSubmit={onSubmit} aria-labelledby="consent-title" className="w-full max-w-md rounded-lg border p-6" style={{ borderColor: "var(--foreground)", borderWidth: 1 }}>
      <h1 id="consent-title" className="text-2xl font-bold mb-2">Before you start</h1>
      <p className="text-sm opacity-70 mb-4">{config.subject} · {styleLabel}</p>
      <p className="mb-4">You can record this interview to watch or listen back later. Recordings stay on this device: nothing is uploaded, and you can download them when the interview ends.</p>
      <fieldset className="mb-6" disabled={stage === "starting"}>
        <legend className="text-sm font-semibold mb-3">Record (optional)</legend>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2"><input type="checkbox" className="w-4 h-4" checked={audio} onChange={(e) => setAudio(e.target.checked)} /><span>Audio: your voice and the interviewer&apos;s</span></label>
          <label className="flex items-center gap-2"><input type="checkbox" className="w-4 h-4" checked={video} onChange={(e) => setVideo(e.target.checked)} /><span>Video of this tab, with the same audio</span></label>
        </div>
      </fieldset>
      <button type="submit" disabled={stage === "starting"} className="w-full py-2 px-4 rounded font-semibold transition-colors" style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}>
        {stage === "starting" ? "Waiting for permission…" : "Start interview"}
      </button>
      <p className="mt-4 text-sm opacity-60">Your browser will ask for permission for anything you tick.</p>
    </form>
  </main>
  ```

### `src/app/interview/RecordingBadge.tsx`
- **Props:** `{ session: RecordingSession }`. Read the snapshot with `const snap = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);`.
- **`label`:**
  - `"Recording audio and video"` if both `snap.audio` and `snap.video` are `"recording"`
  - `"Recording audio"` if only audio is
  - `"Recording video"` if only video is
  - otherwise `null`
- If `label === null` and there are no notices, render `null`. Otherwise:
  ```tsx
  <span className="flex items-center gap-2 text-sm" role="status">
    {label && <span className="font-semibold" style={{ color: "#dc2626" }}>● {label}</span>}
    {snap.notices.length > 0 && <span className="text-xs opacity-70">{snap.notices.join(" ")}</span>}
  </span>
  ```

### `src/app/interview/RecordingDownloads.tsx`
- **Props:** `{ session: RecordingSession }`.
- Use the same `useSyncExternalStore` call, and `useEffect(() => { void session.finish(); }, [session]);`. `finish()` is idempotent, so the StrictMode double effect is safe, and there's no `setState` in the effect.
- **While `snap.phase !== "finished"`:** `<p className="text-sm opacity-60" role="status">Saving your recording…</p>`.
- **Once finished:**
  ```tsx
  <section aria-label="Recording" className="w-full max-w-2xl text-left">
    <h2 className="text-lg font-semibold mb-2">Your recording</h2>
    {snap.files.length === 0 ? (
      <p className="text-sm mb-2">No recording was saved.</p>
    ) : (
      <ul className="mb-2 list-disc pl-5">
        {snap.files.map((f) => (
          <li key={f.kind}><a href={f.url} download={f.filename} className="underline">Download {f.kind} ({formatBytes(f.bytes)})</a></li>
        ))}
      </ul>
    )}
    {snap.notices.map((n) => <p key={n} className="text-sm opacity-70">{n}</p>)}
    <p className="text-xs opacity-50">Recordings stay on this device and were never uploaded. Download them before you leave this page.</p>
  </section>
  ```

## 6. Page edits (exact; nothing else)
- **`src/app/page.tsx`:** replace the text `Text mode. Voice and whiteboard are coming soon.` with `You can choose to record the interview on the next screen.`. Keep the surrounding `<p>` and its indentation.
- **`src/app/interview/page.tsx`:**
  - Replace `import InterviewScreen from "./InterviewScreen";` with `import InterviewGate from "./InterviewGate";`.
  - Replace `return <InterviewScreen config={publicConfig} styleId={styleId} />;` with `return <InterviewGate config={publicConfig} styleId={styleId} />;`.

## 7. `src/app/interview/InterviewScreen.tsx` (exactly six edits; nothing else)
1. After the line `import FeedbackPanel from "./FeedbackPanel";`, add these two lines:
   ```ts
   import RecordingBadge from "./RecordingBadge";
   import RecordingDownloads from "./RecordingDownloads";
   ```
2. After the line `import type { PublicConfig } from "@/config/public";`, add:
   ```ts
   import type { RecordingSession } from "@/client/recording/recording-session";
   ```
3. In `interface InterviewScreenProps`, after `  styleId: string;`, add `  recording?: RecordingSession | null;`.
4. Change `export default function InterviewScreen({ config, styleId }: InterviewScreenProps) {` to `export default function InterviewScreen({ config, styleId, recording = null }: InterviewScreenProps) {`.
5. In the header, directly after the right-hand `<div className="flex items-center gap-4">` (the one whose next line is `{view.engine && (`), add this line with 10-space indentation:
   ```tsx
             {recording && <RecordingBadge session={recording} />}
   ```
6. Directly after the line `          {view.engine && <FeedbackPanel state={view.engine} />}`, add this line with the same 10-space indentation:
   ```tsx
             {recording && <RecordingDownloads session={recording} />}
   ```

---

## Tests
**Copy these three reviewer files byte for byte.** Don't reformat them, rename tests or "fix" anything. If one fails, your code differs from §1–§3: fix the code.

| Copy from | To | SHA-256 starts with |
|---|---|---|
| `agent-os/review/stage-10-tests/recording-session.test.ts.txt` | `tests/recording-session.test.ts` | `ff0e00b0` |
| `agent-os/review/stage-10-tests/recording-format.test.ts.txt` | `tests/recording-format.test.ts` | `d2b389f7` |
| `agent-os/review/stage-10-tests/recording-tap.test.ts.txt` | `tests/recording-tap.test.ts` | `48e93f08` |

Together they hold 31 tests:
- **`recording-session` (24):** S1–S9, F1–F6, D1/D2 and N1/N2, using fake tracks, streams and recorders. A fake recorder's `stop()` fires its final data and `onstop` in a microtask, as a real `MediaRecorder` does asynchronously.
- **`recording-format` (5):** every helper in §1.
- **`recording-tap` (2):** the two §2 edits, run against a stubbed global `AudioContext`. They import `@/client/voice/browser-audio` freshly after `vi.resetModules()`.

You may add further tests in new files of your own (for example `tests/recording-extra.test.ts`; list them in `STAGE10_NOTES.md`). They aren't required.

## Acceptance criteria
1. Only the allowed files changed. Every frozen file is byte-identical, and the four modified files hash to the "after" values in Constraints. The three test files are byte-identical to their `.txt` sources.
2. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 problems, and `npx next build` with no keys set passes.
3. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** It runs 904 tests (873 before this stage + 31), and no test name disappears.
4. No file in this stage imports `src/server`, `src/lib` or `src/config/load`. Nothing new logs anything or makes any network request.
5. **Under `next dev`** (`INTERIM_FAKE_MODEL=1`), `/interview?config=maths-oxbridge&style=supportive` first shows "Before you start".
   - Submitting with nothing ticked starts the interview as before.
   - The ended screen shows the feedback, and no recording section.
6. `STAGE10_NOTES.md` lists what you built, any deviations, and anything you couldn't do, with reasons. It includes the `speechSynthesis` limitation: offline, the interviewer's voice can't be captured.

## Held (not part of this stage)
- **Real-browser QA** in Chrome, Safari and Firefox, which can't be driven headless:
  - the dialog, and the mic and tab-share prompts
  - that "Stop sharing" ends only the video
  - that the downloads play
  - that the audio contains both voices; this needs `OPENAI_API_KEY` for provider TTS
- Any deploy.
