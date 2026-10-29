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

