# Stage 9 review 1: Feedback report (fix list for the external model)

You're starting in a fresh session. Read `stage-09-feedback.md` (the brief) first, then this file. **The brief is correct.** Never edit an expected value to make a test pass. If something still fails after these fixes, stop and write it in `STAGE9_NOTES.md`.

## What passed (no action)
- **Scope.** Only the brief's allowed files changed. Every frozen file is byte-identical. `InterviewScreen.tsx` reverses to `0789eeab` once the 3 §7 edits are undone, so it has exactly those edits. The 8 reviewer test copies from Stages 7 and 8 are still byte-identical.
- **Checks.** tsc 0, eslint 0/0, and the no-key build lists `/api/feedback`. vitest exits 0 with 850 tests, and no test names were lost against the 788-test Stage 8 baseline.
- **Code.**
  - V1–V6, the exact prompt, `noAnswerView`, `fakeReport`/`fakeGenerate`, `selectFeedbackDeps`, H1–H8, C1–C3, `describeFeedbackError`, `formatAt`, R1–R6 and `FeedbackPanel` all match the brief.
  - Client files import nothing from `src/server`, `src/lib` or `src/config/load`.
  - `start` never emits, so no state is set synchronously inside an effect.
- **Bundle.** `.next/static` contains none of `Model solution`, `admissions interviewer writing feedback` or `Return a JSON object with`. The positive control, `Preparing your feedback`, is found.
- **Offline probe** (`agent-os/review/stage-09-offline.mjs`, localhost only):
  - Under `next dev` with `INTERIM_FAKE_MODEL=1`:
    - a done state returns 200 with the fake report (`modelLabel: "fake"`, scores 1111, quote normalized)
    - an unfinished state returns 400 `not_finished`
    - no student lines returns `noAnswerView` plus `modelLabel: "fake"`
  - Under `next start`, the fake is ignored: the no-answer response has no `modelLabel`.
  - Every response has `Cache-Control: no-store`. No transcript text or key name appears in the server logs.
- **Accepted as written (no change):**
  - H4 catches only `ConfigError`. That's equivalent, because `getConfig`/`getStyle` throw nothing else.
  - The key-moment quotes use `&ldquo;`/`&rdquo;`, which render the same characters.
  - An aborted request still logs `Interim: feedback failed` once (for example, the StrictMode double mount under `next dev`). This follows H8 as written.

## Fixes

### B1: the handler retries after an abort that happens during the retry wait (bug)
H7 checks for an abort only when an attempt throws. If the request is aborted during the 400 ms `sleep`, the loop goes on and calls `generate` a second time with an already-aborted signal.

**Reproduced:** the reviewer test "B1: an abort during the retry wait stops the second attempt" fails on your code with `expected "spy" to be called 1 times, but got 2 times`.

**Fix** in `src/server/feedback-handler.ts`: add exactly one line right after the sleep, with the same 10-space indentation. Change nothing else in the file.
```ts
        if (retryable && !isLastAttempt) {
          await sleep(FEEDBACK_RETRY_DELAY_MS);
          if (request.signal.aborted) break;
          continue;
        }
```
With this change, the file's SHA-256 starts with `2be0d88e`. It starts with `c33a3216` now.

### T1: the tests miss 39 of 167 temporary reverts; add the reviewer's test file
With your tests, the reverts `agent-os/review/stage-09-mutants.mjs` makes were caught **127/167**:

| Group | Caught |
|---|---|
| view | 41/56 |
| fake | 18/23 |
| handler | 33/45 |
| client | 35/43 |

**Uncaught:**
- **V4:** the caps of 5, and improvements being trimmed or having empty items dropped
- **V5:** notes being trimmed, the stable order of moments with equal `at`, the cap of 5 and the cap applying after the sort
- `noAnswerView`/`fakeReport` when a config lists its levels highest first; `fakeReport` with 0 student lines
- `fakeGenerate`'s 300 ms delay
- `generateReport`'s `retry: false`, its 20 s timeout and the caller's `signal`
- **Handlers:** H5 running before H6, and the headers on error and no-answer responses
- **Retries:** an abort seen on `request.signal`, the exact 400 ms wait, no wait after the last attempt, and the default `sleep`
- **`fetchFeedback`:** the custom `endpoint` and both abort-rethrow conditions
- **The runner:** a stale or aborted run's failure must emit nothing, the run must be cleared after a failure, a current-run `AbortError` must emit nothing, and `retry()` must reuse the same state object

**Fix:** copy `agent-os/review/stage-09-tests/feedback-review.test.ts.txt` to **`tests/feedback-review.test.ts`**, byte for byte (SHA-256 starts with `c0760525`).
- Don't edit it, reformat it or "fix" it.
- It has 23 tests. Once B1 is in, all 23 pass.
- The reviewer has checked that it passes tsc and eslint.

With B1 and this file in place, the reverts are caught **166/168**. The 2 remaining are documented equivalents.

### T2: one tautological assertion in `tests/feedback-route.test.ts`
Test 3 asserts `expect(sleep).toHaveBeenCalledWith(FEEDBACK_RETRY_DELAY_MS);`, which compares the constant with itself, so it would pass whatever the delay is. The brief asks for literal values.
- Change that line to `expect(sleep).toHaveBeenCalledWith(400);`.
- Then remove `FEEDBACK_RETRY_DELAY_MS` from that file's import, because it's no longer used. It's used only on that line now.
- Change nothing else in the file. Don't rename any test.

## Constraints for this pass
- **Files you may change:**
  - `src/server/feedback-handler.ts` (only the B1 line)
  - `tests/feedback-route.test.ts` (only the T2 assertion line and the import)
  - `tests/feedback-review.test.ts` (new; byte-identical copy)
  - `STAGE9_NOTES.md` (append a "Review 1 fixes" section)
- **Everything else is frozen.** That includes every other Stage 9 file at its round-1 hash:
  - `feedback-protocol` `04461115`
  - `feedback` `0cde8265`
  - `fake-feedback` `74cbdff6`
  - `feedback-deps` `7a827430`
  - route `4db3ea0d`
  - `feedback-client` `e28b6f28`
  - `FeedbackPanel` `87e72031`
  - `InterviewScreen` `ee37d724`
  - every other test file
  - everything under `agent-os/`
- No new dependencies. Never call an external API, and never read or add keys.
- Don't delete or weaken any test. Test names are compared file by file.

## Acceptance
1. `src/server/feedback-handler.ts` hashes to `2be0d88e…`. `tests/feedback-review.test.ts` is byte-identical to `agent-os/review/stage-09-tests/feedback-review.test.ts.txt`.
2. The only change to `tests/feedback-route.test.ts` is T2: one assertion line and the import.
3. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 problems, and `npx next build` with no keys set passes and lists `/api/feedback`.
4. **`npx vitest run` exits 0 with no `Errors` or "Unhandled Rejection" line.** It runs 873 tests (850 + 23), and no test name disappears.
5. `STAGE9_NOTES.md` has a short "Review 1 fixes" section listing B1, T1 and T2.
