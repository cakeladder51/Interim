# Stage 7 review 2: add 7 tests (no code changes)

You're the external model, in a fresh session. Read `STATUS.md`, `stage-07-voice-io.md` (the brief) and this file. **The brief is correct. Don't change any app code in this pass.** If a step below fails, stop and write the failing test name and its output in `STAGE7_NOTES.md`. Don't loop.

## What passed in round 1's fixes (keep all of it)
- **Every fix in `stage-07-review.md` is done correctly:** B1, R1, R2, B2.1–B2.6, S1, S2, H1–H3 and A1.
- **Test files:** the three T1 copies are byte-identical to the reviewer's files, and G1/G2 are present (G1 without its outer wrapper `describe`, which is fine).
- **Checks:**
  - `tsc` passes, `eslint` reports 0 warnings, and the no-key build passes with `/api/tts`.
  - **`npx vitest run` exits 0: 687 tests, no Errors line.**
  - No test name was lost since round 1.
- **Bundle and offline:**
  - The bundle has no `ws`/OpenAI code (the positive control was found).
  - Offline under `next dev`: TTS and relay-token return 503 with `no-store`, the worklet is served, and the 12-step text interview passes.
- **Revert checks: 149/163 caught in this sweep.**
  - 6 of the misses are documented equivalents: two redundant guards, a no-op second reject, and similar cases.
  - **The other 8 were missed only because a test didn't exist yet.** The tests below cover them, which brings the total to 157/163; the reviewer has verified that each new test fails on its revert and passes on your current code.

## T1. Re-copy two test files (verbatim; overwrite the whole file)
| From (read-only) | To | What's new |
|---|---|---|
| `agent-os/review/stage-07-tests/voice-tts-player.test.ts.txt` | `tests/voice-tts-player.test.ts` | `describe("9. Stale results (review 2)")`: audio that resolves just before `stop()` must never play |
| `agent-os/review/stage-07-tests/voice-controller.test.ts.txt` | `tests/voice-controller.test.ts` | `describe("12. Stale events and suppression edges (review 2)")`, 6 tests: (1) events from a disabled session; (2) a close from an earlier session after a re-enable; (3) a reconnect that resolves after `disable()`; (4) a partial while the interviewer is silent mid-stream; (5) `done` after `disable()`; (6) `speakNow` lifting a `stopSpeaking` suppression |

- Everything above the new `describe` blocks is unchanged from round 1.
- The new tests already pass on your current code. **If one fails, don't edit the test or the app code;** record it in `STAGE7_NOTES.md`.

## Constraints for this pass
- **Allowed to change:** `tests/voice-tts-player.test.ts`, `tests/voice-controller.test.ts` and `STAGE7_NOTES.md`. **Nothing else.**
- The reviewer has recorded these hashes and will re-check them: relay-client `455e2a2d`, tts-player `3009dd90`, voice-controller `ed6ccd4f`, browser-audio `9e74711f`, tts-handler `914261a1`, the TTS route `46d85f23`, InterviewScreen `921eb254`. Every other frozen file is covered by STATUS.

## Acceptance
1. Both files are byte-identical to their `.txt` sources.
2. **`npx vitest run` exits 0 with no Errors / "Unhandled Rejection" line: 694 tests** (687 + 1 + 6).
3. `npx eslint --max-warnings=0` and `npx tsc --noEmit` pass.
4. `STAGE7_NOTES.md` gets one line: "review-2: copied the two test files; 694 pass".
