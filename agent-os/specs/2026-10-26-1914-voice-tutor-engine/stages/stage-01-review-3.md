# Stage 1 re-review 3: last fixes (handoff to the external model)

Re-reviewed on 2026-10-26. Typecheck, lint (0 warnings), tests (40/40) and build all pass.

**Verified fixed:**
- R1: `chatJSON` now logs exactly once per attempt, including timeout and invalid_output; the stalled-stream double-log is gone.
- R3: the route's `cancel()` and guarded `enqueue`.
- R4: the latency image-rejection message.
- The SDK tests for "never responds", "stalls after headers" and "429 ×2".

## S1. A `chatStream` timeout before the headers arrive is not logged (`src/lib/meta.ts:347`)

When the server never sends headers, `create()` throws `APIUserAbortError` while `timedOut === true`. The guard `if (!(timedOut && metaErr.code === "timeout"))` then skips the log, on the assumption that it was already logged. It wasn't: the only pre-logged path is the silent-stall one, which is caught earlier at line 334.

**Reproduced:** with a server that never responds and `firstTokenTimeoutMs: 300`, the call throws `timeout` with **no** `model_call` line.

**Fix:**
- Add `let logged = false`, and set it to `true` wherever a log is written.
- In `catch`, log only if `!logged`.
- Delete the `timedOut && metaErr.code === "timeout"` special cases at lines 334–336 and 347.

## S2. Tests still missing from R2

- **`tests/meta.sdk.test.ts`:**
  - **timeout then success:** the first request hangs and the second succeeds → `chatJSON` resolves and the server sees 2 requests.
    - The `hang-once` mode is already in the server but unused. It also reads the global `requestCount`, so reset `requestCount = 0` in that test.
  - **400:** a server mode that returns 400 → `MetaError{code:"upstream", retryable:false, status:400}`, and the server sees exactly **1** request.
  - **`chatStream` against the never-responds (`hang`) mode:** throws `code:"timeout"`. This covers S1's path.
- **Logging tests** (`console.info` spy, count the lines containing `"tag":"model_call"`), added to the existing two:
  - `chatJSON` timeout (SDK `hang` mode) → exactly **2** lines, both `ok:false, code:"timeout"`
  - `chatStream` stall-after-headers → exactly **1** line, `ok:false, code:"timeout"` (no `ok:true` line)
  - `chatStream` never-responds → exactly **1** line, `ok:false, code:"timeout"`. This fails today (S1).
  - `chatStream` success → exactly **1** line, `ok:true`

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- The new "chatStream never-responds logs 1 line" test fails on the current code and passes after S1.
