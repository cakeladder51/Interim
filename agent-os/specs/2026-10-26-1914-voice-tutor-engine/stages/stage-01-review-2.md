# Stage 1 re-review: remaining fixes (handoff to the external model)

Re-reviewed on 2026-10-26. Typecheck, lint (0 warnings), tests (36/36) and build all pass.

**Verified fixed:**
- F1: a timeout now gives `code:"timeout"`. Probed against a real local server.
- F2: a stalled stream now throws `timeout`. Probed.
- F5, F6, F8, F10, F11, F12.
- F13 is explained in `STAGE1_NOTES.md` (accepted).
- F7 and F9 are mostly done.

These items can be fixed alongside Stage 2, which doesn't touch `src/lib/meta.ts`. **R1 and R2 must be done before Stage 3**, which depends on the Meta client.

## R1. Model-call logging is still wrong (`src/lib/meta.ts`)

Probing confirmed three problems:
- **(a)** `chatJSON` timeouts aren't logged at all. The branches at lines 154–161 throw without calling `logModelCall`.
- **(b)** `invalid_output` is **no longer logged** (a regression). It's thrown inside the `try`, caught, and rethrown by the `MetaError` branch at line 187, whose comment says "already logged", but nothing logs it.
- **(c)** A `chatStream` silent timeout logs `ok:true` (line 291) **and then** `ok:false, code:"timeout"` for the same call.

**Fix:** use one log point per attempt. A suggested shape:
- Convert the error into a `MetaError` in a single `toMetaError(err)` helper. This also removes the duplicated mapping code in the two functions.
- Log once, at the point where the attempt finishes (success, or the `MetaError` about to be thrown).
- In `chatStream`, check `timedOut` **before** logging success.
- Don't log caller aborts.

## R2. Tests from F4 that are still missing

These are the tests that protect F1, F2 and R1 from regressing.
- `tests/meta.sdk.test.ts` (real `OpenAI` client + local `node:http` server):
  - a server that never responds, with `timeoutMs: 300` → `code:"timeout"`; the server sees 2 requests (one retry)
  - a server that sends SSE headers then stalls, with `firstTokenTimeoutMs: 300` → `chatStream` throws `code:"timeout"`
  - the existing 429 test → also assert the server received **2** requests
  - **Cleanup:** in `afterAll`, call `server.closeAllConnections()` before `server.close()`, so the hanging requests don't keep vitest alive
- `tests/meta.test.ts`:
  - a timeout on the first attempt and success on the second → resolves, with `create` called twice
  - a 400 → `create` called once, `retryable:false`, `status:400`
- **Logging tests:** spy on `console.info` and assert exactly one `model_call` line per attempt, with the right `ok`/`code`. Cover four cases:
  - success
  - invalid_output ×2 (2 lines)
  - timeout (2 lines, one per attempt)
  - stream timeout (1 line, `ok:false`)

## R3. The route's `cancel()` is empty (`src/app/api/step/route.ts:193`)

**Fix:**
- Hoist `let closed = false` above the `ReadableStream`.
- Make `cancel()` set `closed = true`.
- Wrap `controller.enqueue` in try/catch.

At the moment, if the consumer cancels the body without `request.signal` firing, `enqueue` throws, the `catch` tries to `sendEvent` again, and `start()` rejects unhandled.

## R4. Latency script's image-rejection message (`scripts/latency.ts:392-401`)

- Drop the leftover `err.includes("4")` string check; the status count already covers it.
- Print the first rejection's status and message as the brief specified: `IMAGE INPUT FORMAT REJECTED: <status> <message>`.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- Reverting F1, F2 or R1 makes at least one test fail.
