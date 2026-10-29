# Stage 5 re-review 2: unhandled rejections and checker test gaps (handoff to the external model)

Re-reviewed on 2026-10-27.

## What passed
- **All 8 scripts match the brief's tables exactly**, diffed field by field. The only differences are the accepted extra `interviewerKind`, `hintRung` and `probesAsked` checks, and **no expectation was edited away from the brief**.
- **Checks:** typecheck, lint (0 warnings) and a no-key build all pass.
- **CLI:** `npm run eval` without a key prints the hold message and exits 2.
- **Files:** `scripts/debug.ts` is gone. Frozen files are byte-for-byte unchanged. `package.json` gained only the `eval` script, using `--env-file-if-exists`.
- **F1–F8 verified.** No test name was lost (`eval-cli` 2→6, `eval-schema` 12→13, `eval-score` 12→13, `regression` 33).
- **Temporary reverts:** 47 run across `schema`, `expect`, `score`, `replay`, the CLI and the script expectations. **35 were caught.** All CLI, score and replay-behaviour reverts and all four script-expectation edits are caught. The 12 misses are listed in T2 below.

## B1. `npm test` exits with code 1 (3 unhandled rejections)
All 420 tests pass, but vitest reports **3 unhandled errors** and the run **exits with code 1**, so CI would fail. They **aren't new in Stage 5**: they come from Stage 4 test files. (The Stage 4 review missed them because it checked pass counts but not vitest's exit code or `Errors` line.) There are two different causes.

### B1a. A real bug in `src/contracts/step-protocol.ts`, line 159 (one-line fix; this frozen file is unfrozen for this line only)
In `parseSSE`'s `finally`, `reader.cancel()` returns a **promise**. When the body stream has already errored, that promise **rejects**, and the surrounding synchronous `try/catch` can't catch it. Reproduced in isolation, with no test code: an errored body stream leads to `parseSSE` rejecting correctly **plus one unhandled rejection**.

This affects production. A connection that drops mid-reply would log an uncaught promise error in the browser, and in Node, where unhandled rejections crash the process by default, the live eval CLI could crash on a network error.

**Fix:** replace
```ts
    try {
      reader.cancel();
    } catch {
      // Ignore cancel errors
    }
```
with
```ts
    // cancel() returns a promise that rejects if the stream already errored; swallow it.
    reader.cancel().catch(() => {});
```
Keep `reader.releaseLock();` after it. **Change nothing else in `src/contracts/`.**

**Test (`tests/sse.test.ts`, add):**
- Build a body stream with `start(c) { c.error(Object.assign(new Error("boom"), { name: "AbortError" })) }`.
- Register `process.on("unhandledRejection", handler)` collecting rejections, iterate `parseSSE` and expect it to reject with `name === "AbortError"`, then `await new Promise(r => setTimeout(r, 20))`.
- Assert **zero** collected rejections, then remove the listener.

### B1b. Two `tests/fake-model.test.ts` tests attach their assertion too late (test-only fix)
Both "already-aborted signal → rejects with AbortError" and "aborted during delay → rejects with AbortError" call `await vi.runAllTimersAsync()` **before** `await expect(promise).rejects…`. The promise rejects while no handler is attached.

**Fix, for both:** attach the assertion first, then advance the timers:
```ts
const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
await vi.runAllTimersAsync();
await assertion;
```

### B1 acceptance
`npx vitest run` exits with **code 0**, and its output has **no** `Errors` line and no "Unhandled Rejection".

## T2. Test gaps found by temporary reverts (12)

### `src/eval/expect.ts`: the tamper tests cover only some fields
Removing any of these checks still passes every test:
- `move.type`
- `move.rung`
- `move.probeIdx`
- `move.toProblemIdx`
- `state.phase`
- `state.problemIdx`
- `state.hintRung`
- `state.checkpointsHit`
- `state.probesAsked`
- the implicit-start `phase === "problem"` check

**Fix:** in `tests/regression.test.ts`'s "sanity checks", add one tamper test per field. Take a real outcome from a script that asserts that field, change the outcome, and assert `checkScript` returns **exactly one** message that mentions the field.
- `01-stuck-then-recovers`:
  - step 0: change `move` to `{ type: "acknowledge" }` (tests **move.type**; expect exactly one message containing `move.type`)
  - step 0: `move.rung` → 1
  - step 3: `move.probeIdx` → 1
  - step 4: `move.toProblemIdx` → 2
  - step 4: `state.problemIdx` → 0
  - step 2: `state.checkpointsHit` → `["c1"]`
  - step 3: `state.probesAsked` → 0
- `05-long-silence` step 1: `state.hintRung` → 1.
- `02-right-first-time` step 5: `state.phase` → `"problem"`.
- The implicit start: change `state.phase` → `"intro"`.

### `src/eval/schema.ts`: equal `atMs` isn't rejected by any test
Changing `<=` to `<` in the "strictly increasing" check passes.

**Fix:** in `tests/eval-schema.test.ts`, add a script whose two steps share the same `atMs` and expect it to be rejected.

### `src/eval/replay.ts`: the "no `words` key" test passes even if `onRequest` is never called for script steps
**Fix:** in that test, also assert that the number of collected request bodies equals `script.steps.length + 1` (the steps plus the implicit start).

## Constraints for this pass
- **Allowed changes:**
  - `src/contracts/step-protocol.ts`, only the B1a lines
  - `tests/sse.test.ts`, `tests/fake-model.test.ts`, `tests/regression.test.ts`, `tests/eval-schema.test.ts`
- **Every other file is frozen**, including the scripts and all other `src/` files. The reviewer will hash them.
- **Add tests; don't delete or weaken any.**

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), **`npx vitest run` exits 0 with no `Errors` line**, and a no-key `npm run build` passes.
- Each T2 revert makes a test fail. The new SSE test fails if the `.catch(() => {})` is removed.
- Only the files listed above change.
