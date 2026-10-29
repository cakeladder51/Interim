# Stage 9 brief: Feedback report (A6, B7) (handoff to the external model)

## Goal
When an interview ends, the student sees a **rubric report**:
- a short summary
- one score per rubric criterion, with that level's descriptor and a justification
- strengths, things to work on, and key moments quoted from what they said

The report comes from a new **`POST /api/feedback`** route. It makes one structured model call and checks the result against the config's rubric.

**Failure policy:** the server retries once. If it still fails, the student sees their **full transcript** with a **Try again** button.

**Build and test everything offline.** The live model needs `MODEL_API_KEY`, and it's **on hold**:
- Never call `api.meta.ai` or any other external API.
- Never read or add keys.
- Tests use fakes and run in-process.
- Under `next dev` with `INTERIM_FAKE_MODEL=1`, a deterministic **fake report** is used (never in production).

---

## What already exists: read this first
You're starting in a fresh session.
- **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win.
- `STATUS.md` lists completed stages, frozen file hashes and held items.
- **This repo uses Next.js 16.4 with breaking changes.** Read the relevant guide in `node_modules/next/dist/docs/` (route handlers, client components) before writing that code, and heed deprecation notices.

**Stack:**
- Next.js 16.4 App Router with `cacheComponents: true`. Route handlers run on Node by default. **Don't export `runtime` or `dynamic`**: `cacheComponents` rejects them. A route file may only export route handlers such as `POST`.
- React 19.3, TypeScript strict, zod v4.
- vitest runs in a **node environment** (no DOM). Tests go in `tests/` and run with `npx vitest run`. `@/*` maps to `src/*`, and `server-only` is mocked in tests.
- ESLint is `eslint-config-next` (core-web-vitals + typescript, including the React hooks/compiler rules):
  - **No `any`.**
  - Don't read `ref.current` during render.
  - **Don't call `setState` synchronously inside an effect body.** The design below avoids it, so keep to it.

**Contracts (`src/contracts`, frozen).**
- `EngineStateSchema`/`EngineState`:
  - `{ version, configId, styleId, startedAt, phase: "intro"|"problem"|"wrap_up"|"done", problemIdx, hintRung, checkpointsHit, lastInterjectAt, turnWordBaseline, probesAsked, transcript }`
  - `transcript` holds at most 500 `TranscriptEntry`: `{ id, at, speaker: "interviewer"|"student", kind: "utterance"|"interjection"|"typed", text }`.
  - **`at` is milliseconds since the interview started.** A student entry and the interviewer reply to it usually share the same `at`.
- **`ReportSchema`/`Report` already exists** (in `src/contracts/engine.ts`, exported from `@/contracts`). It converts cleanly to JSON Schema:
  ```ts
  { summary: string; criteria: { id: string; score: int; justification: string }[];
    strengths: string[]; improvements: string[]; keyMoments: { at: int>=0; quote: string; note: string }[] }
  ```
- **The config (`InterviewConfig`)** has `title`, `subject`, `styles[] {id,label,...}` and `problems[] {title, statement, solutionSketch, ...}`.
  - `rubric.criteria[]` is `{ id, name, levels: {score:int, descriptor}[] (≥2) }`.
  - Both configs (`maths-oxbridge`, `cs-oxbridge`) have the same 4 criteria, `approach`, `rigour`, `communication` and `responsiveness`, each with scores 1–4.
- `getConfig(id)` and `getStyle(config, styleId)` come from `src/config/load.ts` (frozen). Both throw for unknown ids.
- **`PublicConfig` (frozen) doesn't include the rubric.** That's why the feedback response carries criterion names and descriptors (§1).

**Model client (`src/lib/meta.ts`, frozen).**
- Signature: `chatJSON({ schema, schemaName, messages, timeoutMs?, retry?, signal?, client? })` resolves to `{ data, latencyMs, usage? }`.
- It throws `MetaError(code, message, retryable)` with code `"timeout"|"rate_limited"|"upstream"|"invalid_output"|"config"`. A caller abort rethrows the original error.
- `retry: false` disables its built-in retry.
- **It calls `getServerEnv()`, which throws a plain `Error` (not a `MetaError`) when `MODEL_API_KEY` is unset.** Your handler must turn that into a clean 502 (§4 H7).
- `src/server/assess.ts` shows the usage pattern.

**Existing patterns to copy:**
- `src/server/step-handler.ts`: `createStepHandler(deps)` returns `(request: Request) => Promise<Response>`, with content-length and JSON checks and `{error:{code,message}}` bodies.
- `src/server/deps.ts`: `selectDeps(env)` picks the fake model only when `INTERIM_FAKE_MODEL === "1"` and `NODE_ENV !== "production"`.
- `src/app/api/step/route.ts` is a 2-line route file.
- `src/client/step-client.ts`: `fetchImpl` injection and error classes.
- `tests/e2e-text-interview.test.ts`: how to drive the real step handler in-process, with `fetchImpl: (url, init) => handler(new Request("http://test" + url, init))` and `createStepHandler({ assess: fakeAssess, speak: fakeSpeak, now })` from `src/server/fake-model.ts`.

**The interview screen (`src/app/interview/InterviewScreen.tsx`).** When `view.status === "ended"` (engine phase `done`), the answer-bar area shows:
- "Interview complete."
- the placeholder `<p className="text-sm opacity-60 mb-4">Your feedback report is coming in a later stage.</p>`
- a "Start another interview" link

**Known intermittent test (don't touch it):** `tests/step-route.test.ts` › "step-handler abort mid-speak: no events after abort, no unhandled rejection". If it's the **only** failure, re-run the suite and note it in `STAGE9_NOTES.md`. **Never edit or weaken it.**

---

## Constraints
- **New files allowed:**
  - `src/shared/feedback-protocol.ts`
  - `src/server/feedback.ts`
  - `src/server/fake-feedback.ts`
  - `src/server/feedback-handler.ts`
  - `src/server/feedback-deps.ts`
  - `src/app/api/feedback/route.ts`
  - `src/client/feedback-client.ts`
  - `src/app/interview/FeedbackPanel.tsx`
  - `tests/feedback-view.test.ts`
  - `tests/feedback-route.test.ts`
  - `tests/fake-feedback.test.ts`
  - `tests/feedback-client.test.ts`
  - `tests/e2e-feedback.test.ts`
  - `STAGE9_NOTES.md`
- **Modified files allowed:** `src/app/interview/InterviewScreen.tsx`, with the §7 edits only.
- **Frozen; SHA-256 checked:** every other file under `src/`, plus:
  - `public/`, `relay/`, `configs/`, `evals/`, `scripts/`, `tests/helpers/`
  - **every existing test file**, including the reviewer copies listed in `STATUS.md`
  - `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
  - `.env.example`, `.env.local`
  - everything under `agent-os/`
- **No new dependencies.**
- **Never edit a frozen file to get around a problem,** and **never edit an expected value to make a test pass**: the vectors below were verified by the reviewer against a reference implementation. If something blocks you, stop and write it in `STAGE9_NOTES.md`.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **Client code** (`src/client/*`, `src/app/interview/*`) **must never import `src/server/*`, `src/lib/*` or `src/config/load.ts`.** The prompt includes solution sketches and must stay server-only. Every `src/server/*` file starts with `import "server-only";`.
- **Never log** transcript text, quotes, report text or keys. Log codes and counts only.

---

## 1. `src/shared/feedback-protocol.ts` (new; no `server-only`, imported by both sides)
```ts
import { z } from "zod";
import { EngineStateSchema } from "@/contracts";

export const FEEDBACK_MAX_BODY_BYTES = 1_000_000;

export const FeedbackRequestSchema = z.object({ state: EngineStateSchema });
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export const FeedbackViewSchema = z.object({
  summary: z.string().min(1),
  criteria: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        score: z.number().int(),
        maxScore: z.number().int(),
        descriptor: z.string(),
        justification: z.string(),
      })
    )
    .min(1),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  keyMoments: z.array(z.object({ at: z.number().int().min(0), quote: z.string(), note: z.string() })),
  modelLabel: z.string().optional(),
});
export type FeedbackView = z.infer<typeof FeedbackViewSchema>;
```

## 2. `src/server/feedback.ts` (new, server-only: prompt, validation, real model call)
**Exports:**
- `FEEDBACK_TIMEOUT_MS = 20_000`
- `class FeedbackInvalidError extends Error` (set `name = "FeedbackInvalidError"`)
- `normalizeText(s: string): string`, which returns `s.trim().split(/\s+/).filter(Boolean).join(" ")`
- `feedbackSystemPrompt(subject: string): string`
- `buildFeedbackMessages(config, style, state): { role: "system" | "user"; content: string }[]`
- `toFeedbackView(config, state, report): FeedbackView`
- `noAnswerView(config): FeedbackView`
- `generateReport(args: { config; style; state; signal?: AbortSignal; client?: OpenAI }): Promise<Report>`

**`feedbackSystemPrompt(subject)`** returns exactly this text, as a single line. `${subject}` is replaced by the subject; every other character, including the double quotes around `you`, is literal:
```
You are an experienced Oxbridge admissions interviewer writing feedback for a student after a practice interview in ${subject}. Score the student against the rubric using only what the transcript shows. Be specific and kind, address the student as "you", and never invent anything the student didn't say. Reply with JSON only.
```

**`buildFeedbackMessages`** returns `[ { role: "system", content: feedbackSystemPrompt(config.subject) }, { role: "user", content: lines.join("\n") } ]`. `lines` is built in this order:
1. `Interview: ${config.title}`
2. `Interviewer style: ${style.label}`
3. `""`
4. `Problems:`
5. For each problem `p` at index `i`:
   - `${i + 1}. ${p.title}: ${p.statement}`
   - `   Model solution (for scoring only; never quote it): ${p.solutionSketch}` (3 leading spaces)
6. `""`
7. `Rubric (give each criterion exactly one of its level scores):`
8. For each criterion `c`:
   - `- ${c.id} (${c.name}):`
   - then, for each level in config order, `  ${l.score}: ${l.descriptor}` (2 leading spaces)
9. `""`
10. `Transcript (ms from the start, then speaker):`
11. For each transcript entry `e`: `[${e.at}] ${who}: ${normalizeText(e.text)}`. Here `who` is:
    - `Student` for student entries
    - `Interviewer (interrupting)` for interviewer `kind: "interjection"`
    - `Interviewer` otherwise
12. `""`
13. These five lines, verbatim:
    ```
    Return a JSON object with:
    - summary: 2-3 sentences on the overall performance.
    - criteria: one entry per rubric criterion, with its id, the chosen score, and a one-sentence justification that cites what the student said or did.
    - strengths: up to 3 short points.
    - improvements: up to 3 short, actionable points.
    - keyMoments: up to 3 moments from the student's lines, each with the exact "at" value of that line, a short exact quote from it, and a note.
    ```

**`toFeedbackView(config, state, report)`.** The rules are numbered, and the reviewer reverts each one:
- **V1:** `summary = report.summary.trim()`. If it's `""`, throw `FeedbackInvalidError`.
- **V2:** if `report.criteria.length !== config.rubric.criteria.length`, throw `FeedbackInvalidError`.
- **V3:** for each rubric criterion `c`, **in config order**:
  - `found = report.criteria.filter(x => x.id === c.id)`. If `found.length !== 1`, throw.
  - `level = c.levels.find(l => l.score === found[0].score)`. If there isn't one, throw.
  - Output `{ id: c.id, name: c.name, score: level.score, maxScore: Math.max(...c.levels.map(l => l.score)), descriptor: level.descriptor, justification: found[0].justification.trim() }`.
- **V4:** `strengths` and `improvements`: trim each item, drop empty ones, and keep the first 5.
- **V5:** `keyMoments`: keep a moment `m` only if all of these hold:
  - `normalizeText(m.quote) !== ""`
  - `m.note.trim() !== ""`
  - **some student entry** `e` has `e.at === m.at` and `normalizeText(e.text).includes(normalizeText(m.quote))`

  Map each kept moment to `{ at: m.at, quote: normalizeText(m.quote), note: m.note.trim() }`, sort by `at` ascending (a stable sort), then keep the first 5.
- **V6:** return `{ summary, criteria, strengths, improvements, keyMoments }`. **Don't add `modelLabel` here.**

**`noAnswerView(config)`** has no model call. It returns:
- `summary`: `You didn't answer any questions in this interview, so there's nothing to score yet. Try again and talk through your thinking out loud.`
- `criteria`: for each rubric criterion in config order, its **lowest-score** level: `{ id, name, score, maxScore, descriptor, justification: "No answer was given." }`
- `strengths: []`
- `improvements: ["Answer out loud, even when you're unsure: the interviewer can only help with what they hear."]`
- `keyMoments: []`

**`generateReport(args)`** returns `(await chatJSON({ schema: ReportSchema, schemaName: "Report", messages: buildFeedbackMessages(config, style, state), timeoutMs: FEEDBACK_TIMEOUT_MS, retry: false, signal, client })).data`.
- Don't catch anything here. The handler decides about retries.

## 3. `src/server/fake-feedback.ts` (new, server-only)
- `FAKE_FEEDBACK_DELAY_MS = 300`.
- **`fakeReport(config, state): Report`** is pure. Let `students` be the student entries and `n = students.length`. Let `plural(k, w)` be `` `${k} ${w}${k === 1 ? "" : "s"}` ``. It returns:
  - `summary`: `` `Offline practice feedback: you answered ${plural(n, "time")}.` ``
  - `criteria`: for each rubric criterion in config order:
    - sort its levels by score ascending
    - take `sorted[Math.min(sorted.length - 1, Math.floor(n / 3))]`
    - output `{ id: c.id, score: thatLevel.score, justification: `Offline estimate from ${plural(n, "answer")}.` }`
  - `strengths: ["You kept going and shared your thinking."]`
  - `improvements: ["Justify each step before moving on."]`
  - `keyMoments`:
    - if `n > 0`: `[{ at: students[0].at, quote: normalizeText(students[0].text).split(" ").slice(0, 8).join(" "), note: "Your first answer." }]`
    - otherwise `[]`
- **`fakeGenerate(args: { config; style; state; signal?: AbortSignal }): Promise<Report>`:**
  1. Wait `FAKE_FEEDBACK_DELAY_MS` (a `setTimeout` promise).
  2. If `signal?.aborted`, throw an `Error` with `name = "AbortError"`.
  3. Otherwise return `fakeReport(config, state)`.

## 4. `src/server/feedback-handler.ts` (new, server-only)
```ts
export const FEEDBACK_ATTEMPTS = 2;
export const FEEDBACK_RETRY_DELAY_MS = 400;
export interface FeedbackDeps {
  generate: (args: { config: InterviewConfig; style: Style; state: EngineState; signal?: AbortSignal }) => Promise<Report>;
  sleep?: (ms: number) => Promise<void>; // default: a setTimeout promise
  modelLabel?: string;
}
export function createFeedbackHandler(deps: FeedbackDeps): (request: Request) => Promise<Response>;
```
**Every response** is JSON, with the headers `Content-Type: application/json` and `Cache-Control: no-store`. **Error bodies** have the shape `{ error: { code, message, retryable? } }`.

The rules:
- **H1:** if the `content-length` header parses to more than `FEEDBACK_MAX_BODY_BYTES`, return **413** `{error:{code:"payload_too_large", message:"Request body too large."}}`.
- **H2:** invalid JSON returns **400** `{error:{code:"bad_request", message:"Invalid feedback request."}}`.
- **H3:** if `FeedbackRequestSchema.safeParse(body)` fails, return the same 400.
- **H4:** if `getConfig(state.configId)` or `getStyle(config, state.styleId)` throws, return the same 400.
- **H5:** if `state.phase !== "done"`, return **400** `{error:{code:"not_finished", message:"The interview hasn't finished yet."}}`.
- **H6:** if the transcript has **no student entries**, return **200** with `noAnswerView(config)`, plus `modelLabel` if `deps.modelLabel` is set. **`generate` isn't called.**
- **H7:** make up to `FEEDBACK_ATTEMPTS` attempts. Each attempt:
  - calls `report = await deps.generate({ config, style, state, signal: request.signal })`
  - then `view = toFeedbackView(config, state, report)`
  - on success, returns **200** with `{ ...view, modelLabel }` (add `modelLabel` only when `deps.modelLabel` is set)

  On a thrown error, decide:
  - If `request.signal.aborted` **or** the error's `name === "AbortError"`, stop trying. Check both: a `Request` doesn't always reflect its creator's abort promptly.
  - Otherwise let `retryable = err instanceof FeedbackInvalidError || (err instanceof MetaError && err.retryable)`.
  - If `retryable` and this wasn't the last attempt, `await sleep(FEEDBACK_RETRY_DELAY_MS)` and try again. Otherwise stop.

  Any other error, including the plain `Error` from a missing key, has `retryable = false`, so it isn't retried.
- **H8:** after the last attempt fails, return **502** `{error:{code:"feedback_failed", message:"We couldn't prepare your feedback.", retryable}}`, where `retryable` belongs to the last error.
  - Log once, with `console.warn("Interim: feedback failed", { attempts, code })`. `attempts` is the number of `generate` calls. `code` is the `MetaError` code, `"invalid"` for `FeedbackInvalidError`, or `"error"` otherwise.
  - **Nothing else is logged.**

## 5. `src/server/feedback-deps.ts` and `src/app/api/feedback/route.ts` (new)
- `selectFeedbackDeps(env: Record<string, string | undefined> = process.env): FeedbackDeps`:
  - `{ generate: fakeGenerate, modelLabel: "fake" }` when `env.INTERIM_FAKE_MODEL === "1" && env.NODE_ENV !== "production"`
  - otherwise `{ generate: generateReport }`
  - No log.
- The route file contains exactly:
  ```ts
  import { createFeedbackHandler } from "@/server/feedback-handler";
  import { selectFeedbackDeps } from "@/server/feedback-deps";

  export const POST = createFeedbackHandler(selectFeedbackDeps());
  ```

## 6. `src/client/feedback-client.ts` (new; React-free; no `src/server` imports)
```ts
export class FeedbackError extends Error {
  constructor(public status: number, public code: string, public retryable: boolean) { super(code); this.name = "FeedbackError"; }
}
export function fetchFeedback(state: EngineState, opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch; endpoint?: string }): Promise<FeedbackView>;
export function describeFeedbackError(err: unknown): { message: string; retryable: boolean };
export function formatAt(ms: number): string;
export type FeedbackSnapshot =
  | { status: "loading" }
  | { status: "ready"; view: FeedbackView }
  | { status: "failed"; message: string; retryable: boolean };
export function createFeedbackRunner(deps: {
  fetchFeedback: (state: EngineState, signal: AbortSignal) => Promise<FeedbackView>;
  onChange: (s: FeedbackSnapshot) => void;
}): { start(state: EngineState): void; retry(): void; abort(): void };
```

**`fetchFeedback`** uses `endpoint`, which defaults to `"/api/feedback"`:
- **C1:** call `fetchImpl(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }), signal })`. `fetchImpl` defaults to the global `fetch`.
  - If it rejects and either `opts.signal?.aborted` is true or the error's `name === "AbortError"`, rethrow the error unchanged.
  - Any other rejection throws `new FeedbackError(0, "network", true)`.
- **C2:** if `!res.ok`, read `code` from `(await res.json()).error.code` when that's a string. Use `"http"` if the body can't be read or has no code. Then throw `new FeedbackError(res.status, code, res.status >= 500)`.
- **C3:** if the body isn't valid JSON or fails `FeedbackViewSchema`, throw `new FeedbackError(res.status, "protocol", true)`. Otherwise return the parsed value.

**`describeFeedbackError(err)`:**
- A `FeedbackError` with `status` 400 or 413 returns `{ message: "This interview can't be scored.", retryable: false }`.
- **Anything else** returns `{ message: "We couldn't prepare your feedback. Please try again.", retryable: true }`.

**`formatAt(ms)`** returns `` `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}` ``.

**`createFeedbackRunner`.** The rules are numbered, and the reviewer reverts each one:
- **R1 `start(state)`:**
  - First abort any current run, as R3 does.
  - Set `lastState = state`, create a new `AbortController` and a unique run token, and mark the run current.
  - Call `deps.fetchFeedback(state, controller.signal)`.
  - **`start` doesn't call `onChange` itself.** The component starts in `"loading"`, so no state is set synchronously inside an effect.
- **R2 on success:** only if this run is still current, clear the current run and call `onChange({ status: "ready", view })`.
- **R3 `abort()`:** if a run is current, call `controller.abort()` and clear it. An aborted or superseded run **never** calls `onChange`, now or later.
- **R4 on failure:** only if this run is still current, clear the current run. Then:
  - if the error's `name === "AbortError"`, do nothing
  - otherwise call `onChange({ status: "failed", ...describeFeedbackError(err) })`
- **R5 `retry()`:** if `lastState === null` or a run is current, do nothing. Otherwise call `onChange({ status: "loading" })`, then `start(lastState)`.
- **R6:** attach the rejection handler as soon as the promise is created, so a rejected fetch never becomes an unhandled rejection.

## 7. UI
### `src/app/interview/FeedbackPanel.tsx` (new, `"use client"`; not unit-tested, so keep it small)
- **Props:** `{ state: EngineState }`.
- `const [snap, setSnap] = useState<FeedbackSnapshot>({ status: "loading" });` and `const runnerRef = useRef<ReturnType<typeof createFeedbackRunner> | null>(null);`.
- **The effect, with deps `[state]`:**
  ```ts
  const runner = createFeedbackRunner({ fetchFeedback: (s, signal) => fetchFeedback(s, { signal }), onChange: setSnap });
  runnerRef.current = runner;
  runner.start(state);
  return () => { runner.abort(); runnerRef.current = null; };
  ```
- **The root element** is `<section aria-label="Feedback" className="w-full max-w-2xl text-left">`.
- **loading:** `<p className="text-sm opacity-60" role="status">Preparing your feedback…</p>`. The `…` is the single Unicode ellipsis character.
- **ready:**
  - `<h2 className="text-lg font-semibold mb-2">Your feedback</h2>`
  - `<p className="mb-4">{summary}</p>`
  - `<h3 className="font-semibold mb-1">Scores</h3>`, then a `<ul className="mb-4">`. Each criterion `<li key={id} className="mb-2">` contains:
    - `<span className="font-semibold">{name}</span>: {score}/{maxScore}`
    - `<p className="text-sm italic opacity-70">{descriptor}</p>`
    - `<p className="text-sm">{justification}</p>`
  - These sections appear only when their array is non-empty. Each is an `<h3 className="font-semibold mb-1">` plus a `<ul className="mb-4 list-disc pl-5">`:
    - `Strengths`
    - `Things to work on` (from `improvements`)
    - `Key moments`, where each item is `<li><span className="font-mono">{formatAt(at)}</span> “{quote}”: {note}</li>`
  - When `modelLabel === "fake"`, also show `<p className="text-xs opacity-50">Offline practice report (no AI model was used).</p>`.
- **failed:**
  - `<p className="mb-2">{message}</p>`
  - when `retryable`, a `<button>` labelled `Try again` whose `onClick` is `() => runnerRef.current?.retry()`
  - then `<h3 className="font-semibold mt-4 mb-1">Your transcript</h3>` and an `<ol>`. Each transcript entry is `<li key={e.id} className="mb-1"><span className="font-semibold">{e.speaker === "student" ? "You" : "Interviewer"}</span> <span className="font-mono text-xs opacity-60">{formatAt(e.at)}</span>: {e.text}</li>`.
- **Button styling** copies the existing "Try again" button in `InterviewScreen.tsx` (its `className` and `style`).

### `src/app/interview/InterviewScreen.tsx` (exact edits; nothing else)
1. After `import Scratchpad from "./Scratchpad";`, add `import FeedbackPanel from "./FeedbackPanel";`.
2. In the ended block, change the container's `className` from `"border-t p-6 flex flex-col items-center justify-center"` to `"border-t p-6 flex flex-col items-center gap-4 overflow-y-auto max-h-[70vh]"`.
3. Replace `<p className="text-sm opacity-60 mb-4">Your feedback report is coming in a later stage.</p>` with `{view.engine && <FeedbackPanel state={view.engine} />}`.

---

## Tests (vitest, node environment, in-process only; assert the literal values below)

**Shared fixtures.** `F1` uses `getConfig("maths-oxbridge")` and this transcript:
```ts
const T = [
  { id: "e1", at: 0, speaker: "interviewer", kind: "utterance", text: "Welcome. Let's begin." },
  { id: "e2", at: 5000, speaker: "student", kind: "typed", text: "I think   the answer is\nroot two" },
  { id: "e3", at: 5000, speaker: "interviewer", kind: "utterance", text: "Why is that?" },
  { id: "e4", at: 9000, speaker: "student", kind: "typed", text: "Because it can't be a fraction." },
];
```
Use it as `state`, in this full `EngineState`: `{ version: 1, configId: "maths-oxbridge", styleId: "supportive", startedAt: 1000, phase: "done", problemIdx: 0, hintRung: -1, checkpointsHit: [], lastInterjectAt: null, turnWordBaseline: 0, probesAsked: 0, transcript: T }`. The report `R` is:
```ts
const R = {
  summary: "  Good start.  ",
  criteria: [
    { id: "rigour", score: 3, justification: "Mostly right." },
    { id: "approach", score: 2, justification: " Needed a hint. " },
    { id: "responsiveness", score: 4, justification: "Quick." },
    { id: "communication", score: 1, justification: "Quiet." },
  ],
  strengths: ["Clear.", "  ", "Kept going."],
  improvements: ["i1", "i2", "i3", "i4", "i5", "i6"],
  keyMoments: [
    { at: 9000, quote: "can't be a fraction", note: "Good insight." },
    { at: 5000, quote: "the answer is  root two", note: "First idea." },
    { at: 5000, quote: "Why is that", note: "Interviewer line." },
    { at: 1234, quote: "root two", note: "Wrong time." },
    { at: 9000, quote: "   ", note: "Empty quote." },
    { at: 9000, quote: "fraction", note: "  " },
  ],
};
```

### `tests/feedback-view.test.ts`
1. **F1:** `toFeedbackView(maths, state, R)` **toEqual** exactly:
   ```ts
   { summary: "Good start.",
     criteria: [
       { id: "approach", name: "Problem-solving approach", score: 2, maxScore: 4, descriptor: "Finds a way in only after substantial hints.", justification: "Needed a hint." },
       { id: "rigour", name: "Rigour and correctness", score: 3, maxScore: 4, descriptor: "Correct, with minor gaps in justification.", justification: "Mostly right." },
       { id: "communication", name: "Thinking aloud", score: 1, maxScore: 4, descriptor: "Rarely explains thinking; hard to follow.", justification: "Quiet." },
       { id: "responsiveness", name: "Responding to hints", score: 4, maxScore: 4, descriptor: "Picks up subtle hints immediately and builds on them.", justification: "Quick." } ],
     strengths: ["Clear.", "Kept going."],
     improvements: ["i1", "i2", "i3", "i4", "i5"],
     keyMoments: [ { at: 5000, quote: "the answer is root two", note: "First idea." },
                   { at: 9000, quote: "can't be a fraction", note: "Good insight." } ] }
   ```
   The result has **no** `modelLabel` key: `expect("modelLabel" in view).toBe(false)`.
2. **Each of these throws `FeedbackInvalidError`** (use `toThrow(FeedbackInvalidError)`), one `it` each:
   - **F2:** `criteria` without `rigour`, i.e. `R.criteria.slice(1)`
   - **F3:** `[...R.criteria.slice(1), { id: "approach", score: 1, justification: "x" }]` (a duplicate)
   - **F4:** `[...R.criteria.slice(1), { id: "creativity", score: 2, justification: "x" }]` (an unknown id)
   - **F5:** rigour score `5`
   - **F6:** rigour score `0`
   - **F7:** summary `"   "`
   - **F8:** all 4 criteria plus `{ id: "creativity", score: 2, justification: "x" }`
3. **NA:** `noAnswerView(maths)` toEqual exactly:
   ```ts
   { summary: "You didn't answer any questions in this interview, so there's nothing to score yet. Try again and talk through your thinking out loud.",
     criteria: [
       { id: "approach", name: "Problem-solving approach", score: 1, maxScore: 4, descriptor: "Doesn't find a way in, even with hints.", justification: "No answer was given." },
       { id: "rigour", name: "Rigour and correctness", score: 1, maxScore: 4, descriptor: "Key steps are wrong or missing.", justification: "No answer was given." },
       { id: "communication", name: "Thinking aloud", score: 1, maxScore: 4, descriptor: "Rarely explains thinking; hard to follow.", justification: "No answer was given." },
       { id: "responsiveness", name: "Responding to hints", score: 1, maxScore: 4, descriptor: "Ignores or can't use hints.", justification: "No answer was given." } ],
     strengths: [],
     improvements: ["Answer out loud, even when you're unsure: the interviewer can only help with what they hear."],
     keyMoments: [] }
   ```
4. **The exact prompt.** Use this synthetic config, `TC`, which must parse with `InterviewConfigSchema`; assert `.parse(TC)` doesn't throw:
   ```ts
   const TC = {
     id: "t", title: "Test interview", subject: "Mathematics",
     styles: [{ id: "s", label: "Supportive", persona: "p", tone: "t", interjection: { minConfidence: 0.7, cooldownMs: 0, minNewWords: 0 } }],
     problems: [{ id: "p1", title: "Roots", statement: "Is the square root of 2 rational?", checkpoints: [{ id: "c1", description: "d" }],
                  hintLadder: ["h"], probes: ["q"], misconceptions: [], solutionSketch: "Assume p/q in lowest terms." }],
     rubric: { criteria: [
       { id: "approach", name: "Approach", levels: [{ score: 1, descriptor: "Weak." }, { score: 2, descriptor: "Strong." }] },
       { id: "clarity", name: "Clarity", levels: [{ score: 1, descriptor: "Unclear." }, { score: 2, descriptor: "Clear." }] } ] },
     timing: { maxMinutes: 10, silenceStuckMs: 20000 }, fallbackPrompt: "f", asrKeywords: [],
   };
   ```
   Its transcript has three entries:
   - `{ id:"a", at:0, speaker:"interviewer", kind:"utterance", text:"Hello." }`
   - `{ id:"b", at:4000, speaker:"student", kind:"utterance", text:"It is   rational\nI think" }`
   - `{ id:"c", at:4000, speaker:"interviewer", kind:"interjection", text:"Hold on." }`

   `buildFeedbackMessages(TC, TC.styles[0], state)` must give `messages[0]` = `{ role: "system", content: <the system prompt with subject "Mathematics"> }`, with the prompt written out as a literal string in the test. `messages[1].content` must be **exactly** this block (lines joined with `\n`, no trailing newline):
   ```
   Interview: Test interview
   Interviewer style: Supportive

   Problems:
   1. Roots: Is the square root of 2 rational?
      Model solution (for scoring only; never quote it): Assume p/q in lowest terms.

   Rubric (give each criterion exactly one of its level scores):
   - approach (Approach):
     1: Weak.
     2: Strong.
   - clarity (Clarity):
     1: Unclear.
     2: Clear.

   Transcript (ms from the start, then speaker):
   [0] Interviewer: Hello.
   [4000] Student: It is rational I think
   [4000] Interviewer (interrupting): Hold on.

   Return a JSON object with:
   - summary: 2-3 sentences on the overall performance.
   - criteria: one entry per rubric criterion, with its id, the chosen score, and a one-sentence justification that cites what the student said or did.
   - strengths: up to 3 short points.
   - improvements: up to 3 short, actionable points.
   - keyMoments: up to 3 moments from the student's lines, each with the exact "at" value of that line, a short exact quote from it, and a note.
   ```
5. **`normalizeText`:** `"  a \n b\t\tc "` gives `"a b c"`, and `"   "` gives `""`.
6. **`generateReport` with a fake `client`.** The fake's `chat.completions.create` resolves `{ choices: [{ message: { content: JSON.stringify(R) } }] }`. Assert all of these:
   - it returns `R`
   - the request used `response_format.json_schema.name === "Report"`
   - the request's `messages` equal `buildFeedbackMessages(...)`

   Set `MODEL_API_KEY` for the test with `vi.stubEnv("MODEL_API_KEY", "test-key")` and undo it with `vi.unstubAllEnvs()`. `getServerEnv` caches, so call `vi.resetModules()` and import `@/server/feedback` dynamically inside the test.
   - If that turns out not to be workable in this codebase, write the reason in `STAGE9_NOTES.md` and test `buildFeedbackMessages` only. **Don't change frozen files.**
   - The test must never reach the network.

### `tests/fake-feedback.test.ts`
1. **`fakeReport(maths, s)`** for transcripts of `n` student entries. Entry `i` has `at: 1000 * (i + 1)`. Entry 0's text is `"  one two three four five six seven eight nine ten "`; every other entry's text is `"x"`.

   | n | summary | every criterion's score | justification | keyMoments |
   |---|---|---|---|---|
   | 1 | `Offline practice feedback: you answered 1 time.` | 1 | `Offline estimate from 1 answer.` | `[{ at: 1000, quote: "one two three four five six seven eight", note: "Your first answer." }]` |
   | 2 | `… 2 times.` | 1 | `Offline estimate from 2 answers.` | same |
   | 3 | `… 3 times.` | 2 | `… 3 answers.` | same |
   | 5 | `… 5 times.` | 2 | `… 5 answers.` | same |
   | 6 | `… 6 times.` | 3 | `… 6 answers.` | same |
   | 9 | `… 9 times.` | 4 | `… 9 answers.` | same |
   | 12 | `… 12 times.` | 4 | `… 12 answers.` | same |

   For every row, also check that:
   - `criteria` ids are `["approach","rigour","communication","responsiveness"]`, in that order
   - `strengths` is `["You kept going and shared your thinking."]` and `improvements` is `["Justify each step before moving on."]`
   - `toFeedbackView(maths, s, fakeReport(maths, s))` doesn't throw

   Write the full strings in the test; the `…` in the table is only shorthand here.
2. **`fakeGenerate`** resolves the same value as `fakeReport` after about 300 ms (use fake timers). When the signal is aborted during the wait, it rejects with an error whose `name` is `"AbortError"`.
3. **`selectFeedbackDeps`:**

   | env | Result |
   |---|---|
   | `{ INTERIM_FAKE_MODEL: "1", NODE_ENV: "development" }` | `generate === fakeGenerate`, `modelLabel === "fake"` |
   | `{ INTERIM_FAKE_MODEL: "1", NODE_ENV: "production" }` | `generate === generateReport`, `modelLabel === undefined` |
   | `{ INTERIM_FAKE_MODEL: "true", NODE_ENV: "development" }` | `generateReport` |
   | `{}` | `generateReport` |

### `tests/feedback-route.test.ts` (call `createFeedbackHandler(deps)` directly with `new Request("http://test/api/feedback", { method: "POST", body, headers })`)
Use `deps = { generate: vi.fn(...), sleep: vi.fn(async () => {}) }` unless a row says otherwise, and the F1 `state`.

| # | Setup | Expect |
|---|---|---|
| 1 | `generate` resolves `R` | 200. The body equals the F1 view. Headers: `content-type` contains `application/json`, `cache-control` is `no-store`. `generate` was called once, with `{ config, style, state, signal }` where `config.id === "maths-oxbridge"` and `signal` is an `AbortSignal`. `sleep` wasn't called. |
| 2 | `deps.modelLabel = "fake"`, `generate` resolves `R` | 200, and the body equals `{ ...F1view, modelLabel: "fake" }` |
| 3 | `generate` resolves an F2-style invalid report, then `R` | 200 (F1 view). `generate` called 2 times; `sleep` called once, with `400` |
| 4 | `generate` always resolves an invalid report | 502 `{ error: { code: "feedback_failed", message: "We couldn't prepare your feedback.", retryable: true } }`. `generate` called 2 times. `console.warn` called once, with `("Interim: feedback failed", { attempts: 2, code: "invalid" })` (spy on it) |
| 5 | `generate` rejects `new MetaError("timeout", "t", true)`, then resolves `R` | 200, 2 calls |
| 6 | `generate` rejects `new MetaError("upstream", "u", false)` | 502 with `retryable: false`. **1** call, `sleep` not called, warn `{ attempts: 1, code: "upstream" }` |
| 7 | `generate` rejects `new Error("MODEL_API_KEY is required")` | 502 with `retryable: false`, 1 call, warn `{ attempts: 1, code: "error" }`. Also: no `console.*` call's arguments contain any transcript text, quote or the key name. Check this by stringifying every spy call. |
| 8 | State with no student entries (just `e1`), phase `done` | 200, and the body equals `noAnswerView(maths)`. `generate` **not** called |
| 9 | Same as 8, with `modelLabel: "fake"` | the body equals `{ ...noAnswerView(maths), modelLabel: "fake" }` |
| 10 | `phase: "problem"` | 400 `{ error: { code: "not_finished", message: "The interview hasn't finished yet." } }`, and `generate` not called |
| 11 | body `"{"` (invalid JSON) | 400 `{ error: { code: "bad_request", message: "Invalid feedback request." } }` |
| 12 | body `{"state": 5}` | the same 400 |
| 13 | `state.configId = "nope"` | the same 400 |
| 14 | `state.styleId = "nope"` | the same 400 |
| 15 | header `content-length: "1000001"` (any small body) | 413 `{ error: { code: "payload_too_large", message: "Request body too large." } }` |
| 16 | `content-length: "1000000"` with a valid body | not 413 (200) |
| 17 | `generate` rejects an `Error` with `name = "AbortError"` (no `AbortController` needed) | 502, `generate` called **once** (no retry after an abort), `sleep` not called |

### `tests/feedback-client.test.ts`
**`fetchFeedback`** (with a fake `fetchImpl`):
1. On 200 with the F1 view's JSON, it resolves that view. The fake saw:
   - URL `"/api/feedback"`
   - method `POST`
   - header `Content-Type: application/json`
   - body `JSON.stringify({ state })`
   - the passed `signal`

   A custom `endpoint` is used when given.
2. `fetchImpl` rejects a `TypeError` → `FeedbackError` `{ status: 0, code: "network", retryable: true }`.
3. `fetchImpl` rejects an `AbortError` (with the signal aborted) → the same error object is rethrown (`toBe`).
4. 502 with body `{error:{code:"feedback_failed"}}` → `{ status: 502, code: "feedback_failed", retryable: true }`.
5. 400 with body `{error:{code:"not_finished"}}` → `{ status: 400, code: "not_finished", retryable: false }`.
6. 500 with a non-JSON body → `{ status: 500, code: "http", retryable: true }`.
7. 200 with `{"summary":""}` → `{ status: 200, code: "protocol", retryable: true }`; 200 with a non-JSON body → `code: "protocol"`.

**`describeFeedbackError`:**
- 8\. `FeedbackError(400, …)` and `FeedbackError(413, …)` → `{ message: "This interview can't be scored.", retryable: false }`
- 9\. `FeedbackError(502, …)`, `FeedbackError(0, …)` and `new Error("x")` → `{ message: "We couldn't prepare your feedback. Please try again.", retryable: true }`

**`formatAt`:**
- 10\. `0` → `"0:00"`, `5000` → `"0:05"`, `59999` → `"0:59"`, `60000` → `"1:00"`, `65000` → `"1:05"`, `600000` → `"10:00"`, `3599000` → `"59:59"`

**The runner** uses a fake `fetchFeedback` that returns manually resolved promises and records the signals. Record every `onChange` call in `calls`.
11. `start(state)`: `calls` is `[]` straight after (start never emits). Resolve with the view → `calls` equals `[{ status: "ready", view }]`.
12. Reject with `FeedbackError(502, "feedback_failed", true)` → `[{ status: "failed", message: "We couldn't prepare your feedback. Please try again.", retryable: true }]`. Reject with `FeedbackError(400, …)` in a fresh runner → `retryable: false` and the "can't be scored" message.
13. Then `retry()` → `calls` gains `{ status: "loading" }`, `fetchFeedback` is called a 2nd time with the **same state object**, and resolving that call adds `ready`.
14. `retry()` while a run is in flight does nothing (no `onChange`, no new fetch). `retry()` before any `start` does nothing.
15. `abort()` mid-flight → the recorded signal is aborted, and a later resolve **or** reject adds nothing to `calls`.
16. **Superseded:** `start(s1)`, then `start(s2)`. The first signal is aborted. Resolving the first call adds nothing; resolving the second adds `ready`.
17. A rejection with an `AbortError` (name `"AbortError"`) on the current run adds nothing.
18. **No unhandled rejection:** a run rejected after `abort()` doesn't produce an unhandled rejection (vitest must stay clean).

### `tests/e2e-feedback.test.ts` (the real step handler + fake model, then the real feedback handler with `{ generate: fakeGenerate, modelLabel: "fake", sleep: async () => {} }`, joined through `fetchFeedback` with `fetchImpl`)
1. Drive a text interview through `runStepRequest`, with `now` taking these values:
   - `start` (maths-oxbridge / supportive) at `now = 1_000_000`
   - `turn_complete` `"I don't know"` (typed) at `1_010_000`
   - `end` at `1_020_000`

   The final state has `phase: "done"`. Its transcript is exactly 4 entries, with `(speaker, kind, at)` of `(interviewer, utterance, 0)`, `(student, typed, 10000)`, `(interviewer, utterance, 10000)` and `(interviewer, utterance, 20000)`.
2. `await fetchFeedback(finalState, { fetchImpl: (url, init) => feedbackHandler(new Request("http://test" + url, init)) })` **toEqual** exactly:
   ```ts
   { summary: "Offline practice feedback: you answered 1 time.",
     criteria: [
       { id: "approach", name: "Problem-solving approach", score: 1, maxScore: 4, descriptor: "Doesn't find a way in, even with hints.", justification: "Offline estimate from 1 answer." },
       { id: "rigour", name: "Rigour and correctness", score: 1, maxScore: 4, descriptor: "Key steps are wrong or missing.", justification: "Offline estimate from 1 answer." },
       { id: "communication", name: "Thinking aloud", score: 1, maxScore: 4, descriptor: "Rarely explains thinking; hard to follow.", justification: "Offline estimate from 1 answer." },
       { id: "responsiveness", name: "Responding to hints", score: 1, maxScore: 4, descriptor: "Ignores or can't use hints.", justification: "Offline estimate from 1 answer." } ],
     strengths: ["You kept going and shared your thinking."],
     improvements: ["Justify each step before moving on."],
     keyMoments: [{ at: 10000, quote: "I don't know", note: "Your first answer." }],
     modelLabel: "fake" }
   ```
3. Call `fetchFeedback` with the state returned by the `turn_complete` step (before `end`; phase `problem`). It rejects with `FeedbackError` `{ status: 400, code: "not_finished", retryable: false }`.

---

## Acceptance criteria
1. Only the allowed files changed, and every frozen file is byte-identical (SHA-256 checked against `STATUS.md`). `InterviewScreen.tsx` differs from `0789eeab` only by the 3 edits in §7.
2. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 problems, and `npx next build` passes with no keys set. The build lists the route `/api/feedback`.
3. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** Every pre-existing test passes unchanged (788 before this stage), and no test name disappears.
4. Every vector and string above is asserted literally (no `toContain` on whole objects, no recomputing an expected value with the code under test).
5. **No client file imports `src/server`, `src/lib` or `src/config/load`.** The built client bundle contains none of the prompt text: `Model solution`, `admissions interviewer writing feedback`, `Return a JSON object with`.
6. **Offline under `next dev`** (`INTERIM_FAKE_MODEL=1`): finish a text interview and the report appears with "Offline practice report (no AI model was used)." `POST /api/feedback` with an unfinished state returns 400 `not_finished`. Under `next start`, the fake is never used.
7. Nothing logs transcript text, quotes, report text or keys.
8. `STAGE9_NOTES.md` lists what you built, any deviations, and anything you couldn't do, with reasons.

## Held (not part of this stage)
- **Live report quality and latency** with the real model (`MODEL_API_KEY`): do the scores match the transcript, are the quotes exact, does the report invent nothing, and is it under about 15 s?
- Any deploy.
