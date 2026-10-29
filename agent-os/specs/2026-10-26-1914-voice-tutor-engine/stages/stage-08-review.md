# Stage 8 review 1: fix list (handoff to the external model)

You're starting in a fresh session. Read `STATUS.md`, the Stage 8 brief (`stage-08-mid-answer-canvas.md`) and this file. **The brief is correct.** Never edit an expected value to make a test pass. If something still fails after you follow this file exactly, stop and write it in `STAGE8_NOTES.md`.

This round is small: **one bug fix, one stray line to remove, and five test files to copy byte-for-byte.** Everything else is already right.

## What passed
- **Scope:** only allowed files changed. Every frozen file from Stages 1–7 is byte-identical, and the three Stage 7 reviewer test files still match their `.txt` sources.
- **Unfrozen edits:**
  - `interview-model.ts` reverses exactly to its pre-stage hash `5baca0e9`.
  - `use-interview.ts` and `InterviewScreen.tsx` contain only the §3/§7 changes (diffed against recovered pre-stage copies).
  - `voice-controller.ts` matches §5 except for D1 below. The `words` → `wordCount` rename in `onPartial` is cosmetic, and is accepted.
- **Checks:** `tsc` exits 0, eslint shows 0 errors and 0 warnings, and the no-key `next build` passes. **vitest exits 0 (761 tests)**, with no Errors line and no test names lost against Stage 7.
- **Vectors:** `tests/turn-controller.test.ts` uses the brief's literal V1–V15, hash and constant values, and passes unchanged against the reviewer's reference implementation.
- **`background-runner.ts`, `turn-controller.ts`, `use-interview.ts` and the InterviewScreen wiring are correct.** That covers:
  - re-entrant `onSettled` → `run()`
  - the run-foreground-then-abort order
  - `sendBackground` reads `viewRef`
  - no ref reads during render
  - browser globals only inside handlers and effects
  - no logging of partial, transcript or image text
- **The bundle is clean:** 0 of 99 secret config strings are in `.next/static`, checked against a positive control.

## Fixes

### B1. Scratchpad: a tap with no movement counts as ink (`src/app/interview/Scratchpad.tsx`)
**The brief (§6):** *"When a stroke that drew at least one segment ends, set `hasInk = true` … and call `onChange(getImage)`."*

**The code:** `handlePointerUpOrCancel` sets `hasInkRef.current = true` and calls `onChange` on **every** pointer-up, including a plain click or tap that drew nothing. The comment above that line describes the rule, but the code doesn't check it.

**Effect:** tap the blank scratchpad, or tap it after **Clear**, and 4 s later the client sends a blank white PNG to the model as a `canvas` step.

**Fix:** track whether this stroke drew a segment.
1. Add `const drewRef = useRef(false);` next to the other refs.
2. In `handlePointerDown`, set `drewRef.current = false;` next to `drawingRef.current = true;`.
3. In `handlePointerMove`, inside the `if (last) { … }` block after `ctx.stroke();`, add `drewRef.current = true;`.
4. In `handlePointerUpOrCancel`, replace
   ```ts
       // If we drew at least one segment, set hasInk and call onChange
       hasInkRef.current = true;
       onChange(getImage);
   ```
   with
   ```ts
       // If we drew at least one segment, set hasInk and call onChange
       if (drewRef.current) {
         drewRef.current = false;
         hasInkRef.current = true;
         onChange(getImage);
       }
   ```

Change nothing else in the file.

### D1. Remove the stray `failed` edit (`src/client/voice/voice-controller.ts`)
§5 lists every change to this file, and `case "failed"` isn't among them. Your build added a line there. Restore that case to exactly:
```ts
      case "failed":
        chunker.reset();
        break;
```
That means deleting the line `interjectBaseline = null;` from `case "failed"` only. Keep it in `request`, `bg_move`, `bg_failed`, `disable()` and the barge-in check.

### T1. Replace the Stage 8 test files with the reviewer's versions (copy byte-for-byte)
The reviewer ran a revert check on every §1–§5 rule. Your tests caught 90 of 133 reverts:

| Group | Caught |
|---|---|
| model | 21/27 |
| background runner | 11/15 |
| turn controller | 50/71 |
| voice | 8/20 |

Several of your tests can't fail:
- In `voice-interjection` tests 5 and 6, the `bg_move` has already stopped the TTS before the test asserts "the partial stopped it".
- Test 9 uses **two separate controllers**, so a stale `onTurnStart` can never reach session 2.
- `background-runner` test 7 asserts `inFlight()` is **false**, where the brief says it should be true.
- The e2e tests never fold the actions into a `view`, so `status` and `background` are never checked.
- The supersede test aborts only after the foreground turn has finished, and its `runStepRequest` wrapper drops the abort `signal`.

The reviewer's files fix these and add tests for the uncovered rules, which brings the result to **126/133**. The remaining 7 reverts are equivalent mutants that no test can catch. Every original test name is kept, and the files pass against your current code.

Copy each source file over its target exactly. Don't reformat, re-indent or "tidy" it, and don't edit any of them afterwards:

| Source (`agent-os/review/stage-08-tests/`) | Target |
|---|---|
| `background-runner.test.ts.txt` | `tests/background-runner.test.ts` |
| `voice-interjection.test.ts.txt` | `tests/voice-interjection.test.ts` |
| `e2e-mid-answer.test.ts.txt` | `tests/e2e-mid-answer.test.ts` |
| `turn-controller.test.ts.txt` | `tests/turn-controller.test.ts` (your file + V16–V30 and H5) |
| `interview-model.test.ts.txt` | `tests/interview-model.test.ts` (your file + 4 tests) |

Copy them with a byte-exact tool, for example `node -e "require('fs').copyFileSync(src, dest)"`. After copying, each target's SHA-256 must equal its source's.

Ignore the two `*-additions.ts.part` files in that folder: they're the reviewer's build inputs, and they're already included in the `.txt` files.

## Constraints for this pass
- **Files you may change:**
  - `src/app/interview/Scratchpad.tsx` (B1 only)
  - `src/client/voice/voice-controller.ts` (D1 only)
  - the five test files in T1 (by copying only)
  - `STAGE8_NOTES.md`
- **Everything else is frozen,** including these Stage 8 files at their current SHA-256 (first 8):

  | File | SHA-256 |
  |---|---|
  | `interview-model.ts` | `a64bd019` |
  | `use-interview.ts` | `a6439cc4` |
  | `background-runner.ts` | `ba485205` |
  | `turn-controller.ts` | `68fd7bf7` |
  | `InterviewScreen.tsx` | `0789eeab` |

  Also frozen: everything under `agent-os/` and every other test file.
- **Don't touch `.env.example`.** It isn't yours to change, and it's being handled separately.
- No new dependencies. Don't call any external API or use any key.

## Acceptance
1. Only the files listed above changed. The five T1 test files are byte-identical to their `.txt` sources.
2. `Scratchpad.tsx` differs from its current version only by B1. In `voice-controller.ts`, `case "failed"` is exactly the three lines shown in D1.
3. `npx tsc --noEmit` passes. `npx eslint --max-warnings=0` reports 0 problems. `npx next build` passes with no keys set.
4. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** It should report 788 tests (761 + 27 new: voice-interjection +7, turn-controller +16, interview-model +4), and no test name disappears.
5. `STAGE8_NOTES.md` has a "Review 1" section that lists exactly what you changed.
