# Stage 3 brief: Assessor + speaker + real `/api/step` (handoff to the external model)

## Goal
Replace the stub `/api/step` with the real tutor loop: **assess** the student's input (a structured Muse Spark call) → **decide** the move (the pure FSM from Stage 2) → **speak** the interviewer's line (a streamed Muse Spark call), streamed to the client over the existing SSE protocol. Every model failure has a deterministic fallback, so the interview never stalls.

**No API keys are available.** Running against the live Meta API is on hold. Every test must use injected fakes or a fake OpenAI client, as in the existing tests. Don't add scripts that call the live API.

---

## What already exists (from Stages 1–2): read this first

You're starting in a fresh session, so here is everything this stage depends on. **`plan.md` is historical:** its Stage 1 brief predates later changes. For example, `wordsSinceInterject` was renamed `turnWordBaseline`, and `probesAsked` was added. Wherever `plan.md` differs from this brief or the code, this brief and the code win. Read these files before writing code:
- `src/contracts/engine.ts`
- `src/contracts/step-protocol.ts`
- `src/lib/meta.ts`
- `src/engine/fsm.ts`
- `src/engine/types.ts`
- `src/engine/state.ts`
- `src/config/load.ts`
- `src/app/api/step/route.ts`
- `configs/maths-oxbridge.json`

**Stack:**
- Next.js 16.4 (App Router, `src/`), TypeScript strict, zod v4 (`import { z } from "zod"`), `openai` v5 SDK (pointed at Meta's OpenAI-compatible API), vitest.
- Scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- `next.config.ts` has `cacheComponents: true`, which **rejects `export const runtime`** in route files. Route handlers run on Node by default.
- **Route files may only export Next route names** (`POST`, `GET`, …). Put any other export elsewhere.

**Contracts** (`@/contracts`, `src/contracts/`):
- **`EngineState`:**
  ```
  { version: 1, configId, styleId, startedAt (epoch ms), phase: "intro"|"problem"|"wrap_up"|"done",
    problemIdx, hintRung (-1 = none), checkpointsHit: string[], lastInterjectAt: number|null,
    turnWordBaseline, probesAsked, transcript: TranscriptEntry[] (max 500) }
  ```
- **`TranscriptEntry`:** `{ id, at (ms since session start), speaker: "interviewer"|"student", kind: "utterance"|"interjection"|"typed", text }`
- **`EngineEvent`:** `start{configId, styleId}` | `turn_complete{text, source: "voice"|"typed"}` | `partial{text}` (the cumulative words of the current turn) | `canvas{image: "data:image/png;base64,…"}` | `silence{ms}` | `end`
- **`Move`:** `intro` | `hint{rung}` | `realign{misconceptionId|null}` | `probe{probeIdx}` | `acknowledge` | `advance{toProblemIdx}` | `wrap_up` | `silent`
- **`Assessment`:** `{ status: "stuck"|"progressing"|"partial"|"correct"|"off_track", confidence 0..1, checkpointsHit: string[], misconceptionId: string|null, evidence: string }`
- **`StepRequestSchema`:** `{ state: EngineState|null, event }`, with `state` null **exactly when** `event.type === "start"`.
- **`StepStreamEvent`:** `move{move, interrupt}` | `token{text}` | `done{state, utterance}` | `error{code: "bad_request"|"model_timeout"|"model_error"|"internal", message, retryable}`
- `encodeSSE(e)` and `parseSSE(body)` are in `step-protocol.ts`.
- **Stream invariant:** one `move`, then 0..n `token`, then one `done` **or** one `error`. A `silent` move has no tokens. **Concatenating every token's text must exactly equal `done.utterance`.**

**Meta client** (`src/lib/meta.ts`, `import "server-only"`):
- `chatJSON<T>({ schema, schemaName, messages, timeoutMs = 8000, model?, signal?, client? })` returns `{ data, latencyMs, usage? }`.
  - It sends `response_format` json_schema and validates the result with zod.
  - It retries **once** after 400 ms on retryable errors.
- `chatStream({ messages, model?, firstTokenTimeoutMs = 5000, totalTimeoutMs = 15000, signal?, client? })` is an `AsyncGenerator<string>` that yields non-empty deltas.
- Both throw `MetaError { code: "timeout"|"rate_limited"|"upstream"|"invalid_output"|"config", retryable, status? }`.
- If the caller's `signal` aborts, the raw error is rethrown (`chatJSON`) or the stream returns silently (`chatStream`).
- Both log exactly one `model_call` line per attempt.
- `client` lets tests inject a fake `OpenAI`.
- Messages use the OpenAI `ChatCompletionMessageParam` type. Image input is `{ type: "image_url", image_url: { url: dataUri } }`; that format isn't yet verified against Meta (the latency run is held).

**Config** (`src/config/load.ts`, isomorphic):
- `getConfig(id)` returns an `InterviewConfig`; `getStyle(config, styleId)` returns a `Style`.
- Both throw `ConfigError { code: "unknown_config"|"unknown_style" }`.
- `listConfigs()` returns summaries.
- **`InterviewConfig`:** `{ id, title, subject, styles: Style[], problems: Problem[], rubric, timing: { maxMinutes, silenceStuckMs }, fallbackPrompt, asrKeywords }`
- **`Style`:** `{ id, label, persona, tone, interjection: { minConfidence, cooldownMs, minNewWords } }`
- **`Problem`:** `{ id, title, statement, canvasHint?, checkpoints: {id, description}[], hintLadder: string[], probes: string[], misconceptions: {id, signal, realign}[], solutionSketch }`

**Engine** (`src/engine/`):
- `decide({ state, event, assessment, config, style, now })` returns `{ state, move, interrupt, reason }`.
  - It is pure and throws `EngineError("bad_state")` on a configId/styleId mismatch or an out-of-range `problemIdx`.
  - `event` is a `DecideEvent` (any event except `start`).
  - `reason` is a `DecisionReason`, one of: `phase_inactive`, `end`, `closing`, `gated`, `interject_off_track`, `silence_short`, `silence_stuck`, `time_up`, `assessor_unavailable`, `solved_probe`, `solved_advance`, `solved_wrap_up`, `hints_exhausted_advance`, `hints_exhausted_wrap_up`, `off_track`, `stuck`, `progress`.
  - `interrupt` is true only for mid-answer interjections (partial/canvas).
  - It doesn't touch `transcript`.
- `shouldAssess(state, event, config, style, now)` is a pure function that returns `false` when assessing would be pointless (gated partials or canvas, silence, end, inactive phase, time up).
- `createInitialState(configId, styleId, now)` returns `phase "intro"` with everything empty or zeroed.
- `appendTranscript(state, entryWithoutId)` is immutable, assigns a UUID and caps the transcript at 500 entries.
- `countWords(text)`.

**Current stub route** (`src/app/api/step/route.ts`):
- Validates the body with `StepRequestSchema`; an invalid body gets HTTP 400 JSON `{error:{code:"bad_request", message}}`.
- Streams canned replies with header `X-Interim-Stub: 1`.
- Its stream plumbing should be **kept**:
  - a `closed` flag hoisted above the `ReadableStream`
  - `cancel()` sets `closed`
  - `enqueue` wrapped in try/catch
  - `request.signal` abort → close
  - `finally` close
- `tests/step-route.test.ts` tests the stub and will be rewritten.

**Testing conventions:**
- `vitest.config.ts` aliases `@` → `src` and `server-only` → `tests/__mocks__/server-only.ts`.
- Mock env with `vi.mock("../src/lib/env", () => ({ getServerEnv: vi.fn(() => ({ MODEL_API_KEY: "test-key", META_MODEL: "muse-spark-1.3" })) }))`.
- Fake OpenAI clients are plain objects cast `as unknown as OpenAI`, with `chat.completions.create` mocked (see `tests/meta.test.ts`).

## Constraints
- **Allowed files:**
  - new: `src/engine/prompts.ts`, `src/server/assess.ts`, `src/server/speak.ts`, `src/server/step-handler.ts`
  - modified: `src/app/api/step/route.ts`, `src/lib/meta.ts` (only the two options below), `src/contracts/step-protocol.ts` (only the JSDoc invariant line below), `src/engine/types.ts` (only the `SpeakReason` type below)
  - `tests/`
  - `STAGE3_NOTES.md`
- **Don't touch** `src/engine/fsm.ts` (it is frozen, SHA-256 `8e4d2880…0426`), `configs/`, `package*.json`, `.bridge/` or anything else. No new dependencies. No permission/ACL tooling, and no tool output written into the repo.
- `src/engine/prompts.ts` must be **pure**: no I/O, `Date`, `Math.random` or env access. It may import only from `@/contracts` and `src/engine/`.
- Everything in `src/server/` starts with `import "server-only"`.
- If anything is ambiguous, write the question in `STAGE3_NOTES.md` rather than guessing.

---

## Files to create or change

### 1. `src/lib/meta.ts`: two small options (no other changes)
- **`chatJSON`:** add `retry?: boolean` (default `true`). When `false`, a retryable `MetaError` is thrown after the first attempt, with no 400 ms wait and no second call.
- **`chatStream`:** add `maxTokens?: number`. When set, pass it as `max_tokens` in the request; when unset, don't send `max_tokens` at all.
- **Tests (in `tests/meta.test.ts` or `tests/meta.sdk.test.ts`):**
  - `retry: false` with a retryable failure → `create` called once.
  - The default is still 2 calls.
  - `maxTokens: 60` → the request includes `max_tokens: 60`.
  - Unset → the request has no `max_tokens` key.

### 2. `src/contracts/step-protocol.ts`: JSDoc only
Extend the invariant comment on `StepStreamEventSchema` with one line: *An `error` event may also be the first and only event, if the step fails before a move is decided.* No schema change.

### 3. `src/engine/types.ts`: one addition
```ts
export type SpeakReason = DecisionReason | "intro";
```

### 4. `src/engine/prompts.ts` (pure)
Export these four functions. The prompt text below is the spec, so use it verbatim. `{…}` marks interpolation; lists are rendered one item per line as `- {id}: {text}`.

#### Shared helper: `formatTranscript(entries: TranscriptEntry[], max: number): string`
- Take the last `max` entries, oldest first.
- Render each as `[Interviewer] {text}` or `[Student] {text}`. If `text` is longer than 600 characters, truncate it to 600 and add `…`.
- If there are none, return `(no earlier conversation)`.

#### `buildAssessMessages({ config, state, event }): ChatCompletionMessageParam[]`
- `event` is a `partial`, `turn_complete` or `canvas` event.
- `state` is the state **before** the student's current turn is appended, so the current text isn't duplicated.
- `problem = config.problems[state.problemIdx]`.
- **System message:**
  ```
  You are the silent assessor in a live {config.subject} admissions interview. You never speak to the student. Judge the student's reasoning on the current problem and reply with JSON only.

  Problem: {problem.statement}
  Model solution (for your judgement only): {problem.solutionSketch}

  Checkpoints (use these ids):
  {- id: description, one per line}
  Already achieved: {state.checkpointsHit joined with ", ", or "none"}

  Known misconceptions (use these ids):
  {- id: signal, one per line}

  Status meanings:
  - "stuck": not making progress; says they don't know, stalls, or repeats themselves.
  - "progressing": sound reasoning heading towards the next checkpoint, not there yet.
  - "partial": some correct ideas, but incomplete or imprecise.
  - "correct": the step they are on is right.
  - "off_track": an approach that will not work, a reasoning error, or one of the known misconceptions.

  Rules:
  - checkpointsHit: only ids the student has clearly demonstrated, in this answer or earlier. Never guess.
  - misconceptionId: a known misconception id only if it clearly matches, otherwise null.
  - confidence: 0 to 1. Use 0.8 or more only when the evidence is unambiguous.
  - evidence: one short sentence quoting or paraphrasing what supports your judgement.
  ```
- **User message.** The content is a string, except for canvas, where it is an array of a text part plus an `image_url` part with `event.image`.
  ```
  Conversation so far (oldest first):
  {formatTranscript(state.transcript, 12)}

  {event line}
  ```
  The event line is one of:
  - **partial:** `The student is still speaking. Their words so far: "{event.text}". Judge only what they have said; an unfinished sentence is not an error.`
  - **turn_complete:** `The student has just finished speaking: "{event.text}"`
  - **canvas:** `The attached image is the student's whiteboard working. Judge it together with what they have said.`

#### `buildSpeakMessages({ config, style, state, move, interrupt, reason, studentText }): ChatCompletionMessageParam[]`
- `state` is the state **after** `decide` (or the initial state for intro).
- `move` is any non-`silent` move. `reason` is a `SpeakReason`. `studentText` is `string | null`.
- **The speaker must never see `problem.solutionSketch`.**
- **System message:**
  ```
  You are the interviewer in a live {config.subject} admissions interview, speaking out loud to a student. Your words are turned into speech.
  Persona: {style.persona}
  Tone: {style.tone}

  Rules:
  - Say only the words you speak aloud: no stage directions, markdown, lists, emoji or LaTeX. Phrase maths so it reads naturally aloud.
  - Never give away the solution, and never say whether later steps are right before the student reaches them.
  - {length rule}
  - Follow the guidance below. Rephrase it naturally in your persona but keep its meaning, and do not add extra hints.
  ```
  The length rule depends on `interrupt`:
  - `interrupt` true: `You are interrupting the student mid-answer. Say one sentence of at most 25 words, opening with a brief natural interjection such as "Sorry to jump in".`
  - Otherwise: `Keep it to at most three sentences, plus the problem statement if the guidance asks you to read one.`
- **User message:**
  ```
  Guidance for what to say now:
  {grounding}

  {if studentText !== null: What the student just said: "{studentText}"\n\n}Recent conversation (oldest first):
  {formatTranscript(state.transcript, 6)}
  ```
- **Grounding** (exact text). Let `problem = config.problems[state.problemIdx]` unless stated otherwise.

| move / reason | grounding |
|---|---|
| `intro` | `Greet the student, introduce yourself in one short sentence, then present the first problem. Read the problem statement exactly as written: "{config.problems[0].statement}"` |
| `hint{rung}` | `The student needs a hint. Give this hint: "{problem.hintLadder[rung]}"` |
| `realign{id}` where id is a known misconception | `The student's reasoning is going wrong. Steer them back with this: "{misconception.realign}"` |
| `realign{null}` | `The student's reasoning seems to be going wrong. Without saying what the error is, ask them to double-check their current step.` |
| `probe{probeIdx}` | `The student has solved the problem. Acknowledge that briefly, then ask this follow-up question: "{problem.probes[probeIdx]}"` |
| `acknowledge`, reason `assessor_unavailable` | `Say this: "{config.fallbackPrompt}"` |
| `acknowledge`, reason `closing` | `The interview is over. Thank the student briefly for their final remarks.` |
| `acknowledge`, any other reason | `The student is making progress. Briefly encourage them to keep going, or ask them to explain their last step in more detail. Do not give new information.` |
| `advance{toProblemIdx}`, reason `solved_advance` | `The student has finished this problem. Say well done briefly, then present the next problem. Read the statement exactly as written: "{config.problems[toProblemIdx].statement}"` |
| `advance{toProblemIdx}`, any other reason | `The student hasn't been able to finish this problem. Without revealing the answer, kindly say you'll move on, then present the next problem. Read the statement exactly as written: "{config.problems[toProblemIdx].statement}"` |
| `wrap_up`, reason `time_up` | `Time is up. Thank the student, and tell them the interview is over and their feedback is being prepared.` |
| `wrap_up`, any other reason | `The interview is over. Thank the student and tell them their feedback is being prepared.` |

#### `fallbackUtterance({ config, state, move, reason }): string`
This is the deterministic line spoken when the speaker model fails. It uses the same `state`/`move` meaning as above. Exact strings:

| move / reason | text |
|---|---|
| `intro` | `Hello, I'm your interviewer today. Here's the first problem. {config.problems[0].statement}` |
| `hint{rung}` | `{problem.hintLadder[rung]}` |
| `realign{id}` (known) | `{misconception.realign}` |
| `realign{null}` | `{config.fallbackPrompt}` |
| `probe{probeIdx}` | `Well done. {problem.probes[probeIdx]}` |
| `acknowledge` / `assessor_unavailable` | `{config.fallbackPrompt}` |
| `acknowledge` / `closing` | `Thank you.` |
| `acknowledge` / other | `Good. Keep going and talk me through your next step.` |
| `advance` / `solved_advance` | `Well done. Let's move on to the next problem. {statement of toProblemIdx}` |
| `advance` / other | `Let's move on to the next problem. {statement of toProblemIdx}` |
| `wrap_up` / `time_up` | `We're out of time. Thank you, that's the end of the interview. Your feedback is being prepared.` |
| `wrap_up` / other | `Thank you, that's the end of the interview. Your feedback is being prepared.` |

### 5. `src/server/assess.ts`
```ts
export const ASSESS_TIMEOUT_TURN_MS = 8000;
export const ASSESS_TIMEOUT_LIVE_MS = 3500;   // partial and canvas
export interface AssessArgs {
  config: InterviewConfig; style: Style;
  state: EngineState;                          // before the student's turn is appended
  event: Extract<DecideEvent, { type: "partial" | "turn_complete" | "canvas" }>;
  signal?: AbortSignal; client?: OpenAI;
}
export async function assess(args: AssessArgs): Promise<Assessment | null>
```
- Calls `chatJSON({ schema: AssessmentSchema, schemaName: "Assessment", messages: buildAssessMessages(...), signal, client, timeoutMs, retry })`.
  - `turn_complete`: `ASSESS_TIMEOUT_TURN_MS` with `retry: true`.
  - `partial`/`canvas`: `ASSESS_TIMEOUT_LIVE_MS` with `retry: false`, because a late mid-answer judgement is worthless.
- Any `MetaError` → return `null`. The FSM already handles `null`.
- Any other error (including a caller abort) is rethrown.

### 6. `src/server/speak.ts`
```ts
export const SPEAK_MAX_TOKENS = 200;
export const SPEAK_MAX_TOKENS_INTERRUPT = 60;
export interface SpeakArgs {
  config: InterviewConfig; style: Style; state: EngineState;
  move: Exclude<Move, { type: "silent" }>; interrupt: boolean; reason: SpeakReason;
  studentText: string | null; signal?: AbortSignal; client?: OpenAI;
}
export async function* speak(args: SpeakArgs): AsyncGenerator<string>
```
- Streams `chatStream({ messages: buildSpeakMessages(...), maxTokens, firstTokenTimeoutMs: 4000, totalTimeoutMs: 12000, signal, client })`, yielding each delta. `maxTokens` is `SPEAK_MAX_TOKENS_INTERRUPT` when `interrupt`, otherwise `SPEAK_MAX_TOKENS`.
- **Failures:**
  - A `MetaError` **before any delta was yielded** → yield `fallbackUtterance(...)` once, as a single chunk, and return.
  - A `MetaError` **after** at least one delta → return (stop). The utterance is whatever was streamed.
  - If `signal?.aborted` → return silently.
  - Other errors are rethrown.

### 7. `src/server/step-handler.ts`
```ts
export interface StepDeps {
  assess: (args: AssessArgs) => Promise<Assessment | null>;
  speak: (args: SpeakArgs) => AsyncIterable<string>;
  now: () => number;
}
export const MAX_BODY_BYTES = 2_000_000;
export function createStepHandler(deps: StepDeps): (request: Request) => Promise<Response>;
export async function* runStep(
  input: { state: EngineState | null; event: EngineEvent; config: InterviewConfig; style: Style },
  deps: StepDeps, signal: AbortSignal
): AsyncGenerator<StepStreamEvent>;
```

**`createStepHandler(deps)`** returns the handler, which does the following in order:
1. If the `content-length` header is greater than `MAX_BODY_BYTES` → HTTP **413** JSON `{error:{code:"payload_too_large", message}}`.
2. Parse the JSON. Invalid JSON, or a body failing `StepRequestSchema` → HTTP 400 JSON `{error:{code:"bad_request", message}}`. This is unchanged from the stub.
3. Resolve the config and style:
   - `start` uses `event.configId`/`event.styleId`; otherwise use `state.configId`/`state.styleId`.
   - A `ConfigError` → 400 `bad_request`.
   - For non-start events, `state.problemIdx >= config.problems.length` → 400 `bad_request`.
4. Return a `200` response with `Content-Type: text/event-stream` and `Cache-Control: no-cache, no-transform` (**no** `X-Interim-Stub`). It streams `runStep(...)` through `encodeSSE`, using the stub's existing robust stream plumbing, with `request.signal` as the abort signal.
5. If `runStep` throws:
   - before any event was sent → send `error{code:"internal", message:"Step failed", retryable:true}`
   - after a `move` but before `done` → send the same `error`
   - then close
   - **Never** put the raw error text in the message sent to the client. Log it server-side with `console.error`.

**`runStep`** always uses `deps.now()` (call it once per step) and never `Date.now()`.
- **`start`:**
  1. `state = createInitialState(config.id, style.id, now)`.
  2. Yield `move{intro, interrupt:false}`.
  3. Stream `deps.speak({ move: intro, reason: "intro", studentText: null, interrupt: false, state, … })`, yielding each chunk as a `token`.
  4. Append an interviewer entry: `kind "utterance"`, `at 0`, text = the joined chunks.
  5. Set `phase: "problem"` and yield `done`.
- **Any other event:**
  1. `pre = state`.
  2. If the event is `turn_complete`, append a student entry: `kind` is `"typed"` if `source === "typed"`, else `"utterance"`; `at = now − startedAt`. Partials, canvas, silence and end are **not** appended.
  3. `assessment` = `shouldAssess(pre, event, config, style, now)` ? `await deps.assess({ state: pre, event, … })` : `null`.
  4. `result = decide({ state: stateWithStudentEntry, event, assessment, config, style, now })`.
  5. Yield `move{result.move, result.interrupt}`.
  6. If the move is `silent` → yield `done{state: result.state, utterance: ""}`.
  7. Otherwise:
     - stream `deps.speak({ state: result.state, move, interrupt: result.interrupt, reason: result.reason, studentText, … })`, yielding each chunk as a `token`. `studentText` is the event's `text` for `turn_complete`/`partial`, otherwise `null`.
     - Append an interviewer entry: `kind` is `"interjection"` if `result.interrupt`, else `"utterance"`; `at = now − startedAt`; text = the joined chunks.
     - Yield `done`.
- **Empty utterance:** if the speaker yields nothing for a non-silent move (for example it returned after an abort), still yield `done` with utterance `""` and don't append an empty transcript entry.
- **Abort:** if `signal.aborted` at any point, stop yielding immediately (return). Don't throw.

### 8. `src/app/api/step/route.ts`
Replace the stub completely with:
```ts
import { createStepHandler } from "@/server/step-handler";
import { assess } from "@/server/assess";
import { speak } from "@/server/speak";
export const POST = createStepHandler({ assess, speak, now: () => Date.now() });
```
Add nothing else; the file must export only `POST`.

---

## Tests (`vitest`, in `tests/`; no network, no API key)

### `tests/prompts.test.ts`
Use the real `maths-oxbridge` config via `getConfig`.

**`buildAssessMessages`:**
- The system message contains:
  - the problem statement and solution sketch
  - every checkpoint `id: description` line
  - every misconception `id: signal` line
  - `Already achieved: none`, or the joined ids when some are hit
- The user message:
  - has the right event line for partial and for turn_complete
  - for canvas, has an array with an `image_url` part whose url is the event's data URI
  - uses `formatTranscript`: only the last 12 entries, `(no earlier conversation)` when empty, and 600-character truncation with `…`

**`buildSpeakMessages`:**
- For each row of the grounding table, the user message contains the exact grounding with the correct config string interpolated, including `advance` using `toProblemIdx`'s statement.
- The interrupt length rule appears only when `interrupt` is true.
- `studentText` appears only when non-null.
- **No speak message for any move ever contains `solutionSketch` text.** Assert this for every move type.

**`fallbackUtterance`:** every row of the table, as exact strings.

**Purity:** deep-freeze the inputs; nothing throws, and the inputs are unchanged.

### `tests/assess.test.ts`
Uses a fake client. Mock env as in `meta.test.ts`.
- A valid JSON response → returns the parsed `Assessment`.
- An invalid response, a timeout, or a 429 → returns `null`.
- `partial` and `canvas` → `create` is called **once** on a retryable failure (`retry: false`), with the abort timeout set to 3500 ms. Test the timeout with a fake client that never resolves, plus fake timers or a short real wait.
- `turn_complete` → retried (2 calls).
- A caller abort → rejects (it isn't swallowed).

### `tests/speak.test.ts`
Uses a fake client with an async-generator stream.
- Deltas are yielded in order.
- `max_tokens` is 60 when interrupting and 200 otherwise.
- A failure before the first delta → yields exactly `[fallbackUtterance(...)]`.
- A failure after 2 deltas → yields exactly those 2, then stops.
- An aborted signal → yields nothing more and doesn't throw.

### `tests/step-route.test.ts`: rewrite
- Test `createStepHandler` with **fake deps**:
  - `now` returns fixed values
  - `assess` is a `vi.fn` returning a chosen `Assessment | null`
  - `speak` is a `vi.fn` async generator yielding chosen chunks
- Collect events with `parseSSE`.
- Write a helper `expectValidStream(events)` that checks the invariant: one `move` first, then tokens, then exactly one terminal `done` or `error` last, and tokens joined === `done.utterance`. Apply it to **every** stream in the file.
- **Cases:**
  1. **`start`:** `move{intro}`, chunks joined as the utterance, `phase "problem"`, transcript `[interviewer, at 0]`; `speak` is called with `reason "intro"`; `assess` isn't called.
  2. **`turn_complete` (typed):**
     - the student entry is appended with `kind "typed"` and `at = now − startedAt`
     - `assess` is called with the **pre-append** state
     - the move comes from `decide` (for example `stuck` → `hint{rung:0}`)
     - the interviewer entry is `kind "utterance"`
     - `speak` gets `studentText`
  3. **`turn_complete` (voice):** the student entry has `kind "utterance"`.
  4. **Gated `partial`** (too few words): `assess` isn't called, the move is `silent`, `done.utterance === ""`, `speak` isn't called, and the transcript is unchanged.
  5. **Interjection `partial`:** enough words, `assess` returns `off_track` at 0.9. The move is `realign` with `interrupt: true`, the interviewer entry is `kind "interjection"`, and `speak` gets `interrupt: true`.
  6. **`assess` returns `null` on `turn_complete`:** the move is `acknowledge`, and `speak` gets `reason "assessor_unavailable"`.
  7. **`silence` ≥ threshold:** a `hint`, and `assess` isn't called.
  8. **`end` in the problem phase:** `wrap_up`, with `done.state.phase === "done"`.
  9. **400 cases:** invalid JSON; a schema failure; an unknown configId on start; an unknown styleId on start; an unknown configId in `state`; a `problemIdx` out of range. Also **413** when `content-length` > 2,000,000.
  10. **`speak` throws a plain `Error` after one chunk:** the stream ends with `error{code:"internal", retryable:true}`, the raw message doesn't appear in the client payload, and `console.error` was called.
  11. **`assess` throws a plain `Error` before the move:** the stream is exactly `[error{internal}]`.
  12. **Abort:** abort the request's signal mid-speak. There are no events after the abort, and no unhandled rejection.
  13. **No stub header:** the `X-Interim-Stub` header is absent.

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass. The build must pass **without** `MODEL_API_KEY` set.
2. `src/engine/fsm.ts` and `configs/` are byte-for-byte unchanged.
3. `src/engine/prompts.ts` contains no `Date`, `Math.random`, `process`, `fetch` or `console`, and imports only from `@/contracts` and `src/engine/`.
4. `src/app/api/step/route.ts` exports only `POST` and contains no logic.
5. No response sent to the client ever contains raw exception text.
6. Every rule above has a test that fails if the rule is changed. The reviewer will revert rules one at a time, including each grounding row, each fallback row, each failure path in `assess`/`speak`, the pre-append state passed to `assess`, the transcript kinds, and the 400/413 checks.
7. No files are changed outside the allowed list.

## Held (not part of this stage)
- Running the real loop against Meta: it needs `MODEL_API_KEY`, which is held.
- Verifying that Meta accepts `image_url` data URIs: this happens in the held latency run.
