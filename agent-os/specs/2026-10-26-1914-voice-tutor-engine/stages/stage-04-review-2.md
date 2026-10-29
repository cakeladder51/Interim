# Stage 4 re-review 2: two runner test gaps (handoff to the external model)

Re-reviewed on 2026-10-27.

## What passed
- Typecheck, lint (**0 warnings**), tests (348/348) and a no-key build. `/` is static and `/interview` is partially prerendered.
- **Frozen and behaviour-locked files are unchanged** (SHA-256 checked): `interview-model.ts`, `step-client.ts`, `fake-model.ts`, `deps.ts`, `public.ts`, `step-handler.ts`, plus every earlier stage's frozen files.
- **No test names lost:** the e2e test kept its name; `fake-model` went 22→24, `interview-model` 46→51, `step-client` 17→22, and `request-runner` is new with 8.
- **No secret config text in the browser bundle:** 0 hits for 99 strings.
- **B1:** fixed. **B2:** the e2e test now runs all 12 steps through `runStepRequest`. **U2:** the timer only renders once the engine exists.
- **B3 (the StrictMode stale-request bug) is fixed.** `request-runner.ts` gives each run its own token and its own timer, and every callback and settle path checks that the run is still current. Removing any of the `onMove`, `onToken`, `onModelLabel`, `then`, `catch` or `finally` guards, or the `run()`-aborts-previous call, makes the supersede tests fail.
- **Temporary reverts:** 101 run, in three chunks, with every file restored byte for byte. **96 were caught.**
  - G1–G11 from the last round are all caught now.
  - Of the 5 misses, 2 were marked "not required" last round (solved-over-stuck priority, and the 30 ms token delay).
  - 1 is equivalent: the slow-timer callback's guard. A superseded run's timer is always cleared by `abort()` first.
  - **The remaining 2 are listed below.**

## Constraint for this pass
- Change only `tests/request-runner.test.ts`.
- Add tests; don't delete or weaken any.
- No source file may change.

## R1. Superseded and aborted requests aren't checked to be cancelled
Removing `current.controller.abort()` from `abort()` passes every test, so nothing proves the old fetch is actually cancelled. The previous request would keep streaming from the server, and with a real model the server would keep generating.

**Fix:** capture the `signal` passed to the fake `runStepRequest` for each run.
- After `run(B)` supersedes `run(A)`: `signalA.aborted === true` and `signalB.aborted === false`.
- After `abort()`: the current run's signal has `aborted === true`.

## R2. The slow threshold isn't pinned
Doubling the slow delay to `SLOW_FIRST_TOKEN_MS * 2` passes, because the test fires the captured timer callback directly.

**Fix:**
- Assert that `setTimer` is called with `ms === 6000` for each `run`.
- Add `expect(SLOW_FIRST_TOKEN_MS).toBe(6000)`.
- If you use real fake timers instead, check that no `slow` is dispatched at 5999 ms and exactly one is dispatched at 6000 ms.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and a no-key `npm run build` all pass.
- Removing `current.controller.abort()` makes a test fail. Changing the delay to `SLOW_FIRST_TOKEN_MS * 2` makes a test fail.
- Only `tests/request-runner.test.ts` has changed, and no test name is removed.
