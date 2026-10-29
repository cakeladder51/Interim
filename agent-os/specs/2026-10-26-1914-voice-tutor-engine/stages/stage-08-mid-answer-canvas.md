# Stage 8 brief: Mid-answer interjections + canvas, milestone M3 (handoff to the external model)

## Goal
The interviewer stops waiting for the student to finish. While the student is still talking, typing or drawing, the client sends the engine **background steps**, and the engine may answer with a short **interjection**.

- **Partials (B6):** the live voice caption is sent as a `partial` step event. It's debounced: send once there are ≥ 8 new words, or ≥ 3 s after the first unsent word, with only one background request in flight.
- **Interjections:** when the engine answers a partial or canvas step with a spoken move (`realign`, `interrupt: true`), the interviewer speaks it **over the student**. Barge-in rules are relaxed for that utterance so the student's ongoing speech doesn't cut it off at once.
- **Silence timer:** after 20 s with no student activity, the client sends a `silence` event. The engine may answer with a hint.
- **Canvas (I1):** a scratchpad on the interview screen. About 4 s after the student stops drawing, a PNG snapshot is sent as a `canvas` event, deduplicated by hash and capped at 1,500,000 characters.

**The server already does all of this.** `/api/step`, the FSM and the assessor handle `partial`, `silence` and `canvas` events, so **this stage is client-only**. Don't touch any server, engine, contract or config file.

**Build and test everything offline.** The live model and the live relay need `MODEL_API_KEY`, and they're **on hold**. Never call `api.meta.ai` or `api.openai.com`, and never add keys. Tests use fakes, and the real step handler with the offline fake model, on `127.0.0.1` only.

---

## What already exists: read this first
You're starting in a fresh session. **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win. `STATUS.md` lists completed stages, frozen file hashes and held items. **This repo uses Next.js 16.4 with breaking changes.** Read the relevant guide in `node_modules/next/dist/docs/` before writing client component code, and heed deprecation notices.

**Stack:**
- Next.js 16.4 App Router with `cacheComponents: true`.
- React 19.3, TypeScript strict, zod v4.
- vitest runs in a **node environment** (no DOM). Tests go in `tests/` and run with `npx vitest run`. `@/*` maps to `src/*`, and `server-only` is mocked in tests.
- ESLint is `eslint-config-next` (core-web-vitals + typescript, including the React hooks/compiler rules). **No `any`.** Don't read `ref.current` during render.

**Engine events** (`src/contracts/engine.ts`, frozen). `EngineEvent` includes:
- `{type:"partial", text}`
- `{type:"silence", ms}`, where `ms` is a positive integer
- `{type:"canvas", image}`, where `image` must start with `data:image/png;base64,` and be at most **1,500,000 characters including that prefix**

The `/api/step` body limit is 2,000,000 bytes.

**What the frozen engine does with them** (`src/engine/fsm.ts`; for reference only, don't re-implement it):
- **partial:** the assessor runs only if the cooldown has elapsed (`now - lastInterjectAt ≥ style.interjection.cooldownMs`) and `words(text) - state.turnWordBaseline ≥ style.interjection.minNewWords`. The styles use minNewWords 12/8 and cooldown 20 s/12 s.
  - If the assessment is confidently `off_track`, the move is `realign`, `interrupt: true`, and the state gets `lastInterjectAt = now` and `turnWordBaseline = words(text)`.
  - Otherwise the move is `silent`, and the stream is `move`, then `done` with `utterance: ""`, plus a state that may have merged checkpoints.
- **canvas:** the same, but with no word gate.
- **silence:** if `ms < config.timing.silenceStuckMs` (20000 in both configs), the move is `silent`. Otherwise it's the next hint (`hint`, `interrupt: false`), or advance or wrap-up.
- The spoken text of an interjection is stored as a transcript entry with `kind: "interjection"`. `InterviewScreen` already shows an "Interrupted" badge for it.
- `turn_complete` resets `turnWordBaseline` to 0.
- **The client doesn't know the style's thresholds.** `PublicConfig` is frozen and doesn't expose them, so the client uses the fixed constants below and the server stays the authority.

**The text interview client** (Stages 4 and 7):
- **`src/client/interview-model.ts`:**
  - `interviewReducer`, `InterviewView`, `InterviewAction` (`request`, `move`, `token`, `slow`, `done`, `failed`, `model_label`)
  - `canSend`, `buildTurnRequest(view, text, source)`, `buildEndRequest`, `buildStartRequest`, `visibleTranscript`, `isThinking`, `describeError`
- **`src/client/request-runner.ts`** (frozen): `createRequestRunner({ dispatch, runStepRequest, setTimer, clearTimer, describeError })` returns `{ run(request, studentText), abort(), inFlight() }`.
  - `run` aborts any current run, then synchronously dispatches `{type:"request", request, studentText}`. It then dispatches `move`, `token` and `model_label` as they arrive, and `done` with `result.state` on success, or `failed` for non-abort errors. It also dispatches `slow` after 6 s without a token.
  - A superseded or aborted run dispatches nothing more, and an `AbortError` dispatches nothing.
  - Its `move` action carries only `move`; it drops `interrupt`.
- **`src/client/step-client.ts`** (frozen): `runStepRequest(request, { signal?, fetchImpl?, callbacks })`. `tests/e2e-text-interview.test.ts` shows how to run it against the real handler: `fetchImpl: (url, init) => handler(new Request("http://test" + url, init))` with `createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now })` from `src/server/step-handler.ts` and `src/server/fake-model.ts`.
  - `fakeAssess` waits 150 ms, then returns `off_track` (confidence 0.9, the first misconception) when the text contains the word `wrong`, `stuck` for "i don't know", `correct` for "solved", and otherwise `progressing` 0.6. For canvas, the text is `""`.
- **`src/client/use-interview.ts`:** `useInterview(configId, styleId, options?: { onAction? })` returns `{ view, sendTurn(text, source?), end(), retry() }`. It holds one runner in a ref, and its dispatch wrapper calls `options.onAction` and then the React `dispatch`.
- **Voice (Stage 7, frozen unless listed below):**
  - **`src/client/voice/voice-controller.ts`:** `createVoiceController(deps)` returns `{ enable, disable, dispose, snapshot, handleInterviewAction, speakNow, stopSpeaking }`.
    - **Barge-in:** a relay `partial` with ≥ `BARGE_IN_MIN_WORDS` (2) words, while the TTS is speaking, stops the TTS, resets the chunker and sets `suppressed = true`.
    - **`handleInterviewAction`:** `request` stops the TTS, resets the chunker and clears `suppressed`. `token` feeds the chunker into the TTS unless voice is off or suppressed. `done` flushes the chunker. `failed` resets the chunker.
  - **`src/client/use-voice.ts`:** `useVoice(configId)` returns `{ snapshot: {status, message, partial, speaking}, pendingTurn, takePendingTurn, enable, disable, stopSpeaking, speakNow, onInterviewAction }`.
    - `snapshot.partial` is the live cumulative caption of the current relay turn, or `null` when no turn is active (it's set to null on `turn_complete`, disable and reconnect).
    - `pendingTurn` queues completed voice turns.
  - **`src/client/voice/tts-player.ts`:** `speaking` is true while its queue plays, and goes false when the queue drains.
- **`src/app/interview/InterviewScreen.tsx`:** the transcript, the problem panel (which currently ends with the placeholder `<p className="text-sm opacity-40">Whiteboard coming in a later stage.</p>`), the error banner, and the answer bar with voice controls.
  - **Voice turns** are sent by an effect: `if (pendingTurn !== null && canSend(view, pendingTurn)) { sendTurn(pendingTurn, "voice"); takePendingTurn(); }`.

**Known intermittent test (don't touch it):** `tests/step-route.test.ts` › "step-handler abort mid-speak: no events after abort, no unhandled rejection" occasionally fails under full-suite load. If it's the **only** failure, re-run the suite and mention it in `STAGE8_NOTES.md`. **Never edit or weaken it.**

**Acceptance always includes:** `npx vitest run` **exits 0 with no `Errors` / "Unhandled Rejection" lines**.
- Attach a rejection handler to every promise before it can reject.
- Tests that use timers must leave none running.

---

## Constraints
- **New files allowed:**
  - `src/client/background-runner.ts`
  - `src/client/turn-controller.ts`
  - `src/app/interview/Scratchpad.tsx`
  - `tests/turn-controller.test.ts`
  - `tests/background-runner.test.ts`
  - `tests/voice-interjection.test.ts`
  - `tests/e2e-mid-answer.test.ts`
  - `STAGE8_NOTES.md`
- **Modified files allowed** (only the changes described in this brief):
  - `src/client/interview-model.ts` (§1)
  - `src/client/use-interview.ts` (§3)
  - `src/client/voice/voice-controller.ts` (§5)
  - `src/app/interview/InterviewScreen.tsx` (§7)
  - `tests/interview-model.test.ts`: add tests only
- **Frozen; SHA-256 checked:** every other file under `src/`, plus `public/`, `relay/`, `configs/`, `evals/`, `scripts/`, `tests/helpers/`, **every existing test file** (including `tests/voice-controller.test.ts` and `tests/voice-tts-player.test.ts`, which are reviewer copies), `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.env.example`, and everything under `agent-os/`.
- **No new dependencies.**
- **Never edit a frozen file to get around a problem,** and **never edit an expected value to make a test pass**: the vectors below were verified by the reviewer. If something blocks you, stop and write it in `STAGE8_NOTES.md`.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **Browser globals** (`window`, `document`, `HTMLCanvasElement` APIs) may be used only inside functions or effects, never at module top level.
- **Never log** transcript text, partial text, image data or keys. Log lengths or counts only.

---

## 1. `src/client/interview-model.ts` (exact edits; nothing else)
1. Line 1 becomes `import type { EngineEvent, EngineState, Move, StepRequest, TranscriptEntry } from "@/contracts";`.
2. After `SLOW_FIRST_TOKEN_MS`, add:
   ```ts
   export type BackgroundEvent = Extract<EngineEvent, { type: "partial" | "silence" | "canvas" }>;
   ```
3. In `InterviewView`, add the field `background: "none" | "pending" | "speaking";` after `modelLabel`. In `initialView`, add `background: "none",` after `modelLabel: null,`.
4. In `InterviewAction`, add three variants after `model_label`:
   ```ts
     | { type: "bg_request"; request: StepRequest }
     | { type: "bg_move"; move: Move }
     | { type: "bg_failed" }
   ```
5. In the reducer:
   - In the `request` case's returned object, add `background: "none",`.
   - In the `done` case's returned object, add `background: "none",`.
   - Add these cases after `model_label`:
   ```ts
       case "bg_request":
         return { ...view, background: "pending" };
       case "bg_move":
         if (action.move.type === "silent") return view;
         return {
           ...view,
           status: "sending",
           background: "speaking",
           streamingText: "",
           lastMove: action.move,
           slow: false,
         };
       case "bg_failed":
         if (view.background === "speaking") {
           return { ...view, background: "none", status: "ready", streamingText: "" };
         }
         return { ...view, background: "none" };
   ```
6. After `buildStartRequest`, add:
   ```ts
   /**
    * Build a background step request (partial, silence or canvas).
    */
   export function buildBackgroundRequest(view: InterviewView, event: BackgroundEvent): StepRequest {
     if (view.engine === null) {
       throw new Error("Cannot build background request without engine");
     }
     return { state: view.engine, event };
   }

   /**
    * Map a request-runner action to its background equivalent (null = drop it).
    */
   export function mapBackgroundAction(action: InterviewAction): InterviewAction | null {
     switch (action.type) {
       case "request":
         return { type: "bg_request", request: action.request };
       case "move":
         return { type: "bg_move", move: action.move };
       case "failed":
         return { type: "bg_failed" };
       case "slow":
         return null;
       default:
         return action;
     }
   }
   ```

**Why it works this way:**
- A background request doesn't change `status`. It stays `"ready"`, so the student can keep typing, and Send still works (a foreground turn supersedes the background request; see §3).
- A silent background step only replaces `engine` when its `done` arrives.
- A spoken background move turns the view into a normal "interviewer is talking" view: `sending` with streaming tokens, ending in `done`.

## 2. `src/client/background-runner.ts` (new; React-free)
```ts
export function createBackgroundRunner(deps: RunnerDeps & { onSettled: (move: Move | null) => void }): {
  run(request: StepRequest): void;
  abort(): void;
  inFlight(): boolean;
}
```
`RunnerDeps` is the type exported by `request-runner.ts`. The rules:

1. **Build on the frozen runner.** It wraps exactly one `createRequestRunner({ ...deps, dispatch: wrapped })`. `wrapped(action)`:
   - records `lastMove = action.move` when `action.type === "move"`
   - computes `m = mapBackgroundAction(action)` and calls `deps.dispatch(m)` if `m !== null`
   - **then**, if `action.type === "done"`, calls `settle(lastMove)`; if `action.type === "failed"`, calls `settle(null)`
2. **`run(request)`** sets `lastMove = null` and `active = true`, then calls `inner.run(request, null)`.
3. **`settle(move)`:** if `!active`, it returns. Otherwise it sets `active = false` **first**, then calls `deps.onSettled(move)`. That makes `onSettled` fire **exactly once** per run, and it's safe for `onSettled` to call `run` again synchronously.
4. **`abort()`:** if `!active`, it does nothing. Otherwise it calls `inner.abort()`, then `settle(null)`. Nothing is dispatched to `deps.dispatch` for an aborted run, now or later.
5. **`inFlight()`** returns `active`.

## 3. `src/client/use-interview.ts` (changes)
1. **Options:** add `onBackgroundSettled?: (move: Move | null) => void` to `options`. Keep it in a ref, synced in the same effect as `onActionRef`. In the return type and value, add `sendBackground: (event: BackgroundEvent) => boolean`.
2. **Synchronous view mirror:**
   - Add `const viewRef = useRef<InterviewView>(initialView);`.
   - In the runner-creating effect, define:
     ```ts
     const apply = (action: InterviewAction) => {
       viewRef.current = interviewReducer(viewRef.current, action);
       onActionRef.current?.(action);
       dispatch(action);
     };
     ```
   - Use `apply` as the foreground runner's `dispatch`. Its behaviour is unchanged.
   - In the same effect and under the same `=== null` guard, create a `bgRef` with `createBackgroundRunner({ dispatch: apply, runStepRequest, setTimer, clearTimer, describeError, onSettled: (m) => onBgSettledRef.current?.(m) })`, using the same timer functions as the foreground runner.
3. **The start effect's cleanup** also calls `bgRef.current?.abort()`.
4. **`sendTurn`, `end`, `retry`:** immediately **after** each `runnerRef.current.run(...)` call, add `bgRef.current?.abort();`. The order matters: by the time `onSettled(null)` fires, the foreground `request` has already moved `viewRef` to `sending`, so the turn controller can't start a new background request in between.
5. **`sendBackground = useCallback((event) => { … }, [])`:**
   - Read `const v = viewRef.current;`.
   - Return `false` unless all of these hold: `v.status === "ready"`, `v.engine !== null`, `v.engine.phase === "problem"`, the foreground runner isn't in flight, and `bgRef.current` exists and isn't in flight.
   - Otherwise call `bgRef.current.run(buildBackgroundRequest(v, event))` and return `true`.

Nothing else in this file changes.

## 4. `src/client/turn-controller.ts` (new; pure and React-free; all time and timers are injected)
```ts
export const PARTIAL_MIN_NEW_WORDS = 8;
export const PARTIAL_MAX_WAIT_MS = 3000;
export const SILENCE_FIRST_MS = 20_000;
export const SILENCE_REPEAT_MS = 10_000;
export const SILENCE_MAX_PROMPTS = 2;
export const CANVAS_IDLE_MS = 4000;
export const CANVAS_MAX_CHARS = 1_500_000;

export function hashString(s: string): string;
export function createTurnController(deps: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  send: (event: BackgroundEvent) => boolean; // false = not sent (keep the data)
}): {
  setIdle(idle: boolean): void;
  activity(): void;
  partial(text: string): void;
  turnBoundary(): void;
  canvasChanged(getImage: () => string | null): void;
  settled(move: Move | null): void;
  dispose(): void;
};
export type TurnController = ReturnType<typeof createTurnController>;
```

**`hashString`** is 32-bit FNV-1a over UTF-16 code units: start with `0x811c9dc5`; for each `charCodeAt(i)`, do `h ^= c; h = Math.imul(h, 0x01000193) >>> 0`. Return `h.toString(16).padStart(8, "0")`.

| Input | Output |
|---|---|
| `""` | `811c9dc5` |
| `"a"` | `e40c292c` |
| `"foobar"` | `bf9cf968` |
| `"data:image/png;base64,AAA"` | `325d4f85` |

**`words(t)`** is `t.split(/\s+/).filter(Boolean).length`.

**State:**
- `idle = false`, `busy = false`, `lastKind: "partial" | "silence" | "canvas" | null`
- **partial:** `latest: string | null`, `latestWords = 0`, `sentWords = 0`, `firstUnsentAt: number | null`, `partialTimer`
- **silence:** `since: number | null`, `silenceTimer`, `prompts = 0`
- **canvas:** `getImage | null`, `canvasTimer`, `canvasDue = false`, `lastHash: string | null`

**Rules** (numbered; the reviewer reverts each one):
- **T1 `armSilence(delay)`:** clear `silenceTimer`. If `prompts >= SILENCE_MAX_PROMPTS`, leave it cleared. Otherwise set `silenceTimer = setTimer(onSilence, delay)`.
- **T2 `onSilence`:**
  - Set `silenceTimer = null`. If `!idle` or `since === null`, return.
  - If `busy`, call `armSilence(SILENCE_REPEAT_MS)` and return.
  - Otherwise compute `ms = Math.max(1, Math.round(now() - since))`. If `send({type:"silence", ms})` returns true, set `busy = true` and `lastKind = "silence"`. If it returns false, call `armSilence(SILENCE_REPEAT_MS)`.
- **T3 `flush()`:** if `!idle` or `busy`, return. Then try **at most one** send, in this priority order:
  - **(a) Partial:** applies if `latest !== null`, `latestWords > sentWords`, and either `latestWords - sentWords >= PARTIAL_MIN_NEW_WORDS` or (`firstUnsentAt !== null` and `now() - firstUnsentAt >= PARTIAL_MAX_WAIT_MS`).
    - Call `send({type:"partial", text: latest})`.
    - If it returns true: `busy = true`, `lastKind = "partial"`, `sentWords = latestWords`, `firstUnsentAt = null`, and clear `partialTimer`.
    - Either way, **return**.
  - **(b) Canvas:** applies if `canvasDue` and `getImage !== null`.
    - Set `canvasDue = false` and call `image = getImage()`.
    - Return if `image === null` or `image.length > CANVAS_MAX_CHARS`. Otherwise compute `h = hashString(image)`, and return if `h === lastHash`.
    - If `send({type:"canvas", image})` returns true: `busy = true`, `lastKind = "canvas"`, `lastHash = h`. Otherwise set `canvasDue = true` again.
  - **(c)** Silence is never sent from `flush`; only T2 sends it.
- **T4 `setIdle(v)`:**
  - If `v && !idle`: set `idle = true`, `since = now()`, then `armSilence(SILENCE_FIRST_MS)`.
  - If `!v && idle`: set `idle = false`, clear `silenceTimer`, and set `since = null`.
  - Then, if `idle`, call `flush()`. This happens even when the value didn't change.
- **T5 `activity()`:** set `prompts = 0`. If `idle`, set `since = now()` and call `armSilence(SILENCE_FIRST_MS)`.
- **T6 `partial(text)`:**
  - Compute `w = words(text)`. If `w < sentWords`, set `sentWords = 0` (a new relay turn started).
  - Set `latest = text` and `latestWords = w`, then call `activity()`.
  - If `w > sentWords` and `firstUnsentAt === null`: set `firstUnsentAt = now()` and (re)start `partialTimer = setTimer(() => { partialTimer = null; flush(); }, PARTIAL_MAX_WAIT_MS)`.
  - Finally, call `flush()`.
- **T7 `turnBoundary()`:** set `latest = null`, `latestWords = 0`, `sentWords = 0`, `firstUnsentAt = null`, clear `partialTimer`, then call `activity()`.
- **T8 `canvasChanged(g)`:** set `getImage = g` and `canvasDue = false`, then (re)start `canvasTimer = setTimer(() => { canvasTimer = null; canvasDue = true; flush(); }, CANVAS_IDLE_MS)`, then call `activity()`.
- **T9 `settled(move)`:** if `!busy`, return. Otherwise:
  - Set `busy = false`. Let `spoke = move !== null && move.type !== "silent"`.
  - If `lastKind === "silence"` and `spoke`, increment `prompts`. Then set `lastKind = null`.
  - If `idle`: if `spoke`, set `since = now()` and call `armSilence(SILENCE_FIRST_MS)`. Otherwise, if `silenceTimer === null` and `since !== null`, call `armSilence(SILENCE_REPEAT_MS)`.
  - Then, if `idle`, call `flush()`.
- **T10 `dispose()`:** set `disposed = true` and `idle = false`, and clear all three timers. After that, **every method is a no-op** and nothing is ever sent.

## 5. `src/client/voice/voice-controller.ts` (changes; keep every existing behaviour, since the 37 tests in `tests/voice-controller.test.ts` must still pass unchanged)
- **V1:** export `INTERJECTION_BARGE_IN_WORDS = 4`. Add state `let interjectBaseline: number | null = null;`.
- **V2:** in `onPartial`'s barge-in check, the threshold becomes `interjectBaseline === null ? BARGE_IN_MIN_WORDS : interjectBaseline + INTERJECTION_BARGE_IN_WORDS`. When barge-in fires, also set `interjectBaseline = null`.
- **V3:** `onTurnStart` and `onTurnComplete` first apply the same stale guard as the other handlers (`if (disposed || gen !== generation) return;`). Then, if `interjectBaseline !== null`, they set it to `0`, because the next relay turn's partials restart from zero words. `onTurnComplete` keeps its existing behaviour after that.
- **V4:** in `handleInterviewAction`:
  - **`request`:** also set `interjectBaseline = null`.
  - **New case `bg_move`:** if `action.move.type === "silent"`, do nothing. Otherwise: `tts.stop()`, `chunker.reset()`, `suppressed = false`, and set `interjectBaseline = action.move.type === "realign" ? words(snap.partial ?? "") : null`. Count words the same way as the barge-in check.
  - **New case `bg_failed`:** `chunker.reset()` and `interjectBaseline = null`.
  - **`bg_request`:** do nothing, and in particular **don't stop the TTS**.
- **V5:** `disable()` also sets `interjectBaseline = null`.

## 6. `src/app/interview/Scratchpad.tsx` (new, `"use client"`; not unit-tested, so keep it small)
- **Props:** `{ onChange: (getImage: () => string | null) => void; onActivity: () => void; disabled: boolean }`.
- **Markup:**
  - a heading `<h3 className="text-sm font-semibold mb-1 opacity-60">Scratchpad</h3>`
  - helper text `Draw your working here. The interviewer looks at it when you pause.`
  - `<canvas width={800} height={500} aria-label="Scratchpad for your working">`, styled `width: 100%`, `touchAction: "none"`, with a 1px border in `var(--foreground)`
  - a `Clear` button
- **Drawing:**
  - In a mount effect, fill the canvas white (`#ffffff`) so the PNG isn't transparent.
  - Draw with pointer events: `pointerdown` (when not `disabled`) calls `setPointerCapture`, starts a path and calls `onActivity()`. `pointermove` while drawing draws line segments (`lineWidth 3`, `lineCap/lineJoin "round"`, `strokeStyle "#111111"`). `pointerup`/`pointercancel` ends the stroke.
  - Scale coordinates by `canvas.width / rect.width` and `canvas.height / rect.height`.
  - When a stroke that drew at least one segment ends, set `hasInk = true` (a ref) and call `onChange(getImage)`.
- **`getImage`** returns `null` when `hasInk` is false; otherwise it returns `canvas.toDataURL("image/png")`.
- **Clear** refills the canvas white, sets `hasInk = false` and calls `onActivity()`. It does **not** call `onChange`.
- **When `disabled`,** no new strokes start, and Clear is disabled.

## 7. `src/app/interview/InterviewScreen.tsx` (changes)
1. **Wire the hooks:**
   ```ts
   const turnRef = useRef<TurnController | null>(null);
   const { view, sendTurn, end, retry, sendBackground } = useInterview(config.id, styleId, {
     onAction: voice.onInterviewAction,
     onBackgroundSettled: (move) => turnRef.current?.settled(move),
   });
   ```
2. **Create the controller in an effect** with deps `[sendBackground]`:
   ```ts
   createTurnController({
     now: () => Date.now(),
     setTimer: (fn, ms) => setTimeout(fn, ms),
     clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
     send: sendBackground,
   })
   ```
   Store it in `turnRef`. The cleanup calls `dispose()` and sets `turnRef.current = null`.
3. **Idle state:**
   - Compute `const idle = view.status === "ready" && view.engine?.phase === "problem" && !voice.snapshot.speaking && pendingTurn === null;`.
   - Add `useEffect(() => { turnRef.current?.setIdle(idle); }, [idle, sendBackground]);`, declared **after** the controller effect.
4. **Partials:** add `useEffect(() => { if (voice.snapshot.partial === null) turnRef.current?.turnBoundary(); else turnRef.current?.partial(voice.snapshot.partial); }, [voice.snapshot.partial, sendBackground]);`.
5. **Voice turns wait for the interviewer:** the voice-turn effect's condition becomes `pendingTurn !== null && canSend(view, pendingTurn) && !voice.snapshot.speaking`, and `voice.snapshot.speaking` joins its deps. A completed voice turn is sent only once the interviewer stops talking, either because playback ended or because of barge-in. This keeps an interjection from being cut off the moment the student pauses to listen.
6. **Typing and sending:**
   - The textarea's `onChange` also calls `turnRef.current?.activity()`.
   - `handleSend` calls `turnRef.current?.turnBoundary()` after `sendTurn(input)`.
7. **The scratchpad:** replace the placeholder `<p className="text-sm opacity-40">Whiteboard coming in a later stage.</p>` with `<Scratchpad onChange={(g) => turnRef.current?.canvasChanged(g)} onActivity={() => turnRef.current?.activity()} disabled={isEnded} />`.
8. Change nothing else. Every existing string, button and Stage 7 behaviour stays as it is.

---

## Tests (vitest, node environment, localhost only)

### `tests/turn-controller.test.ts`
**Write a fake clock in the test file:**
- `now()` returns `t`, starting at `0`.
- `setTimer` stores `{at: t + ms, fn, id}` with an increasing id, and `clearTimer` deletes by id.
- `advanceTo(x)` repeatedly runs the earliest due timer (ordered by `at`, then `id`), setting `t = at` before calling it, until none is due at or before `x`. Then it sets `t = x`.
- `send` records `{t, ...event}` and returns a switchable `ok` flag (default `true`).

Use `W(n)` = `"w1 w2 … wn"` (n space-separated words). Unless a row says otherwise, each vector starts with `setIdle(true)` at `t = 0`. `silent` = `{type:"silent"}` and `hint` = `{type:"hint", rung:0}`. **Assert the exact list of sends, including their `t`.**

| # | Calls | Expected sends |
|---|---|---|
| V1 | `partial(W(3))`; advanceTo 2999; advanceTo 3000 | `[{t:3000, partial W(3)}]` (none at 2999) |
| V2 | `partial(W(8))`; advanceTo 100 | `[{t:0, partial W(8)}]` |
| V3 | `partial(W(8))`; advanceTo 100; `partial(W(16))`; advanceTo 200; `settled(silent)`; advanceTo 300 | `[{t:0, partial W(8)}, {t:200, partial W(16)}]` |
| V4 | `partial(W(3))`; advanceTo 1000; `setIdle(false)`; advanceTo 5000; `setIdle(true)`; advanceTo 5100 | `[{t:5000, partial W(3)}]` |
| V5 | advanceTo 19999; advanceTo 20000; advanceTo 20100; `settled(silent)`; advanceTo 30100; advanceTo 30200; `settled(hint)`; advanceTo 50200; advanceTo 50300; `settled(hint)`; advanceTo 120000; `activity()`; advanceTo 140000 | `[{t:20000, silence ms 20000}, {t:30100, silence ms 30100}, {t:50200, silence ms 20000}, {t:140000, silence ms 20000}]` (nothing between 50300 and 120000: the two-prompt cap) |
| V6 | advanceTo 15000; `activity()`; advanceTo 34999; advanceTo 35000 | `[{t:35000, silence ms 20000}]` |
| V7 | advanceTo 10000; `setIdle(false)`; advanceTo 12000; `setIdle(true)`; advanceTo 31999; advanceTo 32000 | `[{t:32000, silence ms 20000}]` |
| V8 | `A = () => "data:image/png;base64,AAA"`, `B = () => "data:image/png;base64,BBB"`. `canvasChanged(A)`; advanceTo 2000; `canvasChanged(A)`; advanceTo 5999; advanceTo 6000; `settled(silent)`; advanceTo 7000; `canvasChanged(A)`; advanceTo 11000; advanceTo 12000; `canvasChanged(B)`; advanceTo 16000 | `[{t:6000, canvas AAA}, {t:16000, canvas BBB}]` (the repeat of A at 11000 is deduplicated) |
| V9 | `canvasChanged(() => null)`; advanceTo 4000; `canvasChanged(() => big)`; advanceTo 8000; `canvasChanged(() => ok)`; advanceTo 12000. Here `big` = `"data:image/png;base64," + "A".repeat(1_500_001 - 22)` and `ok` = `"data:image/png;base64," + "B".repeat(1_500_000 - 22)` | exactly one send, `{t:12000, canvas ok}` (assert `image.length === 1_500_000`) |
| V10 | `partial(W(5))`; advanceTo 1000; `turnBoundary()`; advanceTo 4000; `partial(W(3))`; advanceTo 6999; advanceTo 7000 | `[{t:7000, partial W(3)}]` |
| V11 | `partial(W(10))`; advanceTo 500; `settled(silent)`; `partial(W(4))`; advanceTo 3499; advanceTo 3500 | `[{t:0, partial W(10)}, {t:3500, partial W(4)}]` |
| V12 | `ok = false`; `partial(W(8))`; `ok = true`; advanceTo 100; `partial(W(8))`; advanceTo 200 | two send calls: `[{t:0, partial W(8)} (returned false), {t:100, partial W(8)}]` |
| V13 | `partial(W(8))`; `partial(W(12))`; `canvasChanged(() => "data:image/png;base64,CCC")`; advanceTo 5000; `settled(silent)`; advanceTo 5100; `settled(silent)`; advanceTo 5200 | `[{t:0, partial W(8)}, {t:5000, partial W(12)}, {t:5100, canvas CCC}]` (a partial goes before a canvas) |
| V14 | `partial(W(3))`; `canvasChanged(() => "data:image/png;base64,DDD")`; `dispose()` → **0 timers pending**; advanceTo 60000; `setIdle(true)`; `partial(W(9))`; `activity()` | `[]` |
| V15 | **No initial `setIdle`.** `partial(W(9))`; advanceTo 3000; `setIdle(true)`; advanceTo 3100 | `[{t:3000, partial W(9)}]` (nothing is sent while not idle) |

Also add:
- the four `hashString` rows
- one test that the exported constants equal the literals above (write the literals: `8`, `3000`, `20000`, `10000`, `2`, `4000`, `1500000`)

### `tests/background-runner.test.ts` (fake `runStepRequest` with manually resolved promises; fake timers via the injected `setTimer`/`clearTimer`)
1. **Silent run:** the dispatched actions are exactly `bg_request`, `bg_move{silent}`, `done`. `onSettled` is called once with `{type:"silent"}`, after `done` was dispatched, and `inFlight()` is false inside `onSettled`.
2. **Spoken run:** `bg_request`, `bg_move{realign}`, then 2 `token`s, then `done`. `onSettled` gets the realign move.
3. **A `slow` is never dispatched:** advance the fake timer past 6000 ms before resolving.
4. **Rejection** with a non-abort `Error`: `bg_failed` is dispatched, and `onSettled(null)` is called once.
5. **`abort()` mid-flight:** `onSettled(null)` is called once. Then resolving the fake promise dispatches nothing more, and the fake's `signal.aborted` is true.
6. **`abort()` when idle** does nothing (no `onSettled`).
7. **`onSettled` calling `run()` synchronously** starts a second run: its `bg_request` is dispatched, and `inFlight()` is true. The first run's later callbacks dispatch nothing.
8. **The `model_label` action** passes through unchanged.

### `tests/interview-model.test.ts` (add a `describe("background steps (stage 8)")`)
- `initialView.background === "none"`.
- **`bg_request`** sets `background: "pending"` and leaves `status`, `streamingText`, `pendingStudentText`, `error` and `lastRequest` unchanged.
- **`bg_move` silent** returns the **same object** (`toBe`).
- **`bg_move` realign** sets `status: "sending"`, `background: "speaking"`, `streamingText: ""` and `lastMove`.
- **`done` after a background request** sets `background: "none"` and replaces `engine`, and `status` is `"ready"`.
- **`bg_failed` while speaking** gives `status: "ready"`, `streamingText: ""`, `background: "none"`, with `engine` unchanged. **While pending,** only `background` changes.
- **A foreground `request`** resets `background` to `"none"`.
- **`mapBackgroundAction`:** request → bg_request (same `request` object); move → bg_move; failed → bg_failed; slow → null; token, done and model_label are returned unchanged (`toBe`).
- **`buildBackgroundRequest`** returns `{ state: engine, event }` for each of the 3 event types, and throws when `engine` is null.

### `tests/voice-interjection.test.ts` (new; copy the fake connect/mic/TTS setup from `tests/voice-controller.test.ts`, but don't edit that file)
Drive partials through the fake relay handlers. "Speaking" means the TTS fakes have started playback after the `token`s and `done`.
1. **Relaxed threshold:** with the partial at 10 words, `bg_move{realign}` followed by tokens and done makes the TTS speak. A partial of 13 words doesn't stop it; a partial of 14 does.
2. **New relay turn:** after `bg_move{realign}` with a 10-word partial, `onTurnStart` while speaking resets the baseline. A 3-word partial doesn't stop the TTS; a 4-word partial does.
3. **Suppression lifted:** after `stopSpeaking()` (suppressed), `bg_move{realign}` plus tokens enqueues speech (the TTS fetch is called).
4. **`bg_move{silent}`** doesn't stop current speech, and doesn't lift the suppression.
5. **`bg_move{hint}`** (the silence path) uses the normal threshold: a 2-word partial stops it.
6. **The next `request`** clears interjection mode: a 2-word partial while speaking stops the TTS.
7. **`bg_failed`** resets the chunker: `token "Hello wor"`, then `bg_failed`, then `done` speaks nothing.
8. **`bg_request`** doesn't stop current speech.
9. **Stale guard:** an `onTurnStart` from a disabled session is ignored.
   - Enable session 1, then disable it, then enable session 2.
   - On session 2's handlers, send a 10-word partial (nothing is speaking yet), then `bg_move{realign}` plus tokens and done, so the TTS speaks with baseline 10.
   - Call **session 1's** `onTurnStart`.
   - A session-2 partial of 13 words must **not** stop the TTS. If the stale call had reset the baseline to 0, it would.

### `tests/e2e-mid-answer.test.ts` (the real `createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now })`, `runStepRequest` with `fetchImpl` as in `tests/e2e-text-interview.test.ts`, `createBackgroundRunner`, and a local `view` updated with `interviewReducer`; real timers)
Use `maths-oxbridge` / `supportive`. Run `start` (foreground) at `now = 1_000_000`, then set `now = 1_005_000`.

`P7` = `"I think this is wrong because two"` (7 words). `P14` = `"I think the answer is wrong because two is not a perfect square here"` (14 words). Each row starts from the state after start, unless stated.

| Event | Expected |
|---|---|
| partial `P7` | `onSettled({type:"silent"})`; transcript length 1; `lastInterjectAt` null; `background: "none"`; `status: "ready"` |
| partial `P14` | `onSettled({type:"realign", misconceptionId:"lowest-terms-missing"})`. In `done`'s state: `lastInterjectAt === 1_005_000`, `turnWordBaseline === 14`, transcript length 2, and the last entry is `speaker: "interviewer"`, `kind: "interjection"`. The joined tokens equal that entry's text. Final `status: "ready"`, `background: "none"` |
| then (from the P14 state, `now = 1_006_000`) partial `P14 + " so it is irrational"` | `silent` (cooldown); `lastInterjectAt` still 1_005_000 |
| canvas `"data:image/png;base64,iVBORw0KGgo="` | `silent`; transcript length 1 |
| silence `10000` | `silent` |
| silence `20000` | `{type:"hint", rung:0}`; `hintRung === 0`; transcript length 2, last entry `kind: "utterance"` |

Add one more test: a **foreground turn supersedes a pending background step**. Start a background partial `P14`, and before it settles, run the foreground `turn_complete` through a request runner and call `bg.abort()` after it. `onSettled(null)` is called once, no `bg_*`/`done` from the background run reaches `view`, and the turn's `done` is applied normally.

---

## Acceptance criteria
1. Only the allowed files changed. Every frozen file is byte-identical (SHA-256 checked against `STATUS.md`, including the Stage 7 hashes).
2. `interview-model.ts` contains exactly the §1 edits. The other modified files follow §3, §5 and §7 and change nothing else.
3. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 warnings, and `npx next build` passes with no keys set.
4. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** Every pre-existing test passes unchanged (694 before this stage), and no test name disappears.
5. The V1–V15 and hash vectors and the e2e table are asserted with the literal values above.
6. **Offline under `next dev`** (`INTERIM_FAKE_MODEL=1`), the text interview still works end to end. The scratchpad renders, and a sketch followed by a 4 s pause produces one `/api/step` request with a `canvas` event. Waiting 20 s produces a `silence` request, and after 2 hints the silence prompts stop until the student types.
7. Nothing logs partial text, transcript text or image data.
8. `STAGE8_NOTES.md` lists what you built, any deviations, and anything you couldn't do, with reasons.

## Held (not part of this stage)
- **Live interjection quality and latency** (real assessor, partials under about 3.5 s), and whether Muse Spark accepts the canvas `image_url` data URI. These need `MODEL_API_KEY`.
- **Real mic and echo QA of interjection barge-in** in browsers. This needs the relay connected to Meta.
- Any deploy.
