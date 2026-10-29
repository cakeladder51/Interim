# Stage 4 review: fixes required (handoff to the external model)

Reviewed on 2026-10-27.

## What passed
- **Checks:** typecheck, tests (328/328) and a no-key build all pass. `/` is static and `/interview` is partially prerendered.
- **Frozen files** are unchanged (SHA-256 checked).
- **`step-handler.ts`:** undoing only the `modelLabel` addition reproduces the recorded Stage 3 hash exactly, so nothing else changed.
- **Allowed files:** only allowed files changed. **No test names were lost** (compared file by file).
- **No secret config text reaches the browser:** 0 hits for 99 solution, hint, probe, checkpoint, misconception and prompt strings across `.next/static` and the prerendered output, with a positive control confirming the scan reads real content. The served `/interview` HTML is also clean.
- **The offline model is gated correctly:**
  - under `next dev` with `INTERIM_FAKE_MODEL=1`, it's active (`X-Interim-Model: fake`)
  - under `next start` (production) with `INTERIM_FAKE_MODEL=1`, it's **off** (no header, real deps)
- **Over real HTTP against `next dev`**, the scripted 12-step interview produced exactly the expected moves: intro, hint 0, hint 1, realign, probe, advance, probe, advance, probe, wrap_up, acknowledge, silent. The stream invariant held on every reply, and the error card shows for bad params.
- **Temporary reverts:** 87 run, one at a time, across the reducer and helpers, step client, fake model, `selectDeps`, public config and header. **74 were caught; 13 weren't** (see below).

## Constraints for this pass
- **Allowed changes:** `tests/**`, `src/client/use-interview.ts`, new `src/client/request-runner.ts`, `src/app/interview/InterviewScreen.tsx` (U2 only).
- **Don't change the behaviour** of `interview-model.ts`, `step-client.ts`, `fake-model.ts`, `deps.ts`, `public.ts` or `step-handler.ts`. The reviewer will hash them.
- **Add tests; don't delete or weaken any.** Per-file test names are compared.

## B1. Lint has 2 warnings (acceptance requires 0)
`tests/e2e-text-interview.test.ts:1` imports `beforeEach` and `afterEach` but never uses them. Remove them.

## B2. The e2e test bypasses `runStepRequest` (`tests/e2e-text-interview.test.ts`)
The brief says to *point `runStepRequest`'s `fetchImpl` at the handler and drive the reducer exactly as the hook would*. The test parses SSE itself instead, so the M1 regression never exercises the browser-side request layer.

**Fix:** rewrite the driver loop so that each step:
1. dispatches `request`
2. calls `runStepRequest(request, { fetchImpl: (url, init) => handler(new Request("http://test" + url, init)), callbacks: { onMove, onToken, onModelLabel } })`, with each callback dispatching its action
3. dispatches `done` with the result

Keep every existing assertion: the moves, phases, problem indices, tokens joined equal to the utterance, transcript growth, and the final `ended` status.

## B3. A stale request can corrupt the next one (`src/client/use-interview.ts`)
`runRequest` keeps the slow timer in a shared ref, and `.finally` of **any** request clears `slowTimerRef.current` and sets `inFlightRef.current = false`. When React StrictMode double-mounts in dev, the aborted first start request settles **after** the second has begun. It then clears the second request's slow timer (so "taking longer than usual" never appears) and resets the in-flight flag. Its callbacks could also dispatch into the new request. The brief requires that *the aborted first request must leave no trace*.

**Fix:** extract the request lifecycle into a pure, testable module, `src/client/request-runner.ts`:
```ts
export interface RunnerDeps {
  dispatch: (a: InterviewAction) => void;
  runStepRequest: typeof import("./step-client").runStepRequest;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  describeError: (err: unknown) => { message: string; retryable: boolean };
}
export function createRequestRunner(deps: RunnerDeps): {
  run(request: StepRequest, studentText: string | null): void;  // aborts any current request first
  abort(): void;                                                // aborts current, clears its timer
  inFlight(): boolean;
}
```
- Each `run` creates its own `AbortController` and its **own local timer handle**.
- Every callback, plus `.then`, `.catch` and `.finally`, must first check that this run is still the current one (for example, compare against a `current` token). **A superseded run dispatches nothing, clears only its own timer, and never changes `inFlight()`.**
- `useInterview` uses this runner and keeps the rest of its behaviour the same.

**Tests (`tests/request-runner.test.ts`),** using a controllable fake `runStepRequest` (deferred promises with captured callbacks) and fake timers:
1. **Normal run:** dispatch order is request, move, token(s), done. The timer is cleared on success. `inFlight()` is true during the run and false after.
2. **Slow:** with no token before `SLOW_FIRST_TOKEN_MS`, `slow` is dispatched once.
3. **Failure:** `failed` is dispatched with `describeError`'s output. An `AbortError` dispatches nothing.
4. **Supersede:** start run A, then run B. A later resolves, rejects, or fires callbacks. **Nothing from A is dispatched**, B's slow timer still fires, and `inFlight()` stays true until B settles.
5. **`abort()`:** clears the current timer, and the aborted run dispatches nothing afterwards.

## U2. The elapsed timer shows before the interview starts (`InterviewScreen.tsx`)
The brief says the timer is "shown once the engine exists". It currently renders `00:00 / 25:00` before the start reply arrives. Render it only when `view.engine !== null`.

## Test gaps: add a test for each uncaught revert

| # | Revert that passed all tests | Test to add |
|---|---|---|
| G1 | `request` doesn't clear `error` | From a view with `error` set (after `failed`), a `request` → `error === null`. |
| G2 | `request` doesn't reset `slow` | From a view with `slow: true`, a `request` → `slow === false`. |
| G3 | `done` doesn't clear `error` | From a view with `error` set, `done` → `error === null`. |
| G4 | `failed` forces `retryable: true` | `failed` with `retryable: false` → `view.error.retryable === false`. |
| G5 | `canSend` ignores status | With an engine in the `problem` phase and non-empty text, `canSend` is **false** for each of `starting`, `sending`, `ended` and `error`. |
| G6 | Step client: token or done before move no longer rejected immediately | For token-first and done-first streams, assert it rejects with `StepProtocolError` **and that `onToken` and `onMove` were never called**. |
| G7 | Step client: `error` after `done` becomes a `StepStreamError` | A stream of move, done, error → rejects with `StepProtocolError`, not `StepStreamError`. |
| G8 | Step client: `retryable` ignored | An `error` event with `retryable: false` → `StepStreamError.retryable === false`. Also test `true`. |
| G9 | Step client: an `AbortError` while reading is wrapped | A body stream that errors with an `AbortError` mid-read (for example `controller.error(Object.assign(new Error("x"), { name: "AbortError" }))`) → rejects with `name === "AbortError"` and **not** a `StepProtocolError`. |
| G10 | Step client: `interrupt` not returned | A `move` with `interrupt: true` → the result has `interrupt === true`, and `onMove` receives `true`. |
| G11 | Fake model: solved uses problem 0 | Use `state.problemIdx: 1`. Solved returns problem 1's checkpoint ids (`["c1", "c2", "c3"]` from `sum-of-odds`) and those of no other problem. Make it distinguishable: assert against `config.problems[1].checkpoints.map(c => c.id)`, and also against a test config whose problem 0 and problem 1 have **different** ids. |

**Not required:** two other reverts went uncaught, but neither matches a rule the brief required a test for: making "solved" take priority over "stuck", and the 30 ms token delay. No change is needed.

## Acceptance
- `npm run typecheck`, `npm run lint` (**0 warnings**), `npm test` and a no-key `npm run build` all pass.
- Each of G1–G11 makes a test fail when its rule is reverted. The new runner tests fail if the "is this run still current?" guard is removed.
- The e2e test calls `runStepRequest` for every step.
- No test name is removed. The listed source files keep their behaviour, and the frozen files are byte-for-byte unchanged.
