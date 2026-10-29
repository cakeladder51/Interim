# Stage 9 Implementation Notes

## What Was Built

Stage 9 implements the Feedback report feature (A6, B7) as specified in `stage-09-feedback.md`.

### Files Created

1. **`src/shared/feedback-protocol.ts`** - Shared types for feedback request and response
   - `FEEDBACK_MAX_BODY_BYTES = 1_000_000`
   - `FeedbackRequestSchema` and `FeedbackViewSchema` with types

2. **`src/server/feedback.ts`** - Server-side feedback generation
   - `FEEDBACK_TIMEOUT_MS = 20_000`
   - `FeedbackInvalidError` class
   - `normalizeText()` - trims and collapses whitespace
   - `feedbackSystemPrompt()` - exact prompt for model
   - `buildFeedbackMessages()` - constructs messages array
   - `toFeedbackView()` - validates report against rubric
   - `noAnswerView()` - feedback when no student entries
   - `generateReport()` - calls chatJSON with Report schema

3. **`src/server/fake-feedback.ts`** - Offline fake feedback
   - `FAKE_FEEDBACK_DELAY_MS = 300`
   - `fakeReport()` - deterministic report based on transcript length
   - `fakeGenerate()` - async version with delay and abort support

4. **`src/server/feedback-handler.ts`** - HTTP handler
   - `FEEDBACK_ATTEMPTS = 2`
   - `FEEDBACK_RETRY_DELAY_MS = 400`
   - `createFeedbackHandler()` - implements H1-H8 rules
   - Handles payload size, JSON parsing, schema validation
   - Retries on `FeedbackInvalidError` and retryable `MetaError`
   - Returns 502 on failure with limited logging

5. **`src/server/feedback-deps.ts`** - Dependency selection
   - `selectFeedbackDeps()` - picks fake when `INTERIM_FAKE_MODEL=1` and not production

6. **`src/app/api/feedback/route.ts`** - Next.js API route
   - 2-line route file exporting `POST`

7. **`src/client/feedback-client.ts`** - Client-side feedback fetching
   - `FeedbackError` class
   - `fetchFeedback()` - C1-C3 rules for HTTP calls
   - `describeFeedbackError()` - user-friendly error messages
   - `formatAt()` - formats ms as M:SS
   - `FeedbackSnapshot` type for runner state
   - `createFeedbackRunner()` - manages fetch lifecycle with R1-R6 rules

8. **`src/app/interview/FeedbackPanel.tsx`** - React component
   - Shows loading, ready (scores, strengths, improvements, keyMoments), or failed state
   - Failed state shows transcript with retry button

9. **`src/app/interview/InterviewScreen.tsx`** - Modified (3 edits only)
   - Added FeedbackPanel import
   - Changed ended block className
   - Replaced placeholder with FeedbackPanel

### Test Files Created

1. **`tests/feedback-view.test.ts`** - Tests for toFeedbackView, noAnswerView, normalizeText, buildFeedbackMessages, generateReport
2. **`tests/fake-feedback.test.ts`** - Tests for fakeReport with various transcript lengths, fakeGenerate timing, selectFeedbackDeps
3. **`tests/feedback-route.test.ts`** - 17 tests for createFeedbackHandler covering all scenarios
4. **`tests/feedback-client.test.ts`** - Tests for fetchFeedback, describeFeedbackError, formatAt, createFeedbackRunner
5. **`tests/e2e-feedback.test.ts`** - End-to-end test with real step handler + feedback handler

## Verification

- `npm run typecheck` - ✅ Passes
- `npm run lint` - ✅ Passes (0 errors, 0 warnings)
- `npm test` - ✅ Passes (850 tests, no Errors line, exit code 0)
- `npm run build` - ✅ Passes, route `/api/feedback` listed

## Deviations

None - implementation follows the brief exactly.

## Notes

- The `generateReport` test in `feedback-view.test.ts` dynamically imports the module after setting env vars, as required for `getServerEnv` caching.
- The feedback runner in `feedback-client.ts` attaches rejection handlers immediately (R6) to avoid unhandled rejections.
- The handler logs only `attempts` and `code` on failure - no transcript text, quotes, or keys.
- All test vectors match the brief exactly.

## Review 1 fixes

- **B1:** Added `if (request.signal.aborted) break;` after retry wait in feedback-handler.ts to prevent second attempt after abort during sleep.
- **T1:** Copied reviewer test file `agent-os/review/stage-09-tests/feedback-review.test.ts.txt` to `tests/feedback-review.test.ts` byte-for-byte (23 tests).
- **T2:** Changed tautological assertion in test 3 from `FEEDBACK_RETRY_DELAY_MS` to literal `400`, removed unused import.
