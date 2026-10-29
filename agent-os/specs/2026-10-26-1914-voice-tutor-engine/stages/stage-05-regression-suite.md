# Stage 5 brief: Scripted-student regression suite (handoff to the external model)

## Goal
Build a library of **8 scripted students**. Each one is a timed sequence of student events with a canned assessor verdict and the exact interviewer behaviour we expect. Replay them through the **real** `/api/step` stack (handler, then `decide`, then streaming, then the browser request client) in two modes:

1. **Deterministic mode (`npm test`, now).** The assessor returns the script's canned verdict, and the speaker uses the deterministic fallback lines. Every expectation must hold exactly. This locks in the tutor's behaviour, including mid-answer interjection timing, cooldowns, word gates, the hint ladder, time-up and canvas, so later stages can't break it silently.
2. **Live mode (`npm run eval`, on hold).** The same scripts, but each assessor call is **also** sent to the real Muse Spark assessor. Its verdict is scored against the script's `live` expectations, and latency is measured. The interview itself stays on the canned verdicts, so every script follows the same path. **This needs `MODEL_API_KEY`, which is on hold.** Build it and unit-test it now, but **don't run it against the network**. Without a key it must exit cleanly with code 2.

No API keys are available and nothing is deployed (both on hold). No test may make a network call.

---

## What already exists (Stages 1–4): read this first

You're starting in a fresh session. **`plan.md` is historical** (for example, `wordsSinceInterject` became `turnWordBaseline`, and `probesAsked` was added). Where it differs from this brief or the code, this brief and the code win. `STATUS.md` lists what's done and what's held.

Read these files before writing code:
- `src/contracts/engine.ts`
- `src/contracts/step-protocol.ts`
- `src/engine/fsm.ts`
- `src/engine/types.ts`
- `src/engine/prompts.ts` (`fallbackUtterance`)
- `src/server/step-handler.ts`
- `src/server/assess.ts`
- `src/client/step-client.ts`
- `configs/maths-oxbridge.json`
- `configs/cs-oxbridge.json`
- `tests/e2e-text-interview.test.ts` (an existing in-process replay you can borrow from)
- `scripts/latency.ts` (an existing CLI script, for style)

**Stack:**
- Next.js 16.4, TypeScript strict, zod v4 (`import { z } from "zod"`), vitest (node environment).
- `tsx` is installed. Server modules start with `import "server-only"`. In vitest that import is aliased to a no-op mock. Under `tsx`, run with **`--conditions=react-server`** so `server-only` resolves to its empty build. tsx also resolves the `@/*` → `src/*` path alias.
- Scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

**How a step works** (`createStepHandler(deps)` in `src/server/step-handler.ts`):
- `StepDeps = { assess, speak, now, modelLabel? }`.
- **Request:** `StepRequest = { state: EngineState | null, event }`, where `state` is null only for `start`.
- **`start`:** creates the initial state (`startedAt = now()`), yields `move{intro}`, streams `speak({ move: intro, reason: "intro", … })`, then sets `phase: "problem"`.
- **Any other event:**
  1. `pre = state`. If the event is a `turn_complete`, append the student's transcript entry.
  2. `assessment` = `shouldAssess(pre, event, config, style, now)` ? `await assess({ config, style, state: pre, event, signal })` : `null`.
  3. `result = decide({ state, event, assessment, config, style, now })`.
  4. Yield `move{result.move, result.interrupt}`. If the move is `silent`, go straight to `done`.
  5. Otherwise stream `speak({ state: result.state, move, interrupt, reason: result.reason, studentText, … })`.
  6. Append the interviewer entry (`kind` is `"interjection"` if interrupting, else `"utterance"`), then yield `done{state, utterance}`.
- **`decide`'s rules**, all in `src/engine/fsm.ts`:
  - **Partials:** interject only if the assessment is `off_track` with confidence ≥ the style's `minConfidence`, the cooldown has elapsed since `lastInterjectAt`, and `words − turnWordBaseline ≥ minNewWords`.
  - **Canvas:** the same, without the word gate.
  - **`turn_complete`:**
    - time up → `wrap_up`
    - no assessment → `acknowledge`
    - all checkpoints hit → `probe` once, then `advance` or `wrap_up`
    - `off_track` with confidence ≥ 0.5 → `realign`
    - `stuck` → next hint, or advance when the hints are exhausted
    - otherwise → `acknowledge`
  - **`silence`:** at or above `silenceStuckMs` (20 000) it's treated as stuck.
  - **Checkpoint merge:** checkpoints from any assessment are merged in.
- **Style parameters:**
  - `supportive`: `minConfidence 0.8`, `cooldownMs 20000`, `minNewWords 12`
  - `rigorous`: `minConfidence 0.65`, `cooldownMs 12000`, `minNewWords 8`
  - Both configs: `timing: { maxMinutes: 25, silenceStuckMs: 20000 }`
- **`shouldAssess`** is false for silence and end, outside the problem phase, for a `turn_complete` when time is up, and for partials or canvas blocked by the cooldown or word gate.
- **`runStepRequest(request, { fetchImpl, callbacks })`** (`src/client/step-client.ts`) posts a step and enforces the stream protocol. The e2e test points `fetchImpl` at `(url, init) => handler(new Request("http://test" + url, init))`.
- **`fallbackUtterance({ config, state, move, reason })`** gives a deterministic interviewer line for any non-silent move.
- **`assess(args)`** (`src/server/assess.ts`) is the real assessor. It returns `Assessment | null` and never throws on model errors. It reads `MODEL_API_KEY` through `getServerEnv()`, which **throws a plain `Error` when the key is missing**.
- **`countWords(text)`** comes from `src/engine/fsm.ts`.
- **`Assessment`:** `{ status: "stuck"|"progressing"|"partial"|"correct"|"off_track", confidence 0..1, checkpointsHit: string[], misconceptionId: string|null, evidence: string }`.
- **`DecisionReason`** (`src/engine/types.ts`) includes `stuck`, `progress`, `off_track`, `interject_off_track`, `gated`, `silence_short`, `silence_stuck`, `solved_probe`, `solved_advance`, `solved_wrap_up`, `hints_exhausted_advance`, `hints_exhausted_wrap_up`, `time_up`, `closing`, `end`, `phase_inactive` and `assessor_unavailable`. `SpeakReason = DecisionReason | "intro"`.

## Constraints
- **Allowed files:**
  - new: `evals/scripts/*.json`, `src/eval/**`, `scripts/eval.ts`, `STAGE5_NOTES.md`, `tests/**`
  - modified: `package.json`, adding **only** one entry under `"scripts"`: `"eval": "tsx --conditions=react-server --env-file-if-exists=.env.local scripts/eval.ts"`. If your Node/tsx doesn't support `--env-file-if-exists`, use `--env-file=.env.local` and say so in `STAGE5_NOTES.md`.
- **Frozen, byte-for-byte** (the reviewer checks SHA-256): everything under `src/` outside `src/eval/`, plus `configs/`, `scripts/latency.ts`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts` and `package-lock.json`.
- **No new dependencies.** No permission/ACL tooling, and no tool output in the repo. Don't touch `.bridge/` or `AGENTS.md`.
- **No network** in tests, and don't run `npm run eval` with a key.
- **Add tests; don't delete or weaken any.** Per-file test names are compared.
- If anything is ambiguous, write the question in `STAGE5_NOTES.md` rather than guessing.

---

## Files to create

### 1. `src/eval/schema.ts` (isomorphic, pure: zod only)
```ts
export const LiveExpectSchema = z.object({
  status: z.array(z.enum(["stuck","progressing","partial","correct","off_track"])).min(1),
  misconceptionId: z.string().nullable().optional(),   // when present, must match exactly
});
export const ExpectSchema = z.object({
  move: z.object({
    type: z.enum(["intro","hint","realign","probe","acknowledge","advance","wrap_up","silent"]),
    rung: z.number().int().optional(),
    misconceptionId: z.string().nullable().optional(),
    probeIdx: z.number().int().optional(),
    toProblemIdx: z.number().int().optional(),
  }),
  interrupt: z.boolean().default(false),
  assessCalled: z.boolean(),
  reason: z.string().optional(),                // checked via the speak call; not allowed when move.type === "silent"
  state: z.object({
    phase: z.enum(["intro","problem","wrap_up","done"]).optional(),
    problemIdx: z.number().int().optional(),
    hintRung: z.number().int().optional(),
    checkpointsHit: z.array(z.string()).optional(),
    probesAsked: z.number().int().optional(),
    turnWordBaseline: z.number().int().optional(),
    lastInterjectAtMs: z.number().int().nullable().optional(),   // relative to session start
  }).optional(),
  interviewerKind: z.enum(["utterance","interjection"]).optional(),  // kind of the interviewer entry appended this step
});
export const ScriptStepSchema = z.object({
  atMs: z.number().int().positive(),
  event: /* EngineEventSchema minus start; partial events additionally carry `words: int` */,
  mock: AssessmentSchema.optional(),
  expect: ExpectSchema,
  live: LiveExpectSchema.optional(),
  note: z.string().optional(),
});
export const ScriptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), title: z.string().min(1), description: z.string().min(1),
  configId: z.string(), styleId: z.string(),
  steps: z.array(ScriptStepSchema).min(1),
});
```
**Refinements**, each with a clear message:
- `atMs` is strictly increasing across steps.
- `expect.assessCalled === true` ⇔ `mock` is present.
- `live` is only allowed when `assessCalled` is true, and **not** on `canvas` steps.
- For `partial` events, `words` must equal `countWords(event.text)`. You may reimplement `countWords` identically here: split on `/\s+/` and count the non-empty pieces.
- `reason` is not allowed when `expect.move.type === "silent"`.
- **Don't include `words` in the event sent to the API.** Strip it in the replay.

### 2. `src/eval/load-scripts.ts` (`import "server-only"`; node `fs`)
- `loadScripts(dir = <repo>/evals/scripts): Script[]` reads every `*.json` in the folder, sorted by filename, and parses each with `ScriptSchema`.
- It throws an error naming the file and the zod issue on the first invalid file.
- It throws if two scripts share an `id`.
- It throws if `configId`/`styleId` don't resolve via `getConfig`/`getStyle`.

### 3. `src/eval/replay.ts` (`import "server-only"`)
```ts
export const T0 = 1_700_000_000_000;
export interface StepOutcome {
  index: number;                 // -1 for the implicit start step, then 0..n-1
  move: Move; interrupt: boolean; utterance: string; state: EngineState;
  assessCalled: boolean; assessArgsStateTranscriptLength?: number;
  speakReason?: SpeakReason;     // present when speak was called
  interviewerKind?: "utterance" | "interjection";
  live?: { assessment: Assessment | null; latencyMs: number; error?: string };
}
export async function replayScript(
  script: Script,
  opts?: { live?: { assess: (args: AssessArgs) => Promise<Assessment | null> } }
): Promise<StepOutcome[]>;
```
- **Build a handler** with `createStepHandler(deps)`:
  - `now` returns `T0 + currentAtMs`. The implicit start uses `atMs` 0.
  - **`assess`** records the call for the current step and returns `step.mock`. If the step has no `mock`, throw `Error("Script <id> step <i>: assess was called but the step has no mock")`.
  - **In live mode,** `assess` also awaits `opts.live.assess(args)`, timed with `performance.now()`, and records the result. If that call throws (for example, no key), record `error: String(err)` and `assessment: null`. **Either way, return the mock.**
  - **`speak`** is an async generator yielding `fallbackUtterance({ config, state, move, reason }).match(/\S+\s*/g) ?? []` with **no delays**, recording `reason`.
  - `modelLabel` is undefined.
- **Drive every request through `runStepRequest`**, with `fetchImpl` pointed at the handler and callbacks capturing `move` and `interrupt`.
- **Steps:**
  1. Run the implicit `start` (index −1).
  2. Run each script step in order, sending `{ state: <previous done.state>, event: <event without words> }`.
  3. If the handler returns a non-200 response or the step client throws, rethrow with the script id and step index.
- `interviewerKind`: if the new `done.state.transcript` is longer than the previous one and its last entry is from the interviewer, use that entry's `kind`.

### 4. `src/eval/expect.ts` (pure)
```ts
export function checkScript(script: Script, outcomes: StepOutcome[]): string[]   // [] means pass
```
- **Implicit start:** the move is `intro`, `interrupt` is false, `assessCalled` is false, and `phase` is `"problem"`.
- **For each step `i`,** compare every field the script specifies:
  - `move.type`, plus every move field given (`rung`, `misconceptionId`, `probeIdx`, `toProblemIdx`)
  - `interrupt` (always checked; the default is false)
  - `assessCalled` (always checked)
  - `reason` against `speakReason`
  - every given `state` field (`lastInterjectAtMs` compared as `state.lastInterjectAt === null ? null : state.lastInterjectAt − T0`)
  - `interviewerKind`
- **Messages:** each mismatch gives exactly one message, in the form `"<scriptId> step <i> (<event type>): <field> expected <x>, got <y>"`.

### 5. `src/eval/score.ts` (pure)
```ts
export function scoreLive(expect: LiveExpect, actual: Assessment | null): { pass: boolean; why: string }
export function summarize(rows: { scriptId: string; index: number; eventType: string; pass: boolean; latencyMs: number }[]):
  { total: number; passed: number; passRate: number; p50: Record<"partial"|"turn_complete", number|null>; p95: Record<"partial"|"turn_complete", number|null> }
```
- **`scoreLive`:**
  - Pass when `actual !== null`, `expect.status.includes(actual.status)`, and either `misconceptionId` is `undefined` or it equals `actual.misconceptionId`.
  - The `why` string names the failing part: `"assessor returned null"`, `"status <x> not in [<list>]"` or `"misconception <x> != <y>"`. On a pass it is `"ok"`.
- **`summarize`:**
  - `passRate = passed / total`, or 0 when total is 0.
  - **Percentiles:** nearest-rank on the sorted latencies of that event type: `sorted[Math.ceil(p/100 * n) - 1]`, or `null` when there are none.

### 6. `scripts/eval.ts`: the live eval CLI (**build it; don't run it with a key**)
- If `process.env.MODEL_API_KEY` is missing or empty:
  - print exactly `MODEL_API_KEY is not set. The live eval is on hold until a key is available.`
  - `process.exit(2)` **before** importing or calling anything that touches the network
- **Otherwise:**
  1. `loadScripts()`. For each script, `replayScript(script, { live: { assess } })` using the real `assess` from `@/server/assess`.
  2. Score every step that has `live`.
  3. Print a table (script, step, event type, expected statuses, actual status, pass, latency ms), then the `summarize` output.
  4. Write the rows and the summary to `scripts/out/eval-<ISO timestamp>.json` (`scripts/out/` is already git-ignored).
  5. Exit `1` if `passRate < minPass`, else `0`. `--min-pass <0..1>` defaults to `0.8`.
- Also run `checkScript` on each live replay, since the decisions still follow the mocks. Exit `1` with the messages if any fail.

### 7. `evals/scripts/*.json`: the 8 scripted students
**Each step below is required exactly.** You write the student's words to fit the "student says" description: natural spoken English, first person, as an A-level student would talk.
- For every `partial`, the `text` must have **exactly the word count given**, and it is the **cumulative** text of the current turn. Each partial in a turn starts with the previous partial's text.
- Mock assessments must use the given status, confidence, `checkpointsHit` and `misconceptionId`. `evidence` is a short sentence of your choosing.
- `live` is given where shown. Steps without a `live` entry get none.
- All `atMs` values are milliseconds from the session start. The implicit `start` (→ intro) is **not** listed in the file.
- The canvas image for every canvas event is exactly `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`.

Notation:
- **mock** is written `status conf [checkpoints] misconception`, with `–` meaning `null`.
- **expect** is written `move · reason · interrupt · assessCalled · state checks · interviewerKind`.

#### `01-stuck-then-recovers.json`: maths-oxbridge, supportive
| # | atMs | event | student says | mock | expect | live |
|---|---|---|---|---|---|---|
| 0 | 30000 | turn_complete | doesn't know how to start | stuck 0.85 [] – | `hint{rung:0}` · stuck · false · true · hintRung 0, checkpointsHit [] · utterance | status [stuck] |
| 1 | 60000 | turn_complete | assumes √2 = p/q in lowest terms (coprime) | progressing 0.8 [c1] – | `acknowledge` · progress · false · true · checkpointsHit [c1] · utterance | [progressing, partial, correct] |
| 2 | 90000 | turn_complete | squares, gets p² = 2q², p even because an odd number squared is odd | progressing 0.85 [c2] – | `acknowledge` · progress · false · true · checkpointsHit [c1,c2] | [progressing, partial, correct] |
| 3 | 120000 | turn_complete | p = 2k gives q² = 2k², so q even, contradicting lowest terms | correct 0.9 [c3] – | `probe{probeIdx:0}` · solved_probe · false · true · probesAsked 1, checkpointsHit [c1,c2,c3] | [correct, progressing, partial] |
| 4 | 150000 | turn_complete | answers the √4 follow-up (the argument breaks because p² = 4q² doesn't force a contradiction) | correct 0.8 [] – | `advance{toProblemIdx:1}` · solved_advance · false · true · problemIdx 1, hintRung −1, checkpointsHit [], probesAsked 0 | — |

#### `02-right-first-time.json`: cs-oxbridge, rigorous
| # | atMs | event | student says | mock | expect |
|---|---|---|---|---|---|
| 0 | 120000 | turn_complete | complete pair-sum answer: brute force O(n²), binary search O(n log n), two pointers O(n) with why no pair is missed | correct 0.95 [c1,c2,c3] – | `probe{probeIdx:0}` · solved_probe · false · true · probesAsked 1 |
| 1 | 180000 | turn_complete | unsorted case: use a hash set, O(n) | correct 0.8 [] – | `advance{toProblemIdx:1}` · solved_advance · false · true · problemIdx 1 |
| 2 | 300000 | turn_complete | complete handshake proof (graph, degree sum = 2E, parity) | correct 0.95 [c1,c2,c3] – | `probe{probeIdx:0}` · solved_probe · false · true |
| 3 | 360000 | turn_complete | exactly one odd person is impossible, by the same parity argument | correct 0.8 [] – | `advance{toProblemIdx:2}` · solved_advance · false · true · problemIdx 2 |
| 4 | 480000 | turn_complete | complete heavy-coin answer (3–3–3 split, 2 weighings, 3-outcome bound, ⌈log₃ n⌉) | correct 0.95 [c1,c2,c3] – | `probe{probeIdx:0}` · solved_probe · false · true |
| 5 | 540000 | turn_complete | heavier-or-lighter variant: 12 coins in 3 weighings | correct 0.8 [] – | `wrap_up` · solved_wrap_up · false · true · phase wrap_up |
| 6 | 560000 | end | — | — | `silent` · (no reason) · false · false · phase done |

Live expectations: step 0 [correct]; step 2 [correct]; step 4 [correct]; none on the others.

#### `03-misconception-mid-answer.json`: maths-oxbridge, supportive
| # | atMs | event | student says | mock | expect | live |
|---|---|---|---|---|---|---|
| 0 | 20000 | partial, **8 words** | starts: suppose root two equals p over q | — | `silent` · false · **false** · turnWordBaseline 0, lastInterjectAtMs null | — |
| 1 | 26000 | partial, **20 words** | carries on squaring without ever assuming lowest terms | off_track 0.9 [] lowest-terms-missing | `realign{misconceptionId:"lowest-terms-missing"}` · interject_off_track · **true** · true · lastInterjectAtMs 26000, turnWordBaseline 20 · interjection | [off_track], misconceptionId lowest-terms-missing |
| 2 | 30000 | partial, **26 words** | adds six more words acknowledging the interruption | — | `silent` · false · false · turnWordBaseline 20, lastInterjectAtMs 26000 | — |
| 3 | 40000 | turn_complete | restates with p and q having no common factors | progressing 0.8 [c1] – | `acknowledge` · progress · false · true · turnWordBaseline 0, checkpointsHit [c1], lastInterjectAtMs 26000 · utterance | [progressing, partial, correct] |

#### `04-low-confidence-off-track.json`: cs-oxbridge, supportive
| # | atMs | event | student says | mock | expect | live |
|---|---|---|---|---|---|---|
| 0 | 20000 | partial, **15 words** | plans to check every pair, possibly including an element with itself | off_track 0.7 [] same-element-twice | `silent` · false · true · lastInterjectAtMs null, turnWordBaseline 0 | [off_track, progressing, partial] |
| 1 | 35000 | partial, **30 words** | continues; still ambiguous about pairing an element with itself | off_track 0.75 [] same-element-twice | `silent` · false · true · lastInterjectAtMs null | — |
| 2 | 45000 | turn_complete | concludes that `a[i] + a[i] = T` counts as a valid pair | off_track 0.6 [] same-element-twice | `realign{misconceptionId:"same-element-twice"}` · off_track · false · true · utterance | [off_track], misconceptionId same-element-twice |

#### `05-long-silence.json`: maths-oxbridge, rigorous
| # | atMs | event | mock | expect |
|---|---|---|---|---|
| 0 | 10000 | silence `ms: 8000` | — | `silent` · false · false · hintRung −1 |
| 1 | 40000 | silence `ms: 20000` | — | `hint{rung:0}` · silence_stuck · false · false · hintRung 0 · utterance |
| 2 | 70000 | silence `ms: 25000` | — | `hint{rung:1}` · silence_stuck · false · false |
| 3 | 100000 | silence `ms: 25000` | — | `hint{rung:2}` · silence_stuck · false · false |
| 4 | 130000 | silence `ms: 25000` | — | `hint{rung:3}` · silence_stuck · false · false |
| 5 | 160000 | silence `ms: 25000` | — | `advance{toProblemIdx:1}` · hints_exhausted_advance · false · false · problemIdx 1, hintRung −1 |

#### `06-rambling-off-topic.json`: cs-oxbridge, rigorous
| # | atMs | event | student says | mock | expect | live |
|---|---|---|---|---|---|---|
| 0 | 20000 | partial, **14 words** | drifts onto an unrelated topic (for example last weekend's football) | off_track 0.7 [] – | `realign{misconceptionId:null}` · interject_off_track · **true** · true · lastInterjectAtMs 20000, turnWordBaseline 14 · interjection | [off_track], misconceptionId null |
| 1 | 25000 | partial, **30 words** | keeps rambling | — | `silent` · false · false · lastInterjectAtMs 20000, turnWordBaseline 14 | — |
| 2 | 33000 | partial, **40 words** | still off topic | off_track 0.8 [] – | `realign{misconceptionId:null}` · interject_off_track · **true** · true · lastInterjectAtMs 33000, turnWordBaseline 40 · interjection | [off_track] |
| 3 | 45000 | turn_complete | gets back on track: proposes checking every pair, O(n²) | progressing 0.7 [c1] – | `acknowledge` · progress · false · true · turnWordBaseline 0, checkpointsHit [c1] | [progressing, partial, correct] |

#### `07-canvas-only-working.json`: cs-oxbridge, supportive
| # | atMs | event | mock | expect |
|---|---|---|---|---|
| 0 | 20000 | canvas | off_track 0.85 [] wrong-pointer-move | `realign{misconceptionId:"wrong-pointer-move"}` · interject_off_track · **true** · true · lastInterjectAtMs 20000, turnWordBaseline 0 · interjection |
| 1 | 30000 | canvas | — | `silent` · false · false · lastInterjectAtMs 20000 |
| 2 | 45000 | canvas | progressing 0.7 [c1] – | `silent` · false · true · checkpointsHit [c1] |
| 3 | 60000 | turn_complete; student says they now move the left pointer when the sum is too small, explain why no pair is skipped, and that it's O(n) | correct 0.9 [c2,c3] – | `probe{probeIdx:0}` · solved_probe · false · true · checkpointsHit [c1,c2,c3], probesAsked 1 |

Step 3 has live expectation [correct, progressing, partial]. Canvas steps have no live entry.

#### `08-ignores-hints.json`: maths-oxbridge, supportive
| # | atMs | event | student says | mock | expect | live |
|---|---|---|---|---|---|---|
| 0 | 30000 | turn_complete | still has no idea | stuck 0.8 [] – | `hint{rung:0}` · stuck · false · true | [stuck] |
| 1 | 60000 | turn_complete | doesn't follow the hint | stuck 0.8 [] – | `hint{rung:1}` · stuck · false · true | [stuck] |
| 2 | 90000 | turn_complete | still stuck | stuck 0.8 [] – | `hint{rung:2}` · stuck · false · true | [stuck] |
| 3 | 120000 | turn_complete | gives up on that idea | stuck 0.8 [] – | `hint{rung:3}` · stuck · false · true | [stuck] |
| 4 | 150000 | turn_complete | still can't do it | stuck 0.8 [] – | `advance{toProblemIdx:1}` · hints_exhausted_advance · false · true · problemIdx 1, hintRung −1 | [stuck] |
| 5 | 1501000 | turn_complete | starts on the odd-numbers problem | — | `wrap_up` · time_up · false · **false** · phase wrap_up, problemIdx 1 | — |
| 6 | 1520000 | turn_complete | says thanks | — | `acknowledge` · closing · false · false · phase wrap_up | — |
| 7 | 1530000 | end | — | — | `silent` · false · false · phase done | — |

---

## Tests (`vitest`; no network)

### `tests/eval-schema.test.ts`
- All 8 files in `evals/scripts/` load with `loadScripts()`: 8 scripts with unique ids.
- **Each refinement rejects a bad script** (build small inline scripts):
  - non-increasing `atMs`
  - `assessCalled: true` without a `mock`, and `assessCalled: false` with one
  - `live` on a canvas step, and `live` when `assessCalled` is false
  - a partial whose `words` doesn't match its text
  - `reason` on a silent move
  - an unknown `configId` or `styleId` (through `loadScripts` on a temp directory; use `fs.mkdtempSync` under the OS temp dir and clean it up)
  - duplicate ids

### `tests/regression.test.ts`: the deterministic suite
- **For each loaded script**, add an `it(script.id)` that runs `replayScript(script)` and asserts `checkScript(script, outcomes)` deep-equals `[]`.
- **Sanity tests** (so the checker can't silently pass):
  - Take `03-misconception-mid-answer`'s real outcomes and tamper with one at a time:
    - step 1 `interrupt` → false
    - step 1 `move.misconceptionId` → null
    - step 2 `assessCalled` → true
    - step 3 `state.turnWordBaseline` → 5
    - step 1 `interviewerKind` → `"utterance"`
    - step 1 `speakReason` → `"off_track"`
    - step 1 `lastInterjectAt` changed
  
  For each tampering, assert `checkScript` returns **exactly one** message mentioning that field.
  - The implicit-start check fails when the start outcome's move is tampered.
- **Replay invariants on every script:**
  - Every `assess` call received a state whose transcript length equals the **previous** `done.state.transcript.length` (the pre-append state). Record this in `assessArgsStateTranscriptLength`.
  - No `words` key reached the API (capture request bodies in the `fetchImpl` wrapper).

### `tests/eval-score.test.ts`
- **`scoreLive`:** pass; null actual; wrong status; misconceptionId match, mismatch and `undefined` (ignored); and expected `null` vs actual non-null. Check the exact `why` strings.
- **`summarize`:** pass rate (including total 0 → 0), nearest-rank p50/p95 for known arrays (for example latencies 100..1000 in steps of 100 → p50 500 and p95 1000), and `null` for an event type with no rows.

### `tests/eval-live-mode.test.ts`
- **`replayScript(script, { live: { assess: fakeLive } })`**, where `fakeLive` returns a chosen assessment after a small delay:
  - live results are recorded only for steps where `assessCalled` is true
  - `latencyMs ≥ 0`
  - the decisions still follow the **mock**: `checkScript` still returns `[]` even when `fakeLive` returns something different
- **Live call throws:** when `fakeLive` throws, the result is recorded as `error` with `assessment: null`, and the replay continues.

### `tests/eval-cli.test.ts`
- Spawn `node <repo>/node_modules/tsx/dist/cli.mjs --conditions=react-server scripts/eval.ts`, using `child_process.spawnSync` with `cwd` set to the repo and an `env` **without** `MODEL_API_KEY` (delete it from a copy of `process.env`).
- Assert the exit code is `2` and stdout includes the exact hold message.
- This must not touch the network.

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and a no-key `npm run build` all pass.
2. All 8 scripts pass deterministically, and the step tables above are implemented **exactly**. The reviewer will diff each JSON against these tables: atMs, event types, word counts, mocks, expects and live entries.
3. Running `npm run eval` without a key prints the hold message and exits 2. Nothing in the repo calls the live API during tests.
4. Every frozen file is byte-for-byte unchanged, and `package.json` gains only the `eval` script.
5. Every rule has a test that fails if it's changed. The reviewer will revert rules one at a time across `schema.ts`, `expect.ts`, `score.ts`, `replay.ts` and `scripts/eval.ts`, and will also edit script expectations to check that the suite catches them.
6. No test name is removed.

## Held (not part of this stage)
- **Running `npm run eval` against Meta** to measure assessor quality and latency on the 8 scripts. It needs `MODEL_API_KEY`, which is held.
