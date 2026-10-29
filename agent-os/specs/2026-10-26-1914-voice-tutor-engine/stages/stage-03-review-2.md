# Stage 3 re-review 2: restore deleted tests (handoff to the external model)

Re-reviewed on 2026-10-27.

## What passed
- Typecheck, lint (0 warnings), tests (221/221) and a no-key build.
- **No source changes:** only the four test files changed, and `src/` and `configs/` are untouched. `fsm.ts` is still `8e4d2880…0426`.
- **T1–T4 are verified.** The 94 reverts were rerun: **88 caught**. Every gap from `stage-03-review.md` is now guarded, including the full literal grounding and fallback strings, the literal constants, the rethrow, the non-zero `at` values, `studentText`, the empty-utterance rule and `Cache-Control`.

## Problem: the rewrite deleted required tests, and coverage went backwards
The test count fell from 223 to 221 because `tests/prompts.test.ts` went from 44 to 33 tests. The rewrite **removed** tests the brief requires. As a result, **4 reverts that were caught last round are now uncaught**:

| Revert (now uncaught) | Last round |
|---|---|
| Assess user message uses `formatTranscript(state.transcript, 10)` instead of 12 | caught |
| Partial event line loses "Judge only what they have said; an unfinished sentence is not an error." | caught |
| turn_complete event line says "has finished speaking" instead of "has just finished speaking" | caught |
| Canvas `image_url.url` is set to `""` instead of `event.image` | caught |

The **purity test** for `prompts.ts` (deep-freeze the inputs; nothing throws; inputs unchanged) was also deleted. The brief requires it.

## Constraint for this pass
- **Change only `tests/prompts.test.ts`.**
- **Add tests; don't delete or weaken any existing test.** The reviewer will compare test names, and the count must go **up** from 33.
- No source file may change.

## Fixes

### R1. Restore the `buildAssessMessages` user-message tests, as full literal strings
Use `maths-oxbridge`, `state.problemIdx: 1`, and a **13-entry** transcript so the 12-entry window is visible (the first entry must be absent from the output). Assert with `toBe`, written out as literals:
1. **partial** (`text: "so the nth odd number is 2n plus 1"`): the full user message string.
2. **turn_complete** (`text: "that is my answer"`, `source: "voice"`): the full user message string.
3. **canvas** (`image: "data:image/png;base64,AAAA"`): `content` is an array of exactly two parts.
   - Part 0 is `{ type: "text", text: <full literal string> }`.
   - Part 1 is `{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }`.
   - Assert the whole array with `toEqual`.
4. For partial and turn_complete, assert `typeof content === "string"`.

### R2. Restore the purity test
- Write a recursive `deepFreeze` helper.
- For each of these, freeze the inputs (config, style, state including its transcript array, event and move) and take a `structuredClone` snapshot first:
  - `buildAssessMessages` for partial, turn_complete and canvas
  - `buildSpeakMessages` for every grounding row
  - `fallbackUtterance` for every row
- Assert that nothing throws **and** that the frozen objects still deep-equal their snapshots.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and a no-key `npm run build` all pass.
- All four reverts in the table above make a test in `tests/prompts.test.ts` fail.
- Every test name present in `tests/prompts.test.ts` now is still present, and the test count rises above 33.
- Only `tests/prompts.test.ts` has changed. `src/`, `configs/` and the other test files are byte-for-byte unchanged.
