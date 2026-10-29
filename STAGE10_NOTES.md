# Stage 10 Notes: Recording

## What was built

1. **`src/client/recording/recording-format.ts`** - Pure helper functions for MIME type selection, file extensions, timestamps, and byte formatting.

2. **`src/client/recording/recording-session.ts`** - DOM-free, React-free recording session state machine. All I/O is injected via `RecordingDeps`. Manages:
   - Permission requests (mic and tab) in correct synchronous order before any `await`
   - Audio mixer creation (mic → AudioContext → MediaStreamDestination)
   - TTS playback tap into the mix via `setPlaybackTap`
   - MediaRecorder lifecycle for audio and video
   - Stop-sharing detection for video tracks
   - File building with correct naming and MIME type handling

3. **`src/client/recording/browser-recording.ts`** - Browser-specific implementation of `RecordingDeps` that calls `getUserMedia` and `getDisplayMedia`.

4. **`src/app/interview/InterviewGate.tsx`** - Consent dialog shown before interview starts. Handles:
   - Audio and video checkboxes
   - Permission prompts inside the click handler
   - Session lifecycle (dispose on unmount)

5. **`src/app/interview/RecordingBadge.tsx`** - Displays recording status in the header (e.g., "Recording audio and video") with any notices.

6. **`src/app/interview/RecordingDownloads.tsx`** - Shows download links for the recordings on the ended screen.

7. **Edits to existing files:**
   - `src/client/voice/browser-audio.ts`: Added `setPlaybackTap` and the tap connection in `playAudioBuffer`
   - `src/app/page.tsx`: Updated the text about recording
   - `src/app/interview/page.tsx`: Render `InterviewGate` instead of `InterviewScreen`
   - `src/app/interview/InterviewScreen.tsx`: Added `recording` prop and render `RecordingBadge` / `RecordingDownloads`

8. **Test files** (byte-identical copies from reviewer):
   - `tests/recording-session.test.ts` (24 tests)
   - `tests/recording-format.test.ts` (5 tests)
   - `tests/recording-tap.test.ts` (2 tests)

## Limitations

- **`speechSynthesis` fallback**: When running offline (no `OPENAI_API_KEY`), TTS uses the browser's `speechSynthesis` API, which cannot be captured by an `AudioContext`. Therefore, the interviewer's voice will not appear in recordings when using the offline demo model. This is expected behavior.

- **No additional tests were added** beyond the reviewer-supplied ones (31 tests).

## Round 2

Fixed 6 bugs in `recording-session.ts` per review:

- **B1:** Tab rejection while mic pending no longer causes unhandled rejection (single `Promise.allSettled` over both promises)
- **B2:** S5/S6 blocked notices emitted in one change
- **B3:** `updateSnap` returns early if disposed, preventing snapshot changes after dispose
- **B4:** `createMixer`, `combine`, and `recorder.start()` throwing now properly fails the kind without leaving unresolved promises
  - Added `createMixerOrNull` and `failUnsupported` helpers
  - `startRecorder` now takes a stream factory and stores recorder only after `start()` succeeds

Added `tests/recording-review.test.ts` (13 tests) covering all bugs and gaps.
