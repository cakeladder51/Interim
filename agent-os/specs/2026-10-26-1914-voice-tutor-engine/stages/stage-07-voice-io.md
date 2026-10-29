# Stage 7 brief: Voice in/out, milestone M2 (handoff to the external model)

## Goal
Let the student **speak** their answers and **hear** the interviewer, turn by turn, in the existing interview screen. Typing must keep working throughout.

- **Voice in (B2):**
  - The browser microphone is captured with an AudioWorklet and converted to 16 kHz PCM16LE in 100 ms frames.
  - The frames go to the Stage 6 relay over a WebSocket, authenticated with a token from `/api/relay-token`.
  - Relay `partial` messages are shown as a live caption.
  - Relay `turn_complete` messages are sent to the engine as a turn with `source: "voice"`.
- **Voice out (B3):**
  - The interviewer's streamed reply is split into sentences, and each sentence is spoken.
  - The provider is OpenAI TTS through a new `/api/tts` route. If that's unavailable, the browser's `speechSynthesis` speaks instead.
  - **Barge-in:** when the student starts talking over the interviewer, the interviewer's audio stops.
- **Fallback:** if the mic or the relay is unavailable, the student keeps typing. A clear message says so, and nothing breaks.

**Build and test everything offline.**
- **Live TTS needs `OPENAI_API_KEY`, and live speech recognition needs the relay connected to Meta with `MODEL_API_KEY`. Both are on hold.** Never call `api.openai.com` or `api.meta.ai`, and never add keys.
- Tests use fakes and `127.0.0.1` only.
- Mid-answer interjections (sending `partial` events to `/api/step`), silence events and the canvas are **Stage 8**, not this stage.

---

## What already exists: read this first
You're starting in a fresh session. **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win. `STATUS.md` lists completed stages, frozen file hashes and held items. **This repo uses Next.js 16.4 with breaking changes.** Before writing route or client code, read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices.

**Stack:**
- Next.js 16.4 App Router. `next.config.ts` has `cacheComponents: true`, so there's **no `export const runtime`/`dynamic`**, and route files may only export route names such as `POST`.
- React 19.3, TypeScript strict, zod v4 (`import { z } from "zod"`).
- vitest runs in a **node environment** (`vitest.config.ts`). Tests live in `tests/` and run with `npx vitest run`. `@/*` maps to `src/*`, and `server-only` is mocked in tests.
- ESLint is `eslint-config-next` (core-web-vitals + typescript), so **no `any`**; use `unknown` and narrow.
- `ws` is installed and may be used **in tests only**, never in `src/`. The browser uses the global `WebSocket`.

**Server modules** start with `import "server-only"` and take injected deps. The pattern to copy: `src/server/relay-token-handler.ts` and `src/app/api/relay-token/route.ts`.

**`POST /api/relay-token`** (Stage 6, frozen):
- **Request:** JSON `{ "configId": "<id>" }`.
- **200:** `{ token, url, expiresAt }`. `url` is the relay's `ws(s)://…/asr`, and the token is single-use and valid for 120 s.
- **503:** `{ error: { code: "relay_unavailable", … } }` when `RELAY_SECRET`/`RELAY_URL` aren't set.
- **400:** a bad body.
- Every response has `Cache-Control: no-store`.

**The relay protocol** (`src/contracts/relay-protocol.ts`, frozen; exported from `@/contracts`):
- **Client → relay:**
  1. First a text frame `{"type":"auth","token":"…"}`.
  2. Then **binary** frames of PCM16LE, 16 kHz, mono.
  3. `{"type":"end"}` to finish.
- **Relay → client** (text JSON; validate with `RelayServerMessageSchema`):
  - `{type:"ready"}`
  - `{type:"partial", text}` (cumulative: each one replaces the previous)
  - `{type:"turn_start", turnId}`
  - `{type:"turn_complete", turnId, text}`
  - `{type:"error", message, fatal}`
- **Close codes:** 1000 normal (after `end`), 1013 busy, 4001 unauthorized, 4008 session time limit, 4502 upstream error or disconnect, 4503 upstream unavailable.
- The relay buffers up to 2 s of audio sent before `ready`.

**Relay test helpers** (use them; don't modify them):
- `relay/src/server.ts`: `startRelay(opts)` returns `{ port, close(), trackedSessions() }`.
- `tests/helpers/fake-meta-asr.ts`: `startFakeMetaAsr({ ack? })` returns `{ url, handshakes, audio: Buffer[], texts, send(event), close(code), connections(), openConnections(), sendRawFrame, stop() }`.
- `src/shared/relay-token.ts`: `signRelayToken({ v: 1, exp, nonce /* 32 hex chars */, configId }, secret)`.
- See `tests/relay-server.test.ts` for how these are combined: `startRelay({ port: 0, secret, apiKey, upstreamUrl: fake.url, allowedOrigins: null, maxSessions, authTimeoutMs, upstreamReadyTimeoutMs, maxSessionMs, preReadyBufferBytes })`.
- **Fake-Meta event shapes:**
  - `{ type: "speechStart", turnId }` → the relay sends `turn_start`
  - `{ type: "transcript", transcript, final: false }` → `partial`
  - `{ type: "speechComplete", turnId, transcript }` → `turn_complete`

**The text interview client** (Stage 4):
- **`src/client/interview-model.ts`:**
  - the pure reducer `interviewReducer`
  - `InterviewView` (`status: "starting" | "ready" | "sending" | "ended" | "error"`, `engine`, `streamingText`, …)
  - `InterviewAction`:
    - `{type:"request", request, studentText}`
    - `{type:"move", move}`
    - `{type:"token", text}`
    - `{type:"slow"}`
    - `{type:"done", state}`
    - `{type:"failed", message, retryable}`
    - `{type:"model_label", label}`
  - `canSend(view, text)`, `buildTurnRequest(view, text)` (currently always `source: "typed"`), `visibleTranscript(view)`
- **`src/client/request-runner.ts`:** runs one step request at a time and dispatches actions. Every streamed interviewer token arrives as a `token` action, and the stream ends with `done` (or `failed`). A superseded request dispatches nothing more.
- **`src/client/use-interview.ts`:** `useInterview(configId, styleId)` returns `{ view, sendTurn(text), end(), retry() }`.
- **`src/app/interview/InterviewScreen.tsx`:** the client component with the transcript, problem panel, error banner and the textarea + Send answer bar. `config: PublicConfig` provides `config.id`.
- **The engine event** `turn_complete` is `{ type: "turn_complete", text, source: "voice" | "typed" }` (`src/contracts/engine.ts`, frozen).

**Env (`.env.example`):** `OPENAI_API_KEY`, `RELAY_URL`, `RELAY_SECRET` and others already exist. Don't use `src/lib/env.ts` `getServerEnv()` in new code: it throws when `MODEL_API_KEY` is missing. Use an injected `getEnv` instead.

**Known intermittent test (don't touch it):** `tests/step-route.test.ts` › "step-handler abort mid-speak: no events after abort, no unhandled rejection" occasionally fails under full-suite CPU load. It's a pre-existing test-environment issue the reviewer is tracking. If it's the **only** failure, re-run the suite and mention it in `STAGE7_NOTES.md`. **Never edit or weaken that test.**

**Acceptance always includes:** `npx vitest run` **exits 0 with no `Errors` / "Unhandled Rejection" lines**.
- Attach a rejection handler to every promise before it can reject.
- In tests, close every socket, relay and fake in `afterEach`.
- Tests that use timers must not leave timers running.

---

## Constraints
- **New files allowed:**
  - `src/client/voice/pcm-encoder.ts`
  - `src/client/voice/sentence-chunker.ts`
  - `src/client/voice/relay-client.ts`
  - `src/client/voice/tts-player.ts`
  - `src/client/voice/voice-controller.ts`
  - `src/client/voice/browser-audio.ts`
  - `src/client/use-voice.ts`
  - `public/audio/capture-worklet.js`
  - `src/server/tts-handler.ts`
  - `src/app/api/tts/route.ts`
  - `tests/voice-*.test.ts`
  - `tests/tts-route.test.ts`
  - `STAGE7_NOTES.md`
- **Modified files allowed:**
  - `src/app/interview/InterviewScreen.tsx`: the voice UI below.
  - `src/client/interview-model.ts` and `src/client/use-interview.ts`: **only the exact edits in "Unfrozen edits"**. The reviewer reverses those edits and checks the frozen hashes (`98035e9d…`, `8e4f2ae0…`).
  - `tests/interview-model.test.ts`: add tests only.
- **Frozen; SHA-256 checked:** every other file under `src/`, plus `relay/`, `configs/`, `evals/`, `scripts/`, `tests/helpers/`, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.env.example`, and everything under `agent-os/`.
- **No new dependencies.**
- **Never edit a frozen file to get around a problem.** If something blocks you, stop and write it in `STAGE7_NOTES.md`.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **No network** beyond `127.0.0.1`/`localhost` in tests.
- **Browser-only globals** (`window`, `navigator`, `AudioContext`, `WebSocket`, `speechSynthesis`) may be touched **only inside functions**, never at module top level. Client components are also rendered on the server.
- **Never log** audio, transcript text, tokens or keys. Log lengths or counts only.

---

## Unfrozen edits (exactly these; nothing else in these two files)

**`src/client/interview-model.ts`:**
1. Replace
   ```ts
   export function buildTurnRequest(view: InterviewView, text: string): StepRequest {
   ```
   with
   ```ts
   export function buildTurnRequest(
     view: InterviewView,
     text: string,
     source: "typed" | "voice" = "typed"
   ): StepRequest {
   ```
2. Replace `    event: { type: "turn_complete", text: text.trim(), source: "typed" },` with `    event: { type: "turn_complete", text: text.trim(), source },`.

**`src/client/use-interview.ts`:**
1. Replace `import type { InterviewView } from "./interview-model";` with `import type { InterviewAction, InterviewView } from "./interview-model";`.
2. Signature: add a third parameter, `options?: { onAction?: (action: InterviewAction) => void }`. In the return type, change `sendTurn: (text: string) => void;` to `sendTurn: (text: string, source?: "typed" | "voice") => void;`.
3. Keep a ref to the latest listener: `const onActionRef = useRef(options?.onAction);`, synced in an effect: `useEffect(() => { onActionRef.current = options?.onAction; });`.
4. In `createRequestRunner({ … })`, replace `dispatch,` with `dispatch: (action) => { onActionRef.current?.(action); dispatch(action); },`.
5. In `sendTurn`:
   - the callback parameters become `(text: string, source: "typed" | "voice" = "typed")`
   - `buildTurnRequest(view, text)` becomes `buildTurnRequest(view, text, source)`

---

## Files to create

### 1. `public/audio/capture-worklet.js` (exactly this)
```js
// AudioWorklet: batches mono mic samples (2048 at a time) and posts them to the main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
```

### 2. `src/client/voice/pcm-encoder.ts` (pure)
```ts
export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz = 3200 bytes
export function createPcmEncoder(inputRate: number, frameSamples?: number /* default FRAME_SAMPLES */): {
  push(samples: Float32Array): Uint8Array[];   // zero or more complete frames
  flush(): Uint8Array | null;                   // the partly filled frame (fewer samples), or null if empty
};
```
**Algorithm** (box-filter decimation; must match the test vectors exactly):
- **Rate check:** if `inputRate` isn't an integer, or is < 16000, throw `Error("Unsupported input sample rate: " + inputRate)`.
- **Windows:** output sample `k` (0, 1, 2, … counted across all pushes) is the **mean** of the input samples with global indices from `floor(k*inputRate/16000)` up to but **excluding** `floor((k+1)*inputRate/16000)`.
  - Compute these boundaries with **integer arithmetic**, `Math.floor(((k + 1) * inputRate) / 16000)`, never with a precomputed float ratio.
  - Emit output sample `k` as soon as the last input sample of its window arrives. Keep the state (running sum, count, input index, `k`) across `push` calls, so splitting the input differently never changes the output.
- **Conversion:** `Math.round(Math.max(-1, Math.min(1, mean)) * 32767)`, written as **little-endian int16**.
- **Frames:** every `frameSamples` output samples form one frame of `frameSamples*2` bytes.
- **`flush()`:**
  - returns the partly filled frame and resets it
  - discards an incomplete input window
  - returns `null` if the frame is empty

### 3. `src/client/voice/sentence-chunker.ts` (pure)
```ts
export const MAX_CHUNK_CHARS = 200;
export function createSentenceChunker(): { push(text: string): string[]; flush(): string | null; reset(): void };
```
- **`push(text)`:** append `text` to an internal buffer, then repeat:
  1. Find the first match of `/[.?!]+["')\]]*\s+|\n+/`. If there is one, the chunk is everything up to the **end** of the match, trimmed. Remove it from the buffer. If the chunk is non-empty, output it. Continue.
  2. Otherwise, if the buffer is longer than `MAX_CHUNK_CHARS`, cut at `cut = buffer.lastIndexOf(" ", MAX_CHUNK_CHARS)`. If `cut <= 0`, use `cut = MAX_CHUNK_CHARS`. The chunk is `buffer.slice(0, cut).trim()`, and the buffer becomes `buffer.slice(cut)`. Output the chunk if non-empty. Continue.
  3. Otherwise stop.

  Return the chunks in order.
- **`flush()`:** returns the trimmed buffer, or `null` if it's empty, and clears the buffer.
- **`reset()`:** clears the buffer.

### 4. `src/client/voice/relay-client.ts` (no browser globals; the socket and token come from deps)
```ts
export const RELAY_READY_TIMEOUT_MS = 12_000;
export const RELAY_END_TIMEOUT_MS = 3_000;
export type RelayFailureKind = "unavailable" | "unauthorized" | "busy" | "upstream" | "timeout" | "closed";
export class RelayConnectError extends Error {
  constructor(readonly kind: RelayFailureKind, readonly code: number | null) // name = "RelayConnectError"
}
export interface WebSocketLike {
  readonly readyState: number;                      // 1 = OPEN
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number }) => void): void;
}
export interface RelayHandlers {
  onPartial(text: string): void;
  onTurnStart(turnId: string): void;
  onTurnComplete(turnId: string, text: string): void;
  onClose(info: { code: number; intentional: boolean }): void;
}
export interface RelayConnection { sendAudio(frame: Uint8Array): void; end(): Promise<void>; close(): void }
export function connectRelay(opts: {
  fetchToken: () => Promise<{ token: string; url: string }>;
  createSocket: (url: string) => WebSocketLike;
  handlers: RelayHandlers;
  readyTimeoutMs?: number;   // default RELAY_READY_TIMEOUT_MS
  endTimeoutMs?: number;     // default RELAY_END_TIMEOUT_MS
}): Promise<RelayConnection>;
```
**Rules:**
1. **Token:** if `fetchToken` rejects, reject with `RelayConnectError("unavailable", null)`, and **don't** create a socket.
2. **Auth:** call `createSocket(url)`. On `open`, send `JSON.stringify({ type: "auth", token })`.
3. **Parsing:** only **string** `event.data` is parsed: `JSON.parse`, then `RelayServerMessageSchema.safeParse`. Invalid JSON, schema failures and non-string data are ignored.
4. **Before `ready`:**
   - `ready` clears the timer and resolves the promise with the connection.
   - A `close` before `ready` rejects with `RelayConnectError(kind, code)`. The kind comes from the close code: 4001 → `"unauthorized"`, 1013 → `"busy"`, 4502 or 4503 → `"upstream"`, anything else → `"closed"`.
   - A socket `error` event is ignored (a `close` always follows).
   - If `readyTimeoutMs` passes first: call `close(1000)`, reject with `RelayConnectError("timeout", null)`, and ignore any later events.
5. **After `ready`:**
   - `partial` → `onPartial(text)`
   - `turn_start` → `onTurnStart(turnId)`
   - `turn_complete` → `onTurnComplete(turnId, text)`
   - `error` messages are ignored (a fatal one is followed by `close`)
   - The first `close` calls `onClose({ code, intentional })` **exactly once**. `intentional` is true if `end()` or `close()` was called before the close arrived.
6. **`sendAudio(frame)`:** sends the frame only when `readyState === 1`; otherwise drops it.
7. **`end()`:**
   - If the socket is already closed, resolve immediately.
   - Otherwise send `{"type":"end"}` and resolve when the close arrives.
   - If no close arrives within `endTimeoutMs`, call `close(1000)` and resolve.
8. **`close()`:** `close(1000)`.

### 5. `src/client/voice/tts-player.ts` (no browser globals)
```ts
export class TtsUnavailableError extends Error {} // name = "TtsUnavailableError"
export interface Playback { done: Promise<void>; stop(): void }
export interface TtsPlayerDeps {
  fetchAudio(text: string, signal: AbortSignal): Promise<ArrayBuffer>;
  playAudio(bytes: ArrayBuffer): Playback;
  speakFallback(text: string): Playback;
  onSpeakingChange(speaking: boolean): void;
}
export function createTtsPlayer(deps: TtsPlayerDeps): {
  enqueue(text: string): void; stop(): void; speaking(): boolean; mode(): "provider" | "fallback";
};
```
**Rules:**
1. **`enqueue(text)`:**
   - Ignore it if `text.trim()` is empty.
   - In `"provider"` mode, **start `fetchAudio` immediately**, with the item's own `AbortController`, so later sentences prefetch while earlier ones play.
   - Add the item to the queue, and start playback if idle.
2. **Order:** items play **strictly in enqueue order**, one at a time.
   - **Provider item:** await its fetch, then `playAudio(bytes)` and await `done`.
   - **Failure:** if the fetch rejects, or the playback's `done` rejects, that item is spoken with `speakFallback(text)`, and its `done` is awaited.
3. **Sticky fallback:**
   - A `TtsUnavailableError` switches `mode()` to `"fallback"` **for the rest of the session**. Every queued item that hasn't started playing gets its fetch aborted and is spoken with `speakFallback`.
   - Any other failure increments a consecutive-failure counter, and **2 consecutive failures** also switch to sticky fallback.
   - A successful provider playback resets the counter to 0.
   - An aborted fetch (`AbortError`) caused by `stop()` isn't a failure.
4. **In `"fallback"` mode,** `enqueue` doesn't fetch.
5. **`speaking()`:** true from the moment playback of the first item starts (including the wait for its audio) until the queue is drained. `onSpeakingChange(true)` and `onSpeakingChange(false)` are each called **once per transition**.
6. **`stop()`:**
   - aborts every pending fetch, stops the current playback, and clears the queue
   - ignores results of anything started before the `stop()` (use a generation counter)
   - if `speaking()` was true, it becomes false and `onSpeakingChange(false)` is called; when idle, there's no callback

### 6. `src/client/voice/voice-controller.ts` (no browser globals; React-free)
```ts
export const BARGE_IN_MIN_WORDS = 2;
export const VOICE_MESSAGES = {
  mic: "Microphone unavailable. You can keep typing your answers.",
  relay: "Voice input is unavailable right now. You can keep typing your answers.",
  busy: "Voice input is busy right now. You can keep typing your answers.",
  dropped: "Voice input disconnected. You can keep typing your answers.",
} as const;
export type VoiceStatus = "off" | "starting" | "listening" | "reconnecting" | "unavailable";
export interface VoiceSnapshot { status: VoiceStatus; message: string | null; partial: string | null; speaking: boolean }
export interface MicHandle { sampleRate: number; stop(): void }
export function queueVoiceTurn(pending: string | null, text: string): string; // pending === null ? text.trim() : pending + " " + text.trim()
export function createVoiceController(deps: {
  connect: (handlers: RelayHandlers) => Promise<RelayConnection>;      // connectRelay with token/socket deps bound
  startMic: (onSamples: (samples: Float32Array) => void) => Promise<MicHandle>;
  tts: Omit<TtsPlayerDeps, "onSpeakingChange">;
  onTurn: (text: string) => void;
  onChange: (snapshot: VoiceSnapshot) => void;   // called after every snapshot change
}): {
  enable(): void; disable(): void; dispose(): void;
  snapshot(): VoiceSnapshot;
  handleInterviewAction(action: InterviewAction): void;
  speakNow(text: string): void;
  stopSpeaking(): void;
};
```
The controller creates its own `createTtsPlayer` (passing `deps.tts` plus an `onSpeakingChange` that updates `snapshot.speaking`) and its own `createSentenceChunker`. The initial snapshot is `{ status: "off", message: null, partial: null, speaking: false }`.

**Input (mic → relay):**
1. **`enable()`** is a no-op unless the status is `off` or `unavailable`. Otherwise:
   - Set `starting` and clear `message`.
   - Call `deps.startMic(onSamples)` **synchronously, with no `await` before it**, so it runs inside the click gesture.
   - When the mic resolves, create `createPcmEncoder(mic.sampleRate)`, then call `deps.connect(handlers)`. When that resolves, set `listening`.
2. **Audio:** while `listening`, each `onSamples` batch goes through the encoder, and every complete frame goes to `connection.sendAudio(frame)`. Samples arriving at any other time are dropped.
3. **Mic failure:** if `startMic` rejects, or the encoder throws on an unsupported rate, set `unavailable` with `VOICE_MESSAGES.mic`, after stopping the mic if it was started.
4. **Relay failure:** if `connect` rejects, stop the mic and set `unavailable`. The message is `VOICE_MESSAGES.busy` for `RelayConnectError` kind `"busy"`, and `VOICE_MESSAGES.relay` otherwise.
5. **Relay handlers:**
   - `onPartial(text)`: set `snapshot.partial = text`. Then apply **barge-in**: if `tts.speaking()` and `text` has **≥ `BARGE_IN_MIN_WORDS`** words (`text.trim().split(/\s+/).filter(Boolean).length`), call `tts.stop()`, reset the chunker, and set `suppressed = true`.
   - `onTurnComplete(_, text)`: set `partial = null`. If `text.trim()` is non-empty, call `deps.onTurn(text.trim())`.
6. **Unexpected close** (`onClose` with `intentional: false`) while `listening`:
   - Set `reconnecting` and clear `partial`. **Keep the mic running and the encoder state; drop audio while reconnecting.**
   - Call `deps.connect` **once** more. On success, set `listening`. On failure, stop the mic and set `unavailable` with `VOICE_MESSAGES.dropped`.
   - (Another unexpected close later gets its own single reconnect attempt.)
7. **`disable()`:**
   - Set `off`, and clear `message` and `partial`.
   - Stop the mic and call `connection.end()`, catching any rejection. Discard the encoder, and call `tts.stop()`.
8. **Stale results:** keep a **generation counter**, bumped by `enable()`, `disable()` and `dispose()`. A `startMic` or `connect` that resolves after its generation ended must be stopped or closed immediately and must change nothing. This handles React StrictMode and "Stop voice" while connecting.
9. **`dispose()`:** the same as `disable()`, and afterwards the controller ignores every call.

**Output (interviewer speech).** Speak only while the status isn't `off`.
- **`handleInterviewAction(action)`:**
  - `request`: `tts.stop()`, reset the chunker, set `suppressed = false`
  - `token`: if `off` or `suppressed`, ignore; otherwise `enqueue` every chunk returned by `chunker.push(action.text)`
  - `done`: if `off` or `suppressed`, reset the chunker; otherwise `flush()` and `enqueue` the result if it isn't null
  - `failed`: reset the chunker
  - anything else: ignore
- **`speakNow(text)`:** if `off`, ignore. Otherwise call `tts.stop()`, reset the chunker, set `suppressed = false`, then `enqueue` every chunk of `push(text)` followed by the `flush()` result.
- **`stopSpeaking()`:** call `tts.stop()`, reset the chunker, and set `suppressed = true` until the next `request`.

### 7. `src/client/voice/browser-audio.ts` (the only file that touches browser audio and network APIs; not unit-tested, so keep it small)
- **`getAudioContext(): AudioContext`:** lazily creates **one** shared `new AudioContext()`, calls `resume()` when it's `suspended`, and returns it.
- **`startBrowserMic(onSamples): Promise<MicHandle>`:**
  1. Call `getAudioContext()` first, **synchronously**.
  2. `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
  3. `ctx.audioWorklet.addModule("/audio/capture-worklet.js")`, only once per context.
  4. `createMediaStreamSource(stream)`, and `new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })`, whose `port.onmessage` forwards `event.data as Float32Array` to `onSamples`.
  5. Connect source → node → a `GainNode` with gain 0 → `ctx.destination`. This keeps the node pulled in every browser.
  6. Return `{ sampleRate: ctx.sampleRate, stop() }`. `stop` disconnects all three nodes, clears `onmessage`, and stops every track.
- **`fetchRelayToken(configId)`:** POST `/api/relay-token` with JSON `{ configId }`. A non-200 response throws an `Error`. Otherwise return `{ token, url }` from the JSON.
- **`createBrowserSocket(url)`:** `const ws = new WebSocket(url); ws.binaryType = "arraybuffer"; return ws;`.
- **`fetchTtsAudio(text, signal)`:** POST `/api/tts` with JSON `{ text }` and `signal`. 503 → throw `new TtsUnavailableError()`. Any other non-200 → throw `Error("tts " + status)`. Otherwise return `await res.arrayBuffer()`.
- **`playAudioBuffer(bytes): Playback`:** `getAudioContext().decodeAudioData(bytes.slice(0))`, then an `AudioBufferSourceNode` → `destination`. `done` resolves on `ended` and rejects if decoding fails. `stop()` stops the source (if started) and resolves `done`.
- **`speakWithSynthesis(text): Playback`:**
  - If `window.speechSynthesis` is missing, `done` resolves immediately.
  - Otherwise use a `SpeechSynthesisUtterance` with `lang = "en-GB"`. `done` resolves on `end` or `error`.
  - `stop()` calls `speechSynthesis.cancel()` and resolves `done`.

### 8. `src/client/use-voice.ts` (`"use client"` React hook)
`useVoice(configId: string)` returns:
```ts
{
  snapshot: VoiceSnapshot; pendingTurn: string | null; takePendingTurn(): void;
  enable(): void; disable(): void; stopSpeaking(): void; speakNow(text: string): void;
  onInterviewAction(action: InterviewAction): void
}
```
- **Controller:** create it in a `useEffect` (store it in a ref) with the `browser-audio.ts` adapters:
  - `connect = (handlers) => connectRelay({ fetchToken: () => fetchRelayToken(configId), createSocket: createBrowserSocket, handlers })`
  - `startMic = startBrowserMic`
  - `tts = { fetchAudio: fetchTtsAudio, playAudio: playAudioBuffer, speakFallback: speakWithSynthesis }`
  - `onTurn = (t) => setPendingTurn((p) => queueVoiceTurn(p, t))`
  - `onChange = setSnapshot`

  Call `dispose()` in the effect cleanup.
- **`enable()`:** call `getAudioContext()` synchronously first (inside the click), then `controller.enable()`.
- **`onInterviewAction` and the other methods:** stable identities (`useCallback` with `[]`) that forward to `ref.current`.

### 9. `src/app/interview/InterviewScreen.tsx`: voice UI (exact strings)
- **Wiring:**
  ```ts
  const voice = useVoice(config.id);
  const { view, sendTurn, end, retry } = useInterview(config.id, styleId, { onAction: voice.onInterviewAction });
  ```
- **Voice turns:** in an effect, when `voice.pendingTurn !== null && canSend(view, voice.pendingTurn)`, call `sendTurn(voice.pendingTurn, "voice")` and then `voice.takePendingTurn()`.
- **End:** when `view.status === "ended"`, call `voice.disable()`.
- **Voice button:** in the answer bar, left of the textarea; hidden once the interview has ended.
  - **Label:** `Start voice` when the status is `off` or `unavailable`, otherwise `Stop voice`.
  - **"Start voice" click:**
    1. `voice.enable()`.
    2. If `view.status === "ready"` and the last entry of `view.engine.transcript` is from the interviewer, `voice.speakNow(thatEntry.text)`, so the student hears the question they're on.
  - **Status text** next to the button: `Connecting…` (starting), `Listening` (listening), `Reconnecting…` (reconnecting).
- **Caption:** when `voice.snapshot.partial` isn't null, show the line `You (speaking): {partial}` above the answer bar, in an element with `aria-live="polite"`.
- **Speaking indicator:** when `voice.snapshot.speaking`, show `Interviewer speaking` with a `Stop speaking` button that calls `voice.stopSpeaking()`.
- **Message:** when `voice.snapshot.message` isn't null, show it in an element with `role="status"`.
- **Typing:** the textarea and Send button keep working exactly as now, in every voice state.

### 10. `src/server/tts-handler.ts` (`import "server-only"`) and `src/app/api/tts/route.ts`
```ts
export const TTS_URL = "https://api.openai.com/v1/audio/speech";
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TTS_VOICE = "alloy";
export const TTS_MAX_CHARS = 1000;
export const TTS_TIMEOUT_MS = 10_000;
export function createTtsHandler(deps: {
  getEnv: () => Record<string, string | undefined>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}): (request: Request) => Promise<Response>;
```
**Responses.** Every response has `Cache-Control: no-store`.
- **`OPENAI_API_KEY` missing or empty → 503:**
  - body: `{ "error": { "code": "tts_unavailable", "message": "Voice output is not available right now." } }`
  - Log `console.warn("Interim: OPENAI_API_KEY is not set; /api/tts is unavailable.")` **once per handler instance**.
- **Bad request → 400:** invalid JSON, `text` not a string, empty after trimming, or longer than `TTS_MAX_CHARS` after trimming.
  - body: `{ "error": { "code": "bad_request", "message": "Invalid TTS request." } }`
- **Upstream call:** `deps.fetch(TTS_URL, { … })` with:
  - `method: "POST"`
  - `headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }`
  - `body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: trimmedText, response_format: "mp3" })`
  - `signal: AbortSignal.timeout(TTS_TIMEOUT_MS)`
- **Success → 200:** the upstream `ok` with a body becomes `new Response(upstream.body, …)` with `Content-Type: audio/mpeg`, streamed through.
- **Upstream failure → 502:** upstream not `ok`, or `fetch` throws.
  - body: `{ "error": { "code": "tts_failed", "message": "Voice output failed." } }`
  - Log `console.warn(JSON.stringify({ tag: "tts_error", status: <upstream status or 0>, chars: <trimmed length> }))`.
- **Never log the key or the text.**

**The route file is exactly:**
```ts
import { createTtsHandler } from "@/server/tts-handler";
export const POST = createTtsHandler({ getEnv: () => process.env, fetch: (input, init) => fetch(input, init) });
```

---

## Tests (vitest, node environment, localhost only)

### `tests/voice-pcm.test.ts`
The reviewer computed these vectors with a reference implementation of the algorithm above. **Use them as literals.**
| # | Setup | Expected |
|---|---|---|
| V1 | `createPcmEncoder(48000)`, push 4800 samples, all `0.5` | exactly **1** frame of **3200** bytes; every int16 (LE) is **16384**; the first 4 bytes are `00 40 00 40`; then `flush()` returns `null` |
| V2 | `createPcmEncoder(48000, 4)`, push `[0, 0.25, 0.5, 1, 1, 1, -1, -1, -1, 2, 2, 2]` | 1 frame, int16s `[8192, 32767, -32767, 32767]`, hex `0020ff7f0180ff7f` |
| V3 | `createPcmEncoder(44100, 4)`, push `[0, 0.5, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5]` | 1 frame, int16s `[8192, 8192, 16384, -16383]` |
| V4 | `createPcmEncoder(16000, 3)`, push `[0.5, -0.5, 0.25, 1]` | push returns 1 frame `[16384, -16383, 8192]`; `flush()` returns `[32767]` (2 bytes); a second `flush()` returns `null` |
| V5 | For rates 48000, 44100 and 22050: the same 10 000 pseudo-random samples in `[-1, 1)`, pushed **once** versus pushed in slices of sizes 1, 2, 3, …, 7, 1, 2, … | the concatenated frames + flush are byte-identical. Total bytes: **6666** (48000), **7256** (44100), **14512** (22050) |
| V6 | `createPcmEncoder(8000)`, `(15999)`, `(44100.5)` | each throws `Unsupported input sample rate: <rate>` |

For V5's samples, use `let x = 12345; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;` and `Float32Array.from({ length: 10000 }, rnd)`.

### `tests/voice-chunker.test.ts` (reviewer-verified)
| # | Calls | Expected |
|---|---|---|
| C1 | `push("Hello there. How")`, `push(" are you? I")`, `flush()` | `["Hello there."]`, `["How are you?"]`, `"I"` |
| C2 | `push("Is it 3.5")`, `push("? Yes")`, `flush()` | `[]`, `["Is it 3.5?"]`, `"Yes"` |
| C3 | `push('He said "stop." Then')`, `flush()` | `['He said "stop."']`, `"Then"` |
| C4 | `push("First line\nSecond")`, `flush()` | `["First line"]`, `"Second"` |
| C5 | `push("word ".repeat(50))`, `flush()` | 1 chunk of length 199 (40 words); flush gives `"word word word word word word word word word word"` |
| C6 | `push("A. B! C? D")`, `flush()` | `["A.", "B!", "C?"]`, `"D"` |
| C7 | `push("Wait... what")`, `flush()` | `["Wait..."]`, `"what"` |
| C8 | `push("   ")`, `flush()` | `[]`, `null` |
| C9 | `push("Dropped text")`, `reset()`, `push("Kept. ")`, `flush()` | the last push gives `["Kept."]`; flush gives `null` |
| C10 | `push("x".repeat(450))`, `flush()` | chunk lengths `[200, 200]`; flush length 50 |
| C11 | `push("Good.\n\nNext question: why?")`, `flush()` | `["Good."]`, `"Next question: why?"` |

### `tests/voice-relay-client.test.ts` (real relay + fake Meta + the `ws` client, all on `127.0.0.1`)
- **Setup:**
  - `startFakeMetaAsr()`, then `startRelay({ port: 0, secret: "s".repeat(40), apiKey: "test-api-key", upstreamUrl: fake.url, allowedOrigins: null, maxSessions: 5, authTimeoutMs: 500, upstreamReadyTimeoutMs: 1000, maxSessionMs: 30_000, preReadyBufferBytes: 64000 })`.
  - `fetchToken` signs a fresh token with a fresh 32-hex nonce and `configId: "maths-oxbridge"`, and returns `{ token, url: "ws://127.0.0.1:<port>/asr" }`.
  - `createSocket = (url) => new WebSocket(url) as unknown as WebSocketLike`, using `ws`.
- **Tests:**
  1. **Connect:** `connectRelay` resolves. The fake has exactly 1 handshake.
  2. **Audio:** three `sendAudio` frames (3200 bytes each, distinct contents) arrive at `fake.audio` byte for byte, in order.
  3. **Events:** the fake sends `speechStart {turnId:"t1"}`, `transcript {transcript:"I think", final:false}`, `speechComplete {turnId:"t1", transcript:"I think it is two"}`. The handlers receive exactly `onTurnStart("t1")`, `onPartial("I think")`, `onTurnComplete("t1", "I think it is two")`, in that order.
  4. **`end()`:** the fake's `texts` contain `{type:"endStream"}`. After `fake.close(1000)`, `end()` resolves, and `onClose` is called once with `{ code: 1000, intentional: true }`.
  5. **`fake.close(1011)` mid-session:** `onClose` is called once with `{ code: 4502, intentional: false }`.
  6. **`fetchToken` rejects:** `connectRelay` rejects with `RelayConnectError` kind `"unavailable"`, and `createSocket` is never called (use a spy).
  7. **A token signed with the wrong secret:** rejects with kind `"unauthorized"`, code `4001`.
  8. **`maxSessions: 1`, with one session already connected:** a second `connectRelay` rejects with kind `"busy"`, code `1013`.
  9. **The fake with `ack: "never"`** (relay `upstreamReadyTimeoutMs: 300`): rejects with kind `"upstream"`, code `4503`.
  10. **`readyTimeoutMs: 200`, with the fake on `ack: "never"`** (relay `upstreamReadyTimeoutMs: 5000`): rejects with kind `"timeout"`, code `null`, within 1 s.
  11. **Unit test with a hand-written fake `WebSocketLike`** (no relay): text frames that are invalid JSON or don't match the schema, and binary (`ArrayBuffer`) data, are ignored without throwing. `sendAudio` while `readyState !== 1` doesn't call `send`.

### `tests/voice-tts-player.test.ts` (fakes with manually resolved promises; no timers)
1. **Prefetch:** three `enqueue` calls start **three** `fetchAudio` calls immediately, before any playback finishes. `playAudio` is called with the bytes for item 1, 2, 3 strictly in order, each only after the previous `done` resolves.
2. **Speaking changes:** `onSpeakingChange` is called exactly `[true]` when the first item starts, and `[true, false]` after the last finishes. Two separate bursts give `[true, false, true, false]`.
3. **503 is sticky:**
   - Item 1's fetch rejects with `TtsUnavailableError`. Item 1 is spoken via `speakFallback`, and `mode()` becomes `"fallback"`.
   - Item 2 (already fetching) has its signal aborted and is spoken via `speakFallback`.
   - A later `enqueue` doesn't call `fetchAudio`.
4. **One failure isn't sticky:** item 1's fetch rejects with a plain `Error`. Item 1 uses the fallback, item 2 plays via `playAudio`, and `mode()` is still `"provider"`.
5. **Two consecutive failures** (a fetch error, then a `playAudio` `done` rejection) make `mode()` `"fallback"`.
6. **A success in between resets the counter:** fail, success, fail leaves `"provider"`.
7. **`stop()` while item 1 plays and items 2–3 are fetching:**
   - the current playback's `stop` is called
   - both pending signals are aborted
   - `onSpeakingChange(false)` is called once
   - nothing else plays, even when the old promises resolve afterwards
   - aborted fetches don't count as failures (`mode()` stays `"provider"`)
8. **Edge cases:** `stop()` when idle makes no callback. `enqueue("   ")` does nothing.

### `tests/voice-controller.test.ts` (fake `connect`, fake `startMic`, fake TTS deps; no real sockets)
1. **Happy path:** `enable()` → `starting` (`startMic` called synchronously inside `enable`) → mic resolves `{ sampleRate: 48000 }` → `connect` resolves → `listening`. `onChange` saw the snapshots in that order.
2. **Audio:** after `listening`, pushing 4800 samples of `0.5` through the mic callback calls `sendAudio` once, with 3200 bytes all `0x00 0x40` pairs. Samples pushed before `listening` are never sent.
3. **Mic failure:** `startMic` rejects → `unavailable` with `VOICE_MESSAGES.mic`, and `connect` is never called. Also: a mic with `sampleRate: 8000` → `unavailable` with `VOICE_MESSAGES.mic`, and that mic's `stop` is called.
4. **Relay failure:** `connect` rejects with `RelayConnectError("busy", 1013)` → `unavailable` with `VOICE_MESSAGES.busy`, and the mic is stopped. With kind `"unavailable"`, the message is `VOICE_MESSAGES.relay`.
5. **Partials and turns:** `onPartial("I think")` sets `snapshot.partial`. `onTurnComplete("t1", "  I think it is two ")` calls `onTurn("I think it is two")` and sets `partial` to `null`. An empty or whitespace turn doesn't call `onTurn`.
6. **Barge-in:** while the TTS is speaking (playback in progress), `onPartial("wait")` (1 word) doesn't stop it. `onPartial("wait no")` (2 words) stops the playback, and later `token`/`done` actions enqueue nothing until the next `request` action.
7. **Reconnect:**
   - An unexpected close (`intentional: false`) gives `reconnecting`, then `connect` is called again and gives `listening`. The mic's `stop` is **not** called.
   - If the second `connect` rejects: `unavailable` with `VOICE_MESSAGES.dropped`, and the mic is stopped.
   - An intentional close doesn't reconnect.
8. **`disable()`:** → `off`. `connection.end()` is called, the mic is stopped, the playback is stopped, and later `token` actions don't enqueue.
9. **Generation guard:** `enable()` then `disable()` **before** `startMic` resolves; when the mic resolves, its `stop` is called immediately and `connect` is never called. The same with `connect` resolving after `disable()`: that connection's `close()` is called.
10. **Speech from actions:**
    - `request`, then `token` actions `"Good. Now"`, `" tell me"`, `" why."`, then `done` → `fetchAudio` was called with `"Good."`, then `"Now tell me why."`.
    - While `off`, the same actions call nothing.
    - `speakNow("First. Second")` → `"First."`, then `"Second"`.
11. **`queueVoiceTurn`:** `(null, " a ")` → `"a"`; `("a", "b ")` → `"a b"`.

### `tests/tts-route.test.ts` (`createTtsHandler` with injected env and a fake `fetch`)
- **503:**
  - no key, and also an empty key → the exact 503 body, with `no-store`
  - `console.warn` is called once across two requests to the same handler instance
  - the fake `fetch` is never called
- **400:** invalid JSON, `{}`, `{ text: 5 }`, `{ text: "   " }` and `{ text: "a".repeat(1001) }` each give the exact 400 body. `"a".repeat(1000)` is accepted.
- **200** with `OPENAI_API_KEY: "sk-test"`:
  - the fake `fetch` returns `new Response(new Uint8Array([1, 2, 3]))`
  - the response bytes are `[1, 2, 3]`, with `Content-Type: audio/mpeg` and `no-store`
  - the upstream call used exactly `TTS_URL`, `method: "POST"`, `Authorization: "Bearer sk-test"`, `Content-Type: application/json`, an `AbortSignal`, and the body `{ model: "gpt-4o-mini-tts", voice: "alloy", input: "Hello there.", response_format: "mp3" }` for the request text `"  Hello there.  "`
- **502:** for upstream status 500, and for `fetch` throwing → the exact 502 body, with `no-store`. The `tts_error` log line has `status` (500 or 0) and `chars`.
- **No secrets in logs:** across every test, no `console.*` output contains `sk-test` or the request text.

### `tests/interview-model.test.ts` (add)
- `buildTurnRequest(view, " hi ", "voice")` gives `event: { type: "turn_complete", text: "hi", source: "voice" }`.
- `buildTurnRequest(view, "hi")` still gives `source: "typed"`.

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings) and `npm run build` (with **no** keys set) pass. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.**
2. `/api/tts` appears in the build. The client bundle contains **no `ws` package code** and no server modules.
3. `interview-model.ts` and `use-interview.ts` differ from their frozen versions **only** by the edits listed above. Every other frozen file is byte-identical.
4. **No test connects anywhere except `127.0.0.1`/`localhost`.** Nothing calls `api.openai.com` or `api.meta.ai`.
5. **Every rule has a test that fails if it's changed.** The reviewer will revert rules one at a time across `pcm-encoder.ts`, `sentence-chunker.ts`, `relay-client.ts`, `tts-player.ts`, `voice-controller.ts` and `tts-handler.ts`.
6. No test name is removed. All the test vectors above are used exactly as given; **never change an expected value to make a test pass.** If one fails, recheck your implementation against the algorithm text, and if it still disagrees, write it in `STAGE7_NOTES.md`.
7. With no keys and no relay (`next dev`):
   - the interview still works by typing
   - "Start voice" shows `Voice input is unavailable right now. You can keep typing your answers.` (the relay token returns 503)
   - interviewer speech falls back to `speechSynthesis` (the TTS returns 503)

## Held (not part of this stage)
- **Live TTS quality and latency** with `OPENAI_API_KEY`.
- **Live speech recognition** through the relay to Meta (`MODEL_API_KEY`), plus a manual browser voice check (Chrome, Safari, Firefox; echo and barge-in, with and without headphones).
- **Deploying** the relay and the app.
- **Abuse protection** for `/api/tts` (rate limits): Stage 11.
