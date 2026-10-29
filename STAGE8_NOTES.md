# Stage 8 Implementation Notes

## What was built

Stage 8 implements mid-answer interjections and canvas integration (M3).

### New files created
1. `src/client/background-runner.ts` - A wrapper around the request runner that handles background step requests (partial/silence/canvas) and dispatches bg_* actions. Calls `onSettled(move)` exactly once per run.

2. `src/client/turn-controller.ts` - Pure time-based controller for debouncing partials (min 8 new words or 3s max wait), silence prompts (20s first, 10s repeat, max 2 prompts), and canvas snapshots (4s idle, hash dedup, 1.5M char cap). Uses FNV-1a hash for deduplication.

3. `src/app/interview/Scratchpad.tsx` - Client component for drawing on a canvas. Fills white on mount, sends PNG data URIs on stroke completion.

4. Tests:
   - `tests/turn-controller.test.ts` - V15 test vectors for all priorities and edge cases
   - `tests/background-runner.test.ts` - 8 tests for the background runner
   - `tests/voice-interjection.test.ts` - 9 tests for interjection barge-in behavior
   - `tests/e2e-mid-answer.test.ts` - 7 e2e tests with the real step handler

### Modified files
1. `src/client/interview-model.ts` - Added `BackgroundEvent` type, `background` field to `InterviewView`, bg_* action types, `buildBackgroundRequest` and `mapBackgroundAction` functions.

2. `src/client/use-interview.ts` - Added `viewRef` for synchronous view mirroring, `sendBackground` callback, background runner alongside foreground runner, and aborts background on foreground requests.

3. `src/client/voice/voice-controller.ts` - Added `interjectBaseline` state and `INTERJECTION_BARGE_IN_WORDS = 4` constant. Relaxed barge-in threshold during interjections, and new handlers for `bg_move`, `bg_failed`, `bg_request` actions.

4. `src/app/interview/InterviewScreen.tsx` - Integrated turn controller, idle state tracking, partial/canvas handling, and scratchpad component.

5. `tests/interview-model.test.ts` - Added background steps tests for bg_* actions, `mapBackgroundAction` mappings, and `buildBackgroundRequest`.

## Review 1

Applied the following fixes exactly as specified in `stage-08-review.md`:

### B1. Scratchpad tap-without-movement fix
- Added `drewRef` to track whether this stroke drew a segment
- Set `drewRef.current = false` in `handlePointerDown`
- Set `drewRef.current = true` after `ctx.stroke()` in `handlePointerMove`
- Changed `handlePointerUpOrCancel` to only call `onChange(getImage)` when `drewRef.current` is true

### D1. Removed stray `failed` edit
- Removed `interjectBaseline = null;` from `case "failed"` in voice-controller.ts
- Kept `interjectBaseline = null` in `request`, `bg_move`, `bg_failed`, `disable()` and the barge-in check

### T1. Replaced test files byte-for-byte
Copied each test file from `agent-os/review/stage-08-tests/*.txt` to `tests/`:
- `background-runner.test.ts` - SHA-256: F76A95019AB4984A8B5852375FC4D6A324CC7547C4F949310FB5C0B13B489918
- `voice-interjection.test.ts` - SHA-256: FCF08D6331E5330FAE283CE1CF5C495255A8CBDBC81678191F774E023FA045CA
- `e2e-mid-answer.test.ts` - SHA-256: A8EABEC9656CA67282335446F0E9252EB6E537E820EF0512EE3B094E5FE3C6E1
- `turn-controller.test.ts` - SHA-256: 6BF8228161B23D52A80B2F17D2128FC259156AA3789CC713C1EBB72DF98D481C
- `interview-model.test.ts` - SHA-256: 1B7E7E9B2AB74585125C7FD7E5830A1E6A82FB21EE6B83704EE4007149F45093

## Checklist
- [x] `npm run typecheck` passes
- [x] `npm run lint` reports 0 warnings
- [x] `npm test` exits 0 (788 tests)
- [x] `npm run build` passes
- [x] All V1-V15 test vectors pass
- [x] e2e-mid-answer tests pass
- [x] voice-interjection tests pass
