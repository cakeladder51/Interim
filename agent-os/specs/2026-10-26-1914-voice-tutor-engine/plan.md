# Interim: Voice Tutor Engine + Config (MVP core)

## Context

Interim is a hackathon MVP (submissions due Wed 4 Nov, 9pm ET): an AI interviewer for Oxbridge/Imperial **Maths and CS** interviews. The edge is tutor behaviour. The interviewer reacts *while the student is still answering*: it nudges when they're stuck, realigns them mid-answer when they go off track, probes when they're right, and gives structured feedback afterwards. Interviewers are config (question bank, hint ladder, rubric), so the same engine can run any assessment. The repo has no app code yet.

**Shaping decisions**
- Two-way voice is a must; typing is the fallback ("Speak to respond (default) or type").
- **Mid-answer interruption:** partial transcripts and canvas changes are assessed during the answer; the engine interrupts when it's confident the student is off track (with a cooldown).
- **Infinite canvas** (Excalidraw) beside the transcript; the engine reads canvas snapshots (Muse Spark takes images).
- **Config is locked before the interview starts** (subject + style on the start page); demo swaps happen between interviews.
- **Minimal start page** (Practice card: subject, style, Interview button). No stats or accounts.
- **Recording is opt-in:** a pre-interview dialog with checkboxes (Audio, Video) → Submit → browser permission prompts. Stored on the device only, with downloads at the end. No DB.
- **TTS:** Meta has no TTS model, so use a hosted streaming TTS behind a provider interface. Default is OpenAI `gpt-4o-mini-tts`, with browser `speechSynthesis` as the fallback.
- **ASR:** the Muse Voice Transcribe realtime WS takes the raw key in its first frame, and Vercel can't hold WebSockets, so a **small Node WS relay** (Fly.io) holds the key.
- A scripted-student regression suite is in scope.

**Verified API facts** (dev.meta.ai docs)
- **Muse Spark:** model `muse-spark-1.3`, base URL `https://api.meta.ai/v1`. Chat Completions is OpenAI-SDK compatible, with bearer auth (`MODEL_API_KEY`) and image input. Structured output uses `response_format: {type:"json_schema", json_schema:{name, schema, strict}}`, and the result is a JSON string in `choices[0].message.content`. `strict:false` still constrains the output; `strict:true` additionally needs `additionalProperties:false` and every property listed in `required`. Recursive schemas are rejected, and nesting is limited to 10 levels.
- **ASR realtime:** `wss://api.meta.ai/v1/asr/realtime`.
  - First JSON frame (within 10 s): `{authorization:{accessToken:"Bearer …"}, audioEncoding:"PCM_16KHZ", model:"muse-voice-transcribe-1.0", mode:"ENDPOINTING", partialMode:"CUMULATIVE", keywords?}`.
  - Wait for `{sessionId}`, then send binary PCM16LE mono frames at real-time pace.
  - Events: `speechStart{turnId}`, `transcript{transcript,final}` (each partial replaces the last), `speechEnd`, `speechComplete{turnId,transcript}`, `error`.
  - End with `{"type":"endStream"}`. Sessions are capped at 60 min.

## Working model

- **Claude plans and reviews; an external model writes the code.** Each stage gets a self-contained implementation brief, saved as `agent-os/specs/2026-10-26-1914-voice-tutor-engine/stages/stage-NN-<name>.md`.
- After the external model implements a stage, Claude reviews it thoroughly (diff review, typecheck/lint/tests, contract conformance, security) before the next stage brief is written.
- Stages are short and sequential. Each ends in something runnable and checkable.
- **This plan details Stage 1 only.** Later stage briefs are written one at a time, after the previous stage passes review.

---

## Task 1 (Claude, on approval): save spec documentation

Create `agent-os/specs/2026-10-26-1914-voice-tutor-engine/` with:
- **plan.md**: this plan
- **subproblems.md**: the *Stage map*, *Design reference* and *Sub-problems* sections below
- **stages/stage-01-foundation.md**: the *Stage 1 brief* below, verbatim (this is the handoff to the external model)
- **shape.md**: scope, decisions, context (visuals, references, product alignment), standards applied
- **standards.md**: none exist yet (`agent-os/standards/index.yml` is empty). Run `/discover-standards` after Stage 4.
- **references.md**: no internal code yet. External references are the Meta Model API docs (models, speech-to-text, structured-output), the Excalidraw `exportToBlob` docs and OpenAI TTS streaming.
- **visuals/**: copies of `visuals/Layout_files_1.jpg.jpeg` (interview screen) and `visuals/Layout_files_2.jpg.jpeg` (dashboard; only the Practice card is in scope)

---

## Stage map

| Stage | Name | Sub-problems | Ends with |
|---|---|---|---|
| **1** | **Foundation** | SP0, A1 | App scaffold, shared contracts, Meta client, latency probe, stub `/api/step`, deployed URL |
| 2 | Config + FSM | A2, A3 | Maths/CS configs validated; pure FSM fully unit-tested |
| 3 | Assessor + speaker | A4, A5, A8 (step) | Real `/api/step` running on Muse Spark |
| 4 | Text interview UI | B5 (text), minimal B4 | **M1:** text interview end to end, deployed |
| 5 | Regression suite | A7 | 8 scripted students green (mocked) + live eval |
| 6 | ASR relay | B1 | Relay on Fly; WAV test client gets partials |
| 7 | Voice in/out | B2, B3 | **M2:** speak and hear the interviewer, turn by turn |
| 8 | Mid-answer + canvas | B6, I1 | **M3:** realign interjections; canvas read by the engine |
| 9 | Feedback | A6, B7 | Rubric report page |
| 10 | Recording | B4 (consent), B8 | **M4:** opt-in audio/video recording, downloads |
| 11 | Hardening + deploy | I2, I3 | **M5:** failure drills pass; CLAUDE.md written; demo-ready |

**Critical path:** Stage 1 → 3 → 8. The assessor's quality and latency decide whether mid-answer interjection feels good, so Stage 1 measures latency first.

## Design reference (applies across stages)

- **Config** (`src/contracts/config.ts`) is the "any assessment" contract.
  - A config holds problems.
  - Each problem has checkpoints, a hint ladder (gentle → explicit), probes, misconceptions (signal + realign text) and a solution sketch.
  - Each config also has a rubric with leveled criteria, styles (persona, tone, interjection policy `{minConfidence, cooldownMs, minNewWords}`), timing, a fallback prompt and ASR keywords.
  - Files: `configs/maths-oxbridge.json`, `configs/cs-oxbridge.json`, each with 2 styles (`supportive`, `rigorous`).
- **Engine** (`src/engine/`) is pure. Each step runs `assess` (structured Muse Spark call → `Assessment`), then `decide` (FSM → `Move`), then `speak` (streamed utterance grounded in config text).
  - **Partial/canvas triggers:** interrupt only if the assessment is `off_track`, its confidence is ≥ `minConfidence`, the cooldown has elapsed, and there are ≥ `minNewWords` new words. Otherwise the move is `silent`.
  - **`turn_complete`:**
    - stuck → next hint rung
    - off_track → realign
    - correct → probe, then advance once all checkpoints are hit
    - last problem done → wrap_up
  - **Silence:** silence ≥ `silenceStuckMs` counts as stuck.
- **Failure policy:**
  - assess fails on a partial → silent
  - assess fails on `turn_complete` → the config's fallback prompt
  - speak fails → the raw config text
  - feedback fails → retry once, then show the transcript with a retry button
  - mic or relay down → text mode
  - TTS down → speechSynthesis
- **API is stateless.** Engine state round-trips through the client. `POST /api/step` streams SSE; there are also `/api/feedback`, `/api/tts` and `/api/relay-token` (an HMAC token with a 2-min expiry).
- **Client:**
  - mic AudioWorklet → 16 kHz PCM16 → relay
  - partials debounced (≥ `minNewWords` new words or about 3 s, one request in flight)
  - canvas debounced (about 4 s idle, hash dedup)
  - silence timer
  - TTS through Web Audio, with barge-in (student speech stops the interviewer)
- **Recording:** an AudioContext mixes the mic and the TTS output. Audio uses a MediaRecorder (webm/opus). Video uses `getDisplayMedia({preferCurrentTab})` plus the mixed audio. Everything is downloaded on End, and nothing is uploaded.

## Sub-problems

- **SP0 Shared contracts:** config, engine, step SSE protocol and relay protocol types.
- **Track A (engine):**
  - A1 Meta client + latency probe
  - A2 Config content
  - A3 FSM
  - A4 Assessor
  - A5 Speaker
  - A6 Feedback
  - A7 Regression suite
  - A8 API routes
- **Track B (voice/UI):**
  - B1 ASR relay
  - B2 Mic → ASR client
  - B3 TTS + barge-in
  - B4 Start page + consent dialog
  - B5 Interview screen + canvas
  - B6 Turn controller
  - B7 Feedback page
  - B8 Recording
- **Integration:**
  - I1 Wire engine ↔ UI
  - I2 Resilience pass
  - I3 Deploy + CLAUDE.md

---

# Stage 1 brief: Foundation (handoff to the external model)

## Goal
Scaffold the app, freeze the shared contracts every later stage codes against, build the Meta Muse Spark client, measure model latency, and ship a **stub** `/api/step` that speaks the real SSE protocol. No tutor logic, UI, voice or relay yet.

## Constraints
- Node ≥ 20.6, npm, TypeScript `strict: true`. Use the latest stable Next.js (App Router, `src/` dir, Tailwind, ESLint) via `create-next-app` **in the repo root**. Keep the existing `agent-os/`, `visuals/` and `interim-hackathon-brief.md`.
- Dependencies: `zod` (v4, using `z.toJSONSchema`), `openai` (used as the client for Meta's OpenAI-compatible API) and `server-only`. Dev dependencies: `vitest`, `tsx`, `pngjs` + `@types/pngjs`.
- No secrets in client code. Every module that reads env or calls Meta starts with `import "server-only"`.
- Don't implement anything outside this brief. If something is ambiguous, write the question in `STAGE1_NOTES.md` rather than guessing.

## Files to create

### 1. `package.json` scripts
`dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `latency` (`tsx --env-file=.env.local scripts/latency.ts`).

### 2. `.env.example` and `.gitignore`
- `.env.example`:
  ```
  MODEL_API_KEY=
  META_MODEL=muse-spark-1.3
  OPENAI_API_KEY=
  RELAY_URL=
  RELAY_SECRET=
  ```
- Make sure `.gitignore` covers `.env*.local` and `scripts/out/`.

### 3. `src/lib/env.ts` (server-only)
Zod-parse `process.env` lazily (on first call to `getServerEnv()`, not at import time):
- `MODEL_API_KEY`: required, non-empty
- `META_MODEL`: default `"muse-spark-1.3"`
- `OPENAI_API_KEY`, `RELAY_URL`, `RELAY_SECRET`: optional

On failure, throw `Error("Missing/invalid env: <field names>")` without printing any values.

### 4. `src/contracts/config.ts`
Zod schemas plus inferred types (`export type X = z.infer<typeof X>`). Every string field is a non-empty string unless noted.
```ts
InterjectionPolicy = { minConfidence: number 0..1, cooldownMs: int ≥0, minNewWords: int ≥0 }
Style = { id, label, persona, tone, interjection: InterjectionPolicy }
Checkpoint = { id, description }
Misconception = { id, signal, realign }
Problem = { id, title, statement, canvasHint?: string, checkpoints: Checkpoint[] (≥1),
            hintLadder: string[] (≥1), probes: string[] (≥1), misconceptions: Misconception[], solutionSketch }
RubricLevel = { score: int, descriptor }
RubricCriterion = { id, name, levels: RubricLevel[] (≥2) }
Rubric = { criteria: RubricCriterion[] (≥1) }
InterviewConfig = { id, title, subject: string, styles: Style[] (≥1), problems: Problem[] (≥1),
                    rubric: Rubric, timing: { maxMinutes: int >0, silenceStuckMs: int >0 },
                    fallbackPrompt, asrKeywords: string[] (default []) }
```
Add a `.superRefine` on `InterviewConfig` that rejects duplicate ids among styles, problems, checkpoints within a problem, misconceptions within a problem, and rubric criteria.

### 5. `src/contracts/engine.ts`
```ts
Phase = enum "intro" | "problem" | "wrap_up" | "done"
TranscriptEntry = { id: string, at: int ≥0 /* ms since session start */,
                    speaker: "interviewer" | "student",
                    kind: "utterance" | "interjection" | "typed", text: string }
EngineState = { version: literal 1, configId, styleId, startedAt: int /* epoch ms */,
                phase: Phase, problemIdx: int ≥0, hintRung: int ≥-1 /* -1 = none given */,
                checkpointsHit: string[], lastInterjectAt: int | null,
                wordsSinceInterject: int ≥0, transcript: TranscriptEntry[] (max 500) }
EngineEvent = discriminatedUnion("type"):
  { type:"start", configId, styleId }
  { type:"turn_complete", text, source: "voice" | "typed" }
  { type:"partial", text }
  { type:"canvas", image: string — must start with "data:image/png;base64,", max 1_500_000 chars }
  { type:"silence", ms: int >0 }
  { type:"end" }
Move = discriminatedUnion("type"):
  { type:"intro" } | { type:"hint", rung: int ≥0 } | { type:"realign", misconceptionId: string | null }
  | { type:"probe", probeIdx: int ≥0 } | { type:"acknowledge" } | { type:"advance", toProblemIdx: int ≥0 }
  | { type:"wrap_up" } | { type:"silent" }
Assessment = { status: "stuck" | "progressing" | "partial" | "correct" | "off_track",
               confidence: number 0..1, checkpointsHit: string[],
               misconceptionId: string | null, evidence: string }
Report = { summary, criteria: { id, score: int, justification }[],
           strengths: string[], improvements: string[],
           keyMoments: { at: int ≥0, quote, note }[] }
```
`Assessment` and `Report` must convert cleanly with `z.toJSONSchema()` (no transforms, refinements or defaults inside them), because they become `response_format` schemas.

### 6. `src/contracts/step-protocol.ts` (isomorphic: no server-only imports)
- **Request:** `StepRequest = { state: EngineState | null, event: EngineEvent }`, refined so that `state === null` holds exactly when `event.type === "start"`.
- **Stream events** (`StepStreamEvent`, a discriminated union on `event`):
  - `{event:"move", data:{ move: Move, interrupt: boolean }}`
  - `{event:"token", data:{ text: string }}`
  - `{event:"done", data:{ state: EngineState, utterance: string }}`
  - `{event:"error", data:{ code: "bad_request"|"model_timeout"|"model_error"|"internal", message: string, retryable: boolean }}`
- **Ordering:** exactly one `move`, then 0..n `token`, then exactly one `done` **or** one `error`. A `silent` move has no tokens.
- `encodeSSE(e: StepStreamEvent): string` returns `` `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n` ``.
- `async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StepStreamEvent>` must:
  - handle events split across chunk boundaries, multiple events in one chunk, `\r\n` line endings and multi-line `data:`
  - validate each event with zod
  - throw on malformed input

### 7. `src/contracts/relay-protocol.ts` (types only; implemented in Stage 6)
- **Client → relay:**
  - the first text frame is `{type:"auth", token: string}`
  - then binary PCM16LE 16 kHz mono frames
  - `{type:"end"}` to finish
- **Relay → client:**
  - `{type:"ready"}`
  - `{type:"partial", text}`
  - `{type:"turn_start", turnId}`
  - `{type:"turn_complete", turnId, text}`
  - `{type:"error", message, fatal: boolean}`

Export zod schemas `RelayClientMessage` and `RelayServerMessage`.

### 8. `src/contracts/index.ts`
Re-export everything above.

### 9. `src/lib/meta.ts` (server-only)
- `class MetaError extends Error { code: "timeout"|"rate_limited"|"upstream"|"invalid_output"|"config"; retryable: boolean; status?: number }`
- `getMetaClient(): OpenAI`. A lazy singleton: `new OpenAI({ apiKey: env.MODEL_API_KEY, baseURL: "https://api.meta.ai/v1", maxRetries: 0 })`.
- `chatJSON<T>(opts: { schema: z.ZodType<T>; schemaName: string; messages: ChatCompletionMessageParam[]; timeoutMs?: number /*8000*/; model?: string; signal?: AbortSignal; client?: OpenAI }): Promise<{ data: T; latencyMs: number; usage?: { promptTokens: number; completionTokens: number } }>`
  - **Request:** set `response_format: { type:"json_schema", json_schema: { name: schemaName, schema: z.toJSONSchema(schema), strict: false } }` and `temperature: 0.2`.
  - **Parsing:** `JSON.parse` the content, then `schema.safeParse` it. On any failure, throw `MetaError("invalid_output", retryable: true)`.
  - **Errors and retries:**
    - A timeout (AbortController combined with the caller's `signal`) maps to `timeout`.
    - 429 maps to `rate_limited`.
    - 5xx and network failures map to `upstream`.
    - Any other 4xx maps to `upstream` with `retryable: false`.
    - Retry **once** after 400 ms on retryable errors, but not if the caller's signal aborted.
- `chatStream(opts: { messages; model?; firstTokenTimeoutMs?: number /*5000*/; totalTimeoutMs?: number /*15000*/; signal?; client? }): AsyncGenerator<string>`
  - Yields non-empty content deltas.
  - Throws `MetaError("timeout")` if the first token or the total time is exceeded.
  - No retries once a token has been yielded.
- `logModelCall({ op, model, latencyMs, ok, code? })` writes one `console.info(JSON.stringify({...,"tag":"model_call"}))` line. Called from both functions. Never logs prompts or keys.
- The `client` option exists so tests can inject a fake.

### 10. `src/engine/state.ts`
- `createInitialState(configId: string, styleId: string, now: number): EngineState` returns `phase "intro"`, `problemIdx 0`, `hintRung -1`, empty arrays, `lastInterjectAt null` and `wordsSinceInterject 0`.
- `appendTranscript(state, entry: Omit<TranscriptEntry,"id">): EngineState` is immutable, uses `crypto.randomUUID()` for `id`, and caps the transcript at 500 entries by dropping the oldest.

### 11. `src/app/api/step/route.ts`: STUB (replaced in Stage 3)
- `export const runtime = "nodejs"`.
- `POST`:
  - Parse the JSON body with `StepRequest`. If it's invalid, return HTTP 400 JSON `{error:{code:"bad_request", message}}` (not SSE).
  - Otherwise return `200` with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Interim-Stub: 1`, streaming via `ReadableStream` + `encodeSSE`:
    - `start` → `createInitialState` → move `intro`. Tokens are the words of `"Hello, I'm your interviewer today. Let's begin with the first problem."`, one every 40 ms. Then `done` with the state, the interviewer utterance appended and `phase:"problem"`.
    - `turn_complete` → append the student entry (kind `typed` if `source:"typed"`, else `utterance`) → move `acknowledge`, then canned tokens `"Thanks — talk me through your next step."` → `done`.
    - `partial`, `canvas`, `silence` → move `silent` → `done` with the state unchanged.
    - `end` → move `wrap_up` → `done` with `phase:"done"`.
  - If the client disconnects (`request.signal`), stop the token loop and close the stream.

### 12. `src/app/page.tsx`
Replace the boilerplate with a minimal placeholder: an "Interim" heading and the line "Interview practice: coming soon". No other UI.

### 13. `scripts/latency.ts`
Run with `npm run latency -- --n 5`. Default N is 5. Runs sequentially and prints a table (op, n, ok, p50, p95, min, max in ms). It writes raw results to `scripts/out/latency-<ISO timestamp>.json`.

Operations:
1. **`assess_json`:** `chatJSON` with the `Assessment` schema. The prompt is realistic, about 1–1.5k tokens: a system message describing an Oxbridge maths interviewer assessing a student's partial answer against 3 checkpoints and 2 misconceptions, plus a ~150-word student partial answer. Hard-code a sample problem, such as proving that √2 is irrational.
2. **`speak_stream`:** `chatStream` asking for a one-sentence interviewer nudge. Record first-token ms and total ms separately (`speak_first_token`, `speak_total`).
3. **`assess_with_image`:** same as op 1, but the user message also includes `{ type:"image_url", image_url:{ url: <data URI> } }`. The PNG comes from `scripts/fixtures/canvas-sample.png` if that file exists. Otherwise, generate a 512×512 white PNG with a few black lines using `pngjs`.
   - If this op fails on every run with a 4xx, print `IMAGE INPUT FORMAT REJECTED: <status> <message>` so we know the image format needs changing. Don't crash.

The script exits non-zero only if op 1 fails on every run.

### 14. Tests (`vitest`, in `tests/`)
- **`contracts.test.ts`:**
  - a minimal valid `InterviewConfig` parses
  - duplicate problem ids are rejected
  - `StepRequest` rejects `state:null` with a non-start event, and rejects a start event with a non-null state
  - a canvas event without the PNG data-URI prefix is rejected
  - `z.toJSONSchema(Assessment)` and `z.toJSONSchema(Report)` succeed and contain no `$ref` recursion
- **`sse.test.ts`:**
  - an encode → parse round trip for every event type
  - parsing works when the encoded stream is split at every possible byte offset, and also with multiple events in one chunk
  - malformed JSON throws
- **`meta.test.ts`** (fake client, no network):
  - valid JSON → parsed data
  - non-JSON content → `invalid_output`, retried once, then thrown
  - a timeout on the first attempt and success on the second → resolves
  - a 400 → no retry, `retryable:false`
  - `chatStream` yields deltas and throws `timeout` when the first token is late (use fake timers)
- **`step-route.test.ts`:**
  - call the route's `POST` with a `Request` and collect the events with `parseSSE`
  - the start flow ordering is `move` → `token`+ → `done`, and `done.state.phase === "problem"`
  - a partial gives `move{silent}` → `done` with no tokens
  - an invalid body gives 400 JSON

## Acceptance criteria
1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` all pass with zero errors.
2. `npm run dev`, then
   ```
   curl -N -X POST localhost:3000/api/step -H "content-type: application/json" -d '{"state":null,"event":{"type":"start","configId":"maths-oxbridge","styleId":"supportive"}}'
   ```
   streams a `move` event, word tokens, then `done`.
3. With a real key in `.env.local`, `npm run latency` prints the table and writes the JSON file.
4. `grep -r MODEL_API_KEY .next/static` finds nothing after the build.
5. No files are changed outside: `src/`, `tests/`, `scripts/`, the config files at the root, `package*.json`, `.env.example`, `.gitignore`, `STAGE1_NOTES.md`, `public/`.

## Manual steps for the user (not the external model)
- Get a Meta Model API key and put it in `.env.local`.
- Run `npx vercel link`, set `MODEL_API_KEY` in Vercel project env, run `npx vercel --prod`, and check that the placeholder page and the stub `/api/step` respond on the public URL.

---

## Claude's Stage 1 review checklist (after the external model finishes)
- Run typecheck, lint, test and build myself, and read every new file.
- **Contracts:**
  - every field, enum value and limit matches this brief exactly (later stages depend on them)
  - the `z.toJSONSchema` output of `Assessment`/`Report` is valid for Meta's `json_schema`
- **SSE:**
  - the parser is robust to chunking
  - the stream order invariant holds
  - client disconnect is handled
- **Meta client:**
  - the timeout/abort plumbing doesn't leak timers
  - retry happens exactly once
  - errors map to the right codes
  - no prompt or key logging
- **Security:** `server-only` is on every secret-touching module, and the API key is absent from the client bundle.
- **Latency results:**
  - record p50/p95 in `agent-os/specs/2026-10-26-1914-voice-tutor-engine/latency.md`
  - decide whether voice-first holds; the brief says text becomes the main mode if voice is too slow
  - check whether the image input format worked
- Then write the Stage 2 brief.
