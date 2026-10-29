# Stage 1 review: fixes required (handoff to the external model)

Reviewed on 2026-10-26. Typecheck, tests (34/34) and build pass, and lint has 0 errors and 1 warning. The contracts match the brief. The fixes below are needed before Stage 2. Don't change anything outside these items.

## Must fix (blocking)

### F1. `chatJSON` maps timeouts to `upstream` instead of `timeout` (`src/lib/meta.ts:149-171`)
When the abort signal fires, the openai SDK (v5) throws `OpenAI.APIUserAbortError`, not an error named `AbortError`. As a result, the `err.name === "AbortError"` branch never runs, and the error falls through to the generic `APIError` branch with `status` undefined, which maps to `upstream`.
- **Reproduced:** a server that never responds with `timeoutMs: 300` gives `MetaError code=upstream`.
- **Fix:** before the generic `APIError` branch, treat `err instanceof OpenAI.APIUserAbortError || err.name === "AbortError"` as an abort.
  - If `opts.signal?.aborted`, the caller aborted: rethrow as-is.
  - Otherwise, throw `MetaError("timeout", …, true)`.
  - Also map `OpenAI.APIConnectionTimeoutError` to `timeout`.

### F2. `chatStream` timeouts silently end the stream with no error (`src/lib/meta.ts:241-280`)
The SDK's `Stream` iterator swallows abort errors and just stops iterating. So when the first-token or total timer fires after the response headers arrive, which is the normal case, the `for await` ends cleanly. `chatStream` then returns with zero or partial tokens and logs `ok: true`.
- **Reproduced:** a server that sends SSE headers and then stalls, with `firstTokenTimeoutMs: 300`, returns normally after 323 ms with 0 tokens.
- **Fix:**
  - Set a `timedOut` flag inside both timer callbacks before calling `controller.abort()`.
  - After the loop *and* in `catch`, if `timedOut`, throw `MetaError("timeout", …, true)`.
  - If the caller's `signal` aborted, return or rethrow without logging it as a timeout.
  - Apply the same `APIUserAbortError` handling as F1.

### F3. Failures are never logged (`src/lib/meta.ts`)
`logModelCall` is only called on success and for `invalid_output`. Timeout, 429, 5xx and 4xx in `chatJSON`, and every error in `chatStream`, go unlogged, which hides exactly the failures we need to see.
- **Fix:** log exactly once per attempt, `ok:false` with `code`, for every `MetaError` path in both functions. A small wrapper or `finally` is fine. Still never log prompts or keys.

### F4. Required tests are missing (`tests/meta.test.ts`)
The brief required these tests, and they would have caught F1 and F2:
- a timeout on the first attempt and success on the second → resolves, and `create` is called twice
- a 400 → no retry (`create` called once), `MetaError{code:"upstream", retryable:false, status:400}`
- `chatStream` first-token timeout → throws `MetaError{code:"timeout"}` (fake timers or a real short timeout)

**Also add `tests/meta.sdk.test.ts`**, which uses a **real `OpenAI` client** pointed at a local `node:http` server (`baseURL: http://127.0.0.1:<port>/v1`, `maxRetries: 0`). Fakes hide the SDK's behaviour, so this file covers:
1. a server that never responds, with `timeoutMs: 300` → `code:"timeout"`
2. a server that sends SSE headers and then stalls, with `firstTokenTimeoutMs: 300` → `code:"timeout"`
3. a server that returns 429 twice → `rate_limited`, called twice
4. a server that streams 3 SSE chunks and `[DONE]` → yields 3 deltas

Close the servers in `afterAll`.

### F5. The intro transcript entry uses epoch ms for `at` (`src/app/api/step/route.ts:104`)
`at` is "ms since session start", but the intro entry stores `now` (epoch, e.g. `1793044549635`). It should be `0`. Add a route test asserting every transcript `at` is `< 60_000` in the stub flows.

### F6. Concatenated tokens must equal the utterance (`route.ts:35-46`)
This invariant is being added to the protocol: **concatenating every `token.text` in order must exactly equal `done.utterance`.** Real model deltas already include their spaces. The stub currently splits on `" "` and drops the spaces, so clients would render "Hello,I'm…".
- **Fix:** emit word tokens that keep their trailing whitespace, e.g. `text.match(/\S+\s*/g)`.
- Add a JSDoc line stating the invariant on `StepStreamEventSchema` in `src/contracts/step-protocol.ts`.
- Add route tests asserting `tokens.join("") === utterance` for the start and turn_complete flows.

## Should fix (non-blocking, same pass)

### F7. Latency script accuracy (`scripts/latency.ts`)
- **Hidden retries:** the client uses the SDK default `maxRetries: 2`, so failures and slow responses are retried and the numbers are skewed. Set `maxRetries: 0`.
- **Prompt too short:** the assess prompt is about 400 tokens; the brief asked for about 1–1.5k so the numbers reflect real assess calls. Pad it realistically:
  - full problem statement
  - checkpoints with ids (`c1`…`c3`)
  - misconceptions with ids, signals and realign text
  - a style persona
  - about 8 prior transcript turns
  - then the partial answer

  Print the `usage.prompt_tokens` p50 in the table so we can see the size.
- **Image rejection check:** detection works by string-matching the message (`includes("4")`). Use `err instanceof OpenAI.APIError && err.status >= 400 && err.status < 500` across all runs instead.

### F8. zod version mix
`zod@3.25.76` is installed and used via the `zod/v4` subpath, but `src/lib/env.ts` imports classic `zod`. Upgrade to `zod@^4`, import from `"zod"` everywhere (src, tests, scripts), and make sure typecheck and tests still pass.

### F9. Route cleanup (`route.ts`)
- **Double close:** remove the inner `controller.close(); return;` branches. The schema refine makes them unreachable, and the `finally` would close the stream a second time.
- **Dead code:** remove the `err.message === "Aborted"` check, which never matches.
- **Errors:** on an unexpected error, emit an SSE `error` event (`code:"internal", retryable:true`) and then close, instead of rethrowing.
- **Closing after cancel:** guard `enqueue`/`close` with a `closed` flag, and add a `cancel()` handler that sets it.
- **Runtime:** add `export const runtime = "nodejs"` as the brief required. If Next 16 with `cacheComponents` rejects it, write that in `STAGE1_NOTES.md` instead.

### F10. `parseSSE` (`src/contracts/step-protocol.ts`)
- Join multi-line `data:` with `"\n"` (SSE spec), and strip only one optional leading space after `data:`/`event:` rather than `trim()`.
- Extract the duplicated block-parsing code into one `parseBlock()` helper.
- If the consumer stops early (generator `return`), call `reader.cancel()` before `releaseLock()`.

### F11. Empty env strings
`META_MODEL=` currently yields the model `""`. In `env.ts`, preprocess empty strings to `undefined` so defaults and optionals behave.

### F12. Lint warning
Fix the unused `_` at `tests/meta.test.ts:224` (use the same eslint-disable comment as the other tests).

### F13. Unrequested `next.config.ts` options
`cacheComponents`, `partialPrefetching` and the custom turbopack CSS rule weren't in the brief.
- If they are `create-next-app` defaults for Next 16.4, say so in `STAGE1_NOTES.md`.
- If not, remove them. `cacheComponents` changes rendering semantics for every later stage.

## Acceptance for this fix pass
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- The new SDK-level tests pass and fail if F1 or F2 is reverted.
- The curl start flow shows tokens with spaces and a transcript `at` of `0`.
