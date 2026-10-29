# Stage 3 review: fixes required (handoff to the external model)

Reviewed on 2026-10-27.

## What passed
- Typecheck, lint (0 warnings), tests (223/223), and a build with no `MODEL_API_KEY` set.
- **Frozen files verified by hash:**
  - `src/engine/fsm.ts` is `8e4d2880…0426`.
  - `configs/` still match the Stage 2 brief exactly.
- **Allowed files:** only allowed files changed.
- **Prompts and fallbacks are correct, word for word.** A parser read the brief's code blocks and tables, filled in real config values for both configs, and compared the result with what `prompts.ts` produces: **532 checks, 0 mismatches**. No speak message for any move contains a `solutionSketch`.
- **`assess.ts`, `speak.ts`, `step-handler.ts` and `route.ts`** match the brief on a careful read.
- **The Stage 1 temporary reverts on `meta.ts` are all still caught.**

## Problem: the tests don't guard many rules (acceptance criterion 6)
94 temporary reverts were run across the five Stage 3 source files, one at a time, with the files restored byte for byte afterwards.
- **65 were caught; 28 weren't; 1 couldn't be applied** (see the note at the end).
- Two of the 28 are equivalent mutants (see the note), leaving **26 real test gaps**.
- **The source code is correct, so this pass changes tests only.**

## Constraint for this pass
- Change only `tests/prompts.test.ts`, `tests/assess.test.ts`, `tests/speak.test.ts` and `tests/step-route.test.ts`.
- **No source file may change.** The reviewer will hash `src/` and `configs/`.

## Root causes and fixes

### T1. Prompt tests check fragments with `toContain`, so most wording and indexing changes pass (`tests/prompts.test.ts`)
These reverts all went uncaught:
- **Assess system message:** changed the off_track meaning; changed "Use 0.8 or more" to 0.9.
- **Speak system message:** "at most 25 words" changed to 30; persona dropped; tone dropped.
- **Speak transcript:** the transcript count changed from 6 to 8.
- **Grounding rows:** the intro wording; the hint using rung 0 instead of `move.rung`; the realign-known wording; the probe using index 0 instead of `move.probeIdx`; the "Do not give new information." sentence dropped from acknowledge/progress; the wrap-up "other" wording.
- **Fallbacks:** the intro wording; the hint using rung 0.

**Fix: assert complete strings with `toBe`, written out as literals in the test file.** Don't rebuild them with the same template code; copy the text from the brief and interpolate config values by hand. Specifically:
1. **Assess system message:** the full exact string for `maths-oxbridge` problem index 1 (`sum-of-odds`), once with `checkpointsHit: []` and once with `["c1", "c2"]`.
2. **Speak system message:** the full exact string for the `rigorous` style, once with `interrupt: false` and once with `interrupt: true`.
3. **Speak user message:** the full exact string for **every one of the 12 grounding rows**. Use a 7-entry transcript so the "last 6" window is visible (the first entry must be absent). Do this once with `studentText: null` and once with a non-null value for one row.
   - **Use non-zero indices** so hard-coded indices are caught: `hint{rung: 2}`, `probe{probeIdx: 1}`, and a realign whose misconception is the **second** one in the problem, all with `state.problemIdx: 1`.
4. **Fallbacks:** the exact string for **every one of the 12 rows**, using the same non-zero indices as item 3.

### T2. Tests compare against the exported constants instead of literal values (`tests/speak.test.ts`, `tests/assess.test.ts`)
`expect(...max_tokens).toMatchObject({ max_tokens: SPEAK_MAX_TOKENS })` still passes if the constant changes. These reverts went uncaught:
- `SPEAK_MAX_TOKENS` 200 → 250, and `SPEAK_MAX_TOKENS_INTERRUPT` 60 → 80
- first-token timeout 4000 → 5000, and total timeout 12000 → 15000
- `ASSESS_TIMEOUT_LIVE_MS` 3500 → 4500, and `ASSESS_TIMEOUT_TURN_MS` 8000 → 9000
- `schemaName` `"Assessment"` → anything else

**Fix:**
- **speak:** assert the literals `max_tokens: 60` and `max_tokens: 200`. Also add `expect(SPEAK_MAX_TOKENS).toBe(200)` and `expect(SPEAK_MAX_TOKENS_INTERRUPT).toBe(60)`.
- **Speak timeouts:**
  - Spy on `chatStream` (for example `vi.mock("../src/lib/meta", async (orig) => ({ ...(await orig()), chatStream: vi.fn(...) }))`, or `vi.spyOn` on the module namespace) and assert it was called with `firstTokenTimeoutMs: 4000` and `totalTimeoutMs: 12000`.
  - Or verify timing behaviourally with fake timers: no timeout at 3999 ms, timeout at 4000 ms.
- **assess:** assert `expect(ASSESS_TIMEOUT_LIVE_MS).toBe(3500)` and `expect(ASSESS_TIMEOUT_TURN_MS).toBe(8000)`. Also spy on `chatJSON` and assert, for each event type, that it gets the right `timeoutMs`, `retry` and `schemaName: "Assessment"`. A behavioural check with fake timers is also fine.

### T3. Speak error rethrow is untested (`tests/speak.test.ts`)
Replacing the final `throw err` with `return` (swallowing non-Meta errors) passed all tests.

**Fix:** a fake client whose stream throws a plain `Error("boom")` (not a `MetaError`) → `speak` rejects with that error.

### T4. Step handler gaps (`tests/step-route.test.ts`)
- **Interviewer and student `at` values are never non-zero.** Every test uses `now === startedAt`, so `at = now − startedAt` is indistinguishable from `at = 0` or `at = now`. Setting the interviewer `at` to 0 passed all tests.
  - **Fix:** use `startedAt: 1_000_000` and `now: () => 1_007_500` for non-start events, and assert both the student and interviewer entries have `at === 7500`.
- **The `studentText` for partials isn't checked.** Making it `null` for partials passed.
  - **Fix:** in the interjection-partial test, assert `speak` was called with `studentText` equal to the partial's text. In the silence test, assert `studentText: null`.
- **The "no empty transcript entry" rule isn't tested** (it passed with empty entries appended, for start and for other events).
  - **Fix:** `speak` yields nothing for a non-silent move. For both a `start` event and a `turn_complete`, assert `done.utterance === ""` and that no interviewer entry was appended. On `start`, the transcript stays empty and the phase is still set to `"problem"`.
- **The `Cache-Control` header isn't asserted.**
  - **Fix:** assert `cache-control === "no-cache, no-transform"` on a streaming response.

## Equivalent or unreachable reverts (no test needed)
- **`speak.ts` "abort check removed":** `chatStream` already returns silently, without throwing, when the caller's signal aborts. So the `signal?.aborted` branch in speak's `catch` can't be reached through `chatStream`. Keep the guard; no test is required.
- **`step-handler.ts` abort check inside the speak loop:** the revert anchor didn't match. That check is backed up by the outer `if (closed || signal.aborted) break` in the stream loop, and the existing abort test covers the behaviour.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and a no-key `npm run build` all pass.
- Each of the 26 gaps above makes at least one test fail when its rule is reverted. The reviewer will rerun the same 94 reverts.
- `src/`, `configs/` and `package*.json` are byte-for-byte unchanged. Only the four test files listed above may change.
