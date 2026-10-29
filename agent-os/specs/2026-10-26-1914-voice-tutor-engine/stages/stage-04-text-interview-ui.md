# Stage 4 brief: Text interview UI, M1 (handoff to the external model)

## Goal
Give Interim its first usable screens, so a student can run a **complete text interview end to end** in the browser:
- a start page where they pick a subject and interviewer style
- an interview screen with the transcript, a typed-answer box, the current problem, and an End button
- a "complete" state when the interview finishes

This stage also adds an **offline fake model mode**, so the whole flow can be developed, tested and reviewed without an API key.

**Out of scope** (later stages): voice, the canvas or whiteboard, mid-answer interruption and silence detection, the feedback report, recording and its consent dialog, and deployment.

**No API keys are available, and nothing is deployed** (both on hold). All tests use fakes. Don't run anything against the live Meta API, and don't deploy.

---

## What already exists (Stages 1–3): read this first

You're starting in a fresh session. **`plan.md` is historical:** its Stage 1 brief predates later changes (for example, `wordsSinceInterject` became `turnWordBaseline`, and `probesAsked` was added). Wherever `plan.md` differs from this brief or the code, this brief and the code win. `STATUS.md` lists what's done and what's held.

Read these files before writing code:
- `src/contracts/engine.ts`
- `src/contracts/step-protocol.ts`
- `src/config/load.ts`
- `src/engine/prompts.ts` (`fallbackUtterance`)
- `src/server/step-handler.ts`
- `src/app/api/step/route.ts`
- `src/app/layout.tsx`
- `src/app/globals.css`
- `tests/step-route.test.ts`

**Stack:**
- Next.js 16.4 (App Router, `src/`, Turbopack), React 19, TypeScript strict, Tailwind v4 (`@import "tailwindcss"` in `globals.css`), zod v4, vitest (node environment), ESLint (`next/core-web-vitals` + TypeScript).
- Scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- **`next.config.ts` has `cacheComponents: true`.** This means:
  - `export const runtime` (and `dynamic`, `revalidate`, …) are **rejected** in route and page files.
  - **Reading runtime data such as `searchParams` must happen inside a component wrapped in `<Suspense>`**. If you read it at the top of the page, the build fails.
  - In Next 16, `searchParams` is a **Promise**.
  - If the build complains, read `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`.
- Route files may only export Next route names (`POST`, …).

**API: `POST /api/step`** (built in Stage 3, in `src/server/step-handler.ts`):
- **Request:** `StepRequest = { state: EngineState | null, event: EngineEvent }`, with `state` null **exactly when** `event.type === "start"`.
  - `start`: `{ type: "start", configId, styleId }`
  - `turn_complete`: `{ type: "turn_complete", text, source: "typed" | "voice" }`
  - `end`: `{ type: "end" }`
  - (`partial`, `canvas` and `silence` exist but aren't used in this stage.)
- **Responses:**
  - **400** JSON `{ error: { code: "bad_request", message } }`: invalid JSON, invalid body, unknown config or style, or `problemIdx` out of range.
  - **413** JSON `{ error: { code: "payload_too_large", message } }`.
  - **200** `text/event-stream`, `Cache-Control: no-cache, no-transform`.
- **Stream events** (`StepStreamEvent`, parsed with `parseSSE(body)` from `@/contracts`):
  - `move{ move, interrupt }`, then 0..n `token{ text }`, then exactly one `done{ state, utterance }` **or** `error{ code, message, retryable }`.
  - An `error` may also be the **first and only** event.
  - **Concatenating every token's text exactly equals `done.utterance`.**
  - A `silent` move has no tokens.
  - Error codes: `bad_request` | `model_timeout` | `model_error` | `internal`.
- **The server is stateless.** The client keeps the latest `done.state` and sends it back with the next event.
- **`EngineState`** fields:
  - `version`, `configId`, `styleId`, `startedAt` (epoch ms)
  - `phase`: `"intro"` | `"problem"` | `"wrap_up"` | `"done"`
  - `problemIdx`, `hintRung`, `checkpointsHit`, `lastInterjectAt`, `turnWordBaseline`, `probesAsked`
  - `transcript: TranscriptEntry[]`
- **`TranscriptEntry`:** `{ id, at (ms since start), speaker: "interviewer" | "student", kind: "utterance" | "interjection" | "typed", text }`.
- **Flow:**
  - `start` → intro (the interviewer greets the student and reads problem 1) → `phase: "problem"`.
  - Each `turn_complete` → a hint, realign, probe, acknowledge, advance to the next problem, or wrap_up.
  - After wrap_up, `phase` is `"wrap_up"`, and the student may add closing remarks (`turn_complete` → a short acknowledge).
  - `end` → `phase: "done"`. If `end` arrives during the problem phase, the interviewer says a wrap-up line first.
- **`createStepHandler(deps: StepDeps)`**, where `StepDeps = { assess, speak, now }`.
  - `assess(args)` returns `Promise<Assessment | null>`.
  - `speak(args)` returns `AsyncIterable<string>`. `args` include `config`, `style`, `state`, `move`, `interrupt`, `reason`, `studentText` and `signal`.
  - `route.ts` currently does `export const POST = createStepHandler({ assess, speak, now: () => Date.now() })`.
- **`fallbackUtterance({ config, state, move, reason })`** in `src/engine/prompts.ts` is pure, and returns a deterministic interviewer line for any non-silent move.

**Config** (`src/config/load.ts`, isomorphic):
- `listConfigs()` returns `[{ id, title, subject, styles: [{ id, label }] }]`: `maths-oxbridge` ("Oxbridge Maths Interview"), then `cs-oxbridge`, each with styles `supportive` ("Supportive tutor") and `rigorous` ("Rigorous examiner").
- `getConfig(id)` and `getStyle(config, styleId)` both throw `ConfigError`.
- **Full configs contain solution sketches, hints, probes and misconceptions. These must never reach the browser.**

**Testing conventions:**
- vitest aliases `@` → `src` and `server-only` → `tests/__mocks__/server-only.ts`.
- Mock env with `vi.mock("../src/lib/env", …)` where needed, or `vi.stubEnv`.
- There's no DOM test environment and no testing-library. **Don't add dependencies.** Put the logic in plain TypeScript modules and test those. Keep React components thin.

## Constraints
- **Allowed files:**
  - new: `src/app/interview/**`, `src/components/**`, `src/client/**`, `src/config/public.ts`, `src/server/fake-model.ts`, `src/server/deps.ts`, `STAGE4_NOTES.md`
  - modified: `src/app/page.tsx` (replace the placeholder), `src/app/layout.tsx` (metadata only), `src/app/globals.css` (additions only), `src/app/api/step/route.ts` (only the `selectDeps` change below), `src/server/step-handler.ts` (only the `modelLabel` header below), `.env.example` (add one line)
  - `tests/`
- **Frozen; must stay byte-for-byte identical** (the reviewer checks SHA-256):
  - `src/engine/fsm.ts`, `src/engine/prompts.ts`, `src/engine/state.ts`, `src/engine/types.ts`
  - `src/server/assess.ts`, `src/server/speak.ts`, `src/lib/meta.ts`
  - all of `src/contracts/`, `src/config/load.ts`, `configs/`
- No new dependencies. No permission/ACL tooling, and no tool output written into the repo. Don't touch `.bridge/`.
- **`src/client/**` must never import** `src/server/**`, `src/lib/**`, `src/config/load.ts`, `src/config/public.ts` or anything containing `server-only`. It may import from `@/contracts` and `src/client/`.
- If anything is ambiguous, write the question in `STAGE4_NOTES.md` rather than guessing.

---

## Files to create or change

### 1. `src/config/public.ts` (`import "server-only"`)
```ts
export interface PublicConfig {
  id: string; title: string; subject: string;
  styles: { id: string; label: string }[];
  problems: { id: string; title: string; statement: string; canvasHint?: string }[];
  timing: { maxMinutes: number };
}
export function getPublicConfig(id: string): PublicConfig   // throws ConfigError for unknown ids
```
Build it **by picking fields explicitly** from `getConfig(id)`; never spread a full object. Only `canvasHint` is optional: include the key only when the problem has one.

### 2. `src/server/fake-model.ts` (`import "server-only"`): the offline model
- **`FAKE_ASSESS_DELAY_MS = 150`** and **`FAKE_TOKEN_DELAY_MS = 30`**.
- **`fakeAssess(args)`** has the same signature as Stage 3's `assess`.
  - Wait `FAKE_ASSESS_DELAY_MS`. If `args.signal` is or becomes aborted, reject with an `Error` whose `name` is `"AbortError"`.
  - Let `t` = the event's `text` lower-cased (empty for canvas) and `problem = args.config.problems[args.state.problemIdx]`. Return the first match:
    1. `t` matches `/\b(i don'?t know|stuck|no idea)\b/` → `{ status: "stuck", confidence: 0.9, checkpointsHit: [], misconceptionId: null, evidence: "fake: stuck keyword" }`
    2. `t` matches `/\b(solved|done|finished)\b/` → `{ status: "correct", confidence: 0.9, checkpointsHit: <every checkpoint id of problem, in order>, misconceptionId: null, evidence: "fake: solved keyword" }`
    3. `t` matches `/\bwrong\b/` → `{ status: "off_track", confidence: 0.9, checkpointsHit: [], misconceptionId: <id of problem.misconceptions[0], or null if there are none>, evidence: "fake: wrong keyword" }`
    4. Otherwise → `{ status: "progressing", confidence: 0.6, checkpointsHit: [], misconceptionId: null, evidence: "fake: default" }`
- **`fakeSpeak(args)`** has the same signature as Stage 3's `speak` (an async generator).
  - `text = fallbackUtterance({ config, state, move, reason })`.
  - Yield each chunk of `text.match(/\S+\s*/g) ?? []` in order, waiting `FAKE_TOKEN_DELAY_MS` **before** each chunk after the first.
  - If `args.signal?.aborted`, return immediately, without throwing.
  - The chunks joined must equal `text` exactly.

### 3. `src/server/step-handler.ts`: one addition
- Add an optional `modelLabel?: string` to `StepDeps`.
- When it's set, the **200 streaming response** carries the header `X-Interim-Model: <modelLabel>`. When it's unset, don't send the header. JSON error responses never carry it.
- Change nothing else.

### 4. `src/server/deps.ts` (`import "server-only"`)
```ts
export function selectDeps(env: Record<string, string | undefined> = process.env): StepDeps
```
- If `env.INTERIM_FAKE_MODEL === "1"` **and** `env.NODE_ENV !== "production"`: return `{ assess: fakeAssess, speak: fakeSpeak, now: () => Date.now(), modelLabel: "fake" }` and `console.warn` once: `Interim: using the offline fake model (INTERIM_FAKE_MODEL=1).`
- Otherwise: return `{ assess, speak, now: () => Date.now() }`, using the real Stage 3 functions with no `modelLabel`.

### 5. `src/app/api/step/route.ts`
Replace its contents with exactly:
```ts
import { createStepHandler } from "@/server/step-handler";
import { selectDeps } from "@/server/deps";
export const POST = createStepHandler(selectDeps());
```

### 6. `.env.example`
Add a line: `INTERIM_FAKE_MODEL=`.

### 7. `src/client/step-client.ts` (isomorphic: imports only `@/contracts`)
```ts
export class StepHttpError extends Error { constructor(public status: number, public code: string, message: string) }
export class StepStreamError extends Error { constructor(public code: string, public retryable: boolean, message: string) }
export class StepProtocolError extends Error {}
export interface StepCallbacks {
  onMove?: (move: Move, interrupt: boolean) => void;
  onToken?: (text: string) => void;
  onModelLabel?: (label: string) => void;
}
export async function runStepRequest(
  request: StepRequest,
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch; endpoint?: string; callbacks?: StepCallbacks }
): Promise<{ state: EngineState; utterance: string; move: Move; interrupt: boolean }>
```
- **Request:** POST `JSON.stringify(request)` to `opts.endpoint ?? "/api/step"` with `content-type: application/json`. Use `opts.fetchImpl ?? fetch` and pass `signal`.
- **Network errors:** if `fetch` rejects with an `AbortError`, rethrow it unchanged. Any other rejection → `StepHttpError(0, "network", "Network error")`.
- **Non-2xx:** read the JSON body `{ error: { code, message } }` and throw `StepHttpError(status, code, message)`. If the body isn't that shape → `StepHttpError(status, "http_error", "HTTP <status>")`.
- **Model label:** if the `x-interim-model` header is present, call `onModelLabel(value)` before reading the stream.
- **Stream:** read with `parseSSE(response.body)` and enforce the protocol:
  - The first event must be `move` or `error`. A `token` or `done` first → `StepProtocolError`.
  - `token` is only allowed after `move`. `done` is only allowed after `move`.
  - After `done` or `error`, any further event → `StepProtocolError`.
  - `error` → throw `StepStreamError(code, retryable, message)`.
  - If the stream ends without `done` or `error` → `StepProtocolError("Stream ended early")`.
  - If the joined token text `!== done.utterance` → `StepProtocolError`.
  - If `parseSSE` throws (malformed data) → `StepProtocolError`.
- **Callbacks:** call `onMove` and `onToken` as events arrive.
- **Abort:** an `AbortError` during reading propagates unchanged.

### 8. `src/client/interview-model.ts` (pure, isomorphic): view state and reducer
```ts
export const SLOW_FIRST_TOKEN_MS = 6000;
export type InterviewStatus = "starting" | "ready" | "sending" | "ended" | "error";
export interface InterviewView {
  engine: EngineState | null;
  status: InterviewStatus;
  pendingStudentText: string | null;   // optimistic student bubble while a turn is in flight or failed
  streamingText: string;               // interviewer text streamed so far in the current request
  lastMove: Move | null;
  error: { message: string; retryable: boolean } | null;
  lastRequest: { request: StepRequest; studentText: string | null } | null;
  slow: boolean;
  modelLabel: string | null;
}
export type InterviewAction =
  | { type: "request"; request: StepRequest; studentText: string | null }
  | { type: "move"; move: Move }
  | { type: "token"; text: string }
  | { type: "slow" }
  | { type: "done"; state: EngineState }
  | { type: "failed"; message: string; retryable: boolean }
  | { type: "model_label"; label: string };
export const initialView: InterviewView;   // engine null, status "starting", everything else empty/null/false
export function interviewReducer(view: InterviewView, action: InterviewAction): InterviewView;
```
**Reducer rules.** It's pure and returns new objects without mutating its input. Any field a rule doesn't mention is unchanged.
- **`request`:**
  - `status` = `"starting"` if `request.event.type === "start"`, else `"sending"`
  - `pendingStudentText = studentText`, `streamingText = ""`, `lastMove = null`, `error = null`, `slow = false`
  - `lastRequest = { request, studentText }`
- **`move`:** `lastMove = move`.
- **`token`:** `streamingText += text`, and `slow = false`.
- **`slow`:** `slow = true` only if `status` is `"starting"` or `"sending"` **and** `streamingText === ""`; otherwise unchanged.
- **`done`:**
  - `engine = state`, `pendingStudentText = null`, `streamingText = ""`, `slow = false`, `error = null`
  - `status` = `"ended"` if `state.phase === "done"`, else `"ready"`
- **`failed`:**
  - `status = "error"`, `error = { message, retryable }`, `streamingText = ""`, `slow = false`
  - `engine` and `pendingStudentText` are **kept**
- **`model_label`:** `modelLabel = label`.

**Also export these pure helpers:**
- `canSend(view, text): boolean`: true only when `view.status === "ready"`, `view.engine !== null`, `view.engine.phase !== "done"`, and `text.trim() !== ""`.
- **`buildTurnRequest(view, text): StepRequest`**: `{ state: view.engine, event: { type: "turn_complete", text: text.trim(), source: "typed" } }`. It throws if `view.engine` is null.
- `buildEndRequest(view): StepRequest`: `{ state: view.engine, event: { type: "end" } }`. It throws if `view.engine` is null.
- `buildStartRequest(configId, styleId): StepRequest`.
- **`visibleTranscript(view)`** returns `{ speaker: "interviewer" | "student"; text: string; kind: TranscriptEntry["kind"] | "pending" | "streaming"; key: string }[]`, built in this order:
  - `engine.transcript` entries (`key` = entry id)
  - then, if `pendingStudentText !== null`: `{ speaker: "student", text: pendingStudentText, kind: "pending", key: "pending" }`
  - then, if `streamingText !== ""`: `{ speaker: "interviewer", text: streamingText, kind: "streaming", key: "streaming" }`
- **`isThinking(view)`**: `(status === "starting" || status === "sending") && streamingText === ""`.
- **`describeError(err: unknown): { message: string; retryable: boolean }`**, using these exact strings:

| error | message | retryable |
|---|---|---|
| `StepHttpError` status 0 | `Connection lost. Check your internet connection and try again.` | true |
| `StepHttpError` status 400 or 413 | `This interview can't continue because the request was rejected. Please start a new interview.` | false |
| `StepHttpError` any other status | `The server had a problem. Please try again.` | true |
| `StepStreamError` | `The interviewer ran into a problem. Please try again.` | `err.retryable` |
| `StepProtocolError` | `Something went wrong while receiving the reply. Please try again.` | true |
| anything else | `Something unexpected went wrong. Please try again.` | true |

### 9. `src/client/use-interview.ts` (`"use client"`): a thin React hook
```ts
export function useInterview(configId: string, styleId: string): {
  view: InterviewView;
  sendTurn(text: string): void;   // no-op unless canSend
  end(): void;                    // no-op unless engine exists, status is "ready", and phase !== "done"
  retry(): void;                  // re-runs lastRequest; no-op unless status "error" and error.retryable
}
```
- Uses `useReducer(interviewReducer, initialView)`.
- **Starting:** on mount, run `buildStartRequest`. Use an `AbortController` per request, and abort it on unmount. React StrictMode mounts twice in dev; the aborted first request must leave no trace.
- **Each request:**
  1. Dispatch `request`.
  2. Start a `SLOW_FIRST_TOKEN_MS` timer that dispatches `slow`.
  3. Call `runStepRequest`, with callbacks dispatching `move`, `token` and `model_label`.
  4. On success, dispatch `done`. On error, dispatch `failed` with `describeError(err)`, but ignore `AbortError`.
  5. Always clear the timer.
- At most one request is in flight at a time.

### 10. Start page: `src/app/page.tsx` (server component, statically prerendered)
- **Header:** "Interim" with a one-line tagline: `Practise Oxbridge-style interviews with an AI interviewer that adapts to your reasoning.`
- **Practice card:** a plain HTML `<form action="/interview" method="get">`, so no JavaScript is needed.
  - Fieldset **Subject**: radio inputs `name="config"`, one per `listConfigs()` entry, labelled with the config's `subject`. The first is checked by default.
  - Fieldset **Interviewer style**: radio inputs `name="style"` with the style labels (`Supportive tutor`, `Rigorous examiner`), and the first checked. Both configs share these style ids, so take the options from the first config.
  - Submit button labelled **Start interview**.
  - Small print: `Text mode. Voice and whiteboard are coming soon.`
- Don't add stats tiles, accounts or a sidebar; the mockup's dashboard is out of scope.

### 11. Interview page: `src/app/interview/page.tsx` plus components
- **The page is a server component.** Read `searchParams` **inside** an async child component wrapped in `<Suspense fallback={<InterviewSkeleton />}>` (required by `cacheComponents`):
  ```tsx
  export default function InterviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    return <Suspense fallback={<InterviewSkeleton />}><InterviewLoader searchParams={searchParams} /></Suspense>;
  }
  ```
- **`InterviewLoader`** awaits `searchParams` and reads `config` and `style` (string values only).
  - If either is missing, the config is unknown, or the style isn't one of that config's styles: render an error card, **`That interview setup doesn't exist.`**, with a link **Back to start** to `/`. Don't throw.
  - Otherwise, render the client component `<InterviewScreen config={getPublicConfig(id)} styleId={style} />`. **Pass only `PublicConfig`.**
- Page metadata title: `Interview · Interim`.
- **`InterviewScreen`** (`"use client"`, under `src/app/interview/` or `src/components/`) uses `useInterview`. Its layout follows the mockup:
  - **Header bar:** "Interim"; the subject and style label; an elapsed timer `mm:ss / {maxMinutes}:00`, computed client-side from `engine.startedAt` with a 1-second interval and shown once the engine exists; and an **End interview** button.
    - The button needs a two-step confirm: the first click changes its label to **Confirm end**; a second click within 5 s calls `end()`; otherwise it reverts.
    - It's hidden when the status is `ended`.
  - **If `modelLabel === "fake"`**, show a small badge: **Offline demo model**.
  - **Main area:** two columns on wide screens; stacked on narrow screens (below `md`), with the problem panel first.
    - **Transcript panel** (`role="log"`, `aria-live="polite"`):
      - Render `visibleTranscript(view)` as blocks labelled **Interviewer** or **You**.
      - `pending` student text is shown slightly faded. `streaming` interviewer text has a blinking caret. `interjection` entries get a small **Interrupted** tag.
      - While `isThinking(view)`, show **Interviewer is thinking…**. If `view.slow`, also show **Still thinking. This is taking longer than usual.**
      - Auto-scroll to the bottom when content changes.
    - **Problem panel:** **Problem {problemIdx + 1} of {problems.length}: {title}**, with the statement below. Show `canvasHint` if present. Use `engine.problemIdx`, or 0 before the engine exists. Underneath, a muted placeholder: `Whiteboard coming in a later stage.`
  - **Answer bar** (bottom):
    - A `<textarea>` labelled (visually hidden label) **Your answer**, placeholder `Type your answer…`, `maxLength={4000}`.
    - **Enter** sends; **Shift+Enter** inserts a newline.
    - A **Send** button, disabled unless `canSend`. The textarea is cleared on send.
    - During the `wrap_up` phase, show above it: `The interview is wrapping up. Add any final remarks, or press End interview.`
  - **Error state:** a banner with `view.error.message`. If retryable, add a **Try again** button that calls `retry()`. The transcript stays visible.
  - **Ended state:** replace the answer bar with a card: **Interview complete.** `Your feedback report is coming in a later stage.`, with a **Start another interview** link to `/`.
- **Styling:** Tailwind only. Respect the existing light/dark CSS variables in `globals.css`. Use a readable max width, at least 16 px side padding on mobile, and no horizontal scroll at 360 px wide. Keep it clean and simple.

### 12. `src/app/layout.tsx`
Change only the metadata description to `Practise Oxbridge-style interviews with an AI interviewer.`

---

## Tests (`vitest`, node environment; no network, no new dependencies)

### `tests/public-config.test.ts`
- For both configs, `getPublicConfig` returns exactly the documented keys, at the top level and for each problem and style. Check with `Object.keys` and sort.
- `JSON.stringify(result)` contains **no** solution sketch, hint, probe, checkpoint description, misconception signal or realign text from the full config. Loop over every problem's strings.
- `canvasHint` appears only for problems that have one.
- An unknown id throws `ConfigError`.

### `tests/fake-model.test.ts`
- **`fakeAssess`:** each branch, case-insensitively, for example `"I DON'T KNOW"`, `"I dont know"`, `"stuck"`, `"no idea"`, `"solved"`, `"done"`, `"finished"`, `"wrong"`, and default text.
  - Solved returns **all** checkpoint ids of `state.problemIdx` (use `problemIdx: 1`), in order.
  - Wrong returns `problems[problemIdx].misconceptions[0].id`.
  - Branch precedence: `"I don't know if this is wrong"` → stuck.
  - Canvas → default.
  - An already-aborted signal → rejects with `name === "AbortError"`.
  - Use fake timers or real short waits.
- **`fakeSpeak`:** the chunks joined `===` `fallbackUtterance(...)` for at least intro, hint, advance and wrap_up; every chunk except the last ends with whitespace or is followed by none; and an aborted signal yields nothing and doesn't throw.

### `tests/deps.test.ts`
- `selectDeps({ INTERIM_FAKE_MODEL: "1", NODE_ENV: "development" })` → `modelLabel === "fake"` and `assess === fakeAssess`.
- `selectDeps({ INTERIM_FAKE_MODEL: "1", NODE_ENV: "production" })` → the real deps, with no `modelLabel`.
- `selectDeps({})` → the real deps.
- `INTERIM_FAKE_MODEL: "true"` → the real deps (only `"1"` enables it).

### `tests/step-route.test.ts`: add, don't remove
Keep **every existing test**. Add two:
- `modelLabel: "fake"` → the 200 response has `x-interim-model: fake`.
- `modelLabel` unset → the header is absent. A 400 response never has it.

### `tests/step-client.test.ts`
Use a fake `fetchImpl` returning `new Response(stream, { status, headers })`, where `stream` is built from `encodeSSE` strings.
- **Success:** returns `{ state, utterance, move, interrupt }`. `onMove` fires once before any `onToken`, and `onToken` fires in order. The `x-interim-model` header triggers `onModelLabel`. The request body equals `JSON.stringify(request)`, sent to `/api/step` (or a custom `endpoint`).
- **HTTP errors:**
  - 400 JSON → `StepHttpError(400, "bad_request", message)`
  - 413 → code `payload_too_large`
  - 500 with a non-JSON body → code `http_error`
  - `fetch` rejecting with `TypeError` → `StepHttpError(0, "network")`
  - `fetch` rejecting with an `AbortError` → rethrown unchanged (`name === "AbortError"`, not a `StepHttpError`)
- **Stream errors:**
  - an `error` event first → `StepStreamError` with its code and `retryable`
  - an `error` after a move and tokens → `StepStreamError`
- **Protocol violations**, each → `StepProtocolError`:
  - a token before the move
  - `done` before the move
  - an event after `done`
  - the stream ends after the move with no terminal event
  - joined tokens ≠ utterance
  - malformed SSE data

### `tests/interview-model.test.ts`
- Every reducer rule above, including what **must stay unchanged**:
  - `failed` keeps `engine` and `pendingStudentText`
  - `slow` is ignored once tokens have arrived and when not in flight
  - `token` clears `slow`
  - `done` with `phase "done"` → `"ended"`; any other phase → `"ready"`
- Purity: deep-freeze the input view and action; nothing throws.
- `canSend` for each status, for a null engine, for the done phase, and for whitespace-only text.
- `buildTurnRequest` trims the text and uses `source: "typed"`.
- `buildEndRequest` and `buildStartRequest` produce the exact shapes; the builders throw on a null engine.
- `visibleTranscript`: ordering and keys, with pending and streaming present or absent.
- `isThinking`.
- `describeError`: every table row, as exact strings and flags.

### `tests/e2e-text-interview.test.ts`: the M1 regression, in-process
- Build `handler = createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now })`, with a controllable `now`.
- Point `runStepRequest`'s `fetchImpl` at `(url, init) => handler(new Request("http://test" + url, init))`.
- Drive a **whole `maths-oxbridge` interview** through `interviewReducer` exactly as the hook would (request → callbacks → done), using fake timers or `vi.useFakeTimers({ shouldAdvanceTime: true })` so the token delays don't slow the test.
- **Script and expected moves:**
  1. start → `intro`, phase `problem`, problem 0
  2. `"I don't know"` → `hint{rung:0}`
  3. `"still stuck"` → `hint{rung:1}`
  4. `"this is wrong"` → `realign`
  5. `"solved it"` → `probe{probeIdx:0}`
  6. `"done"` → `advance{toProblemIdx:1}`
  7. `"solved"` → `probe`
  8. `"done"` → `advance{toProblemIdx:2}`
  9. `"finished"` → `probe`
  10. `"done"` → `wrap_up`, phase `wrap_up`
  11. `"thank you"` → `acknowledge`
  12. end → `silent`, status `ended`, phase `done`
- **Throughout:** every reply's tokens joined equal its utterance, every utterance is non-empty (except the final silent one), and the transcript grows by the expected entries.

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass **without** `MODEL_API_KEY` set. In the build output, `/` is static (`○`).
2. **No secret config text reaches the browser.** After `npm run build`, searching `.next/static` finds none of: `Model solution`, `Assume √2 = p/q in lowest terms`, `What would it mean for √2 to be rational?`, `two-pointer method (one pointer at each end`, `lowest-terms-missing`.
3. With `INTERIM_FAKE_MODEL=1 npm run dev`, a full text interview can be completed in the browser at `/` → **Start interview** → `/interview?config=maths-oxbridge&style=supportive`, using the keyword script above. `/interview?config=nope&style=x` shows the error card.
4. The frozen files are byte-for-byte unchanged (SHA-256 checked).
5. `src/client/**` imports nothing from `src/server/`, `src/lib/`, `src/config/` or `server-only`.
6. Every rule has a test that fails if the rule is changed. The reviewer will revert rules one at a time across the reducer, the helpers, `describeError`, the step-client protocol checks, the fake model, `selectDeps`, the header and the public config projection.
7. No existing test is deleted or weakened. Per-file test names are compared before and after.
8. No files are changed outside the allowed list.

## Held (not part of this stage)
- **Deploying M1 to Vercel:** public deployment is held.
- **Running a real interview against Meta:** this needs `MODEL_API_KEY`, which is held.
