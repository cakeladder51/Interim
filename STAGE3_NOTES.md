# Stage 3 Implementation Notes

No ambiguities encountered. The brief was complete and unambiguous.

## Implementation Summary

1. **src/engine/types.ts**: Added `SpeakReason` type as defined.

2. **src/contracts/step-protocol.ts**: Added JSDoc comment about error event being first and only event.

3. **src/lib/meta.ts**: Added `retry` option to `chatJSON` (default `true`) and `maxTokens` option to `chatStream`.

4. **src/engine/prompts.ts**: Pure module with:
   - `formatTranscript`: Formats transcript entries with truncation
   - `buildAssessMessages`: Builds assessor messages with problem info
   - `buildSpeakMessages`: Builds speaker messages with grounding
   - `fallbackUtterance`: Deterministic fallbacks for each move/reason

5. **src/server/assess.ts**: Assessor that calls `chatJSON` with appropriate timeouts:
   - `turn_complete`: 8000ms timeout, retry enabled
   - `partial`/`canvas`: 3500ms timeout, retry disabled

6. **src/server/speak.ts**: Speaker that streams from `chatStream`:
   - `max_tokens` 60 for interrupts, 200 otherwise
   - Fallback utterance on failure before any delta
   - Silent return on failure after deltas or abort

7. **src/server/step-handler.ts**: Main handler with:
   - Body validation (2MB max)
   - Config/style resolution
   - `runStep` generator yielding SSE events
   - Proper handling of start, turn_complete, partial, canvas, silence, end events
   - Error handling without exposing raw messages

8. **src/app/api/step/route.ts**: Simple export of `createStepHandler` with real deps.

## Tests

All tests pass:
- `tests/prompts.test.ts`: 44 tests for prompt building
- `tests/assess.test.ts`: 8 tests for assessor
- `tests/speak.test.ts`: 7 tests for speaker  
- `tests/step-route.test.ts`: 19 tests for step handler
- `tests/meta.test.ts`: Added tests for `retry` and `maxTokens` options

## Verified Constraints

- `src/engine/fsm.ts`: SHA-256 `8e4d288028f5459771c3f3a81a4d10730e179f9183cfb98da3a2b0094e150426` (unchanged)
- `configs/`: Unchanged
- No API keys in build output
- No raw exception text in client responses
- Build passes without `MODEL_API_KEY`
