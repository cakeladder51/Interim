# Stage 8 Review 1 Check Report (s08-r2)

## Changed files

```
CHANGED STAGE8_NOTES.md
CHANGED src/app/interview/Scratchpad.tsx
CHANGED src/client/voice/voice-controller.ts
CHANGED tests/background-runner.test.ts
CHANGED tests/e2e-mid-answer.test.ts
CHANGED tests/interview-model.test.ts
CHANGED tests/turn-controller.test.ts
CHANGED tests/voice-interjection.test.ts
```

**Violations:**
- All changed files are **allowed** per SPEC (Constraints):
  - `src/app/interview/Scratchpad.tsx` (B1 only) ✓
  - `src/client/voice/voice-controller.ts` (D1 only) ✓
  - Five T1 test files (by copying only) ✓
  - `STAGE8_NOTES.md` ✓
- All frozen files unchanged (SHA-256 verified): `interview-model.ts`, `use-interview.ts`, `background-runner.ts`, `turn-controller.ts`, `InterviewScreen.tsx` ✓

## Build health

```
tsc exit=0 errors=0
eslint exit=0 clean
next build exit=0 routes: relay-token=true tts=true
vitest exit=0 | Tests  788 passed (788) | Errors: none | no unhandled
test names lost=0; changed counts: interview-model.test.ts 70→74, turn-controller.test.ts 26→42, voice-interjection.test.ts 9→16
```

- tsc exit 0 ✓
- eslint exit 0, 0 warnings ✓
- next build exit 0 ✓
- vitest exit 0, no Errors line, no unhandled rejections ✓
- **test names lost=0** ✓
- Test count: 761 → 788 (+27 new: interview-model +4, turn-controller +16, voice-interjection +7) ✓

## Spec items

| Item | Status | Evidence |
|------|--------|----------|
| **B1. Scratchpad tap-without-movement fix** | | |
| 1. Add `const drewRef = useRef(false);` next to other refs | DONE | `src/app/interview/Scratchpad.tsx:16` |
| 2. In handlePointerDown, set `drewRef.current = false;` | DONE | `src/app/interview/Scratchpad.tsx:46` |
| 3. In handlePointerMove, set `drewRef.current = true;` after `ctx.stroke();` | DONE | `src/app/interview/Scratchpad.tsx:85` |
| 4. handlePointerUpOrCancel: wrap in `if (drewRef.current)` block | **DEVIATES** | `src/app/interview/Scratchpad.tsx:100-102` |
| **D1. Remove stray failed edit** | | |
| case "failed" is exactly `chunker.reset(); break;` | DONE | `src/client/voice/voice-controller.ts:332-334` |
| No `interjectBaseline = null;` in case "failed" | DONE | Verified (no extra line) |
| **T1. Test files byte-identical** | | |
| `background-runner.test.ts` | DONE | SHA-256: F76A95019AB4984A... |
| `voice-interjection.test.ts` | DONE | SHA-256: FCF08D6331E5330F... |
| `e2e-mid-answer.test.ts` | DONE | SHA-256: A8EABEC9656CA672... |
| `turn-controller.test.ts` | DONE | SHA-256: 6BF8228161B23D52... |
| `interview-model.test.ts` | DONE | SHA-256: 1B7E7E9B2AB74585... |
| **Frozen files unchanged** | | |
| `interview-model.ts` SHA-256 | DONE | `a64bd019` matches ✓ |
| `use-interview.ts` SHA-256 | DONE | `a6439cc4` matches ✓ |
| `background-runner.ts` SHA-256 | DONE | `ba485205` matches ✓ |
| `turn-controller.ts` SHA-256 | DONE | `68fd7bf7` matches ✓ |
| `InterviewScreen.tsx` SHA-256 | DONE | `0789eeab` matches ✓ |

## Weakened tests

None. Test files were replaced byte-for-byte with reviewer versions, and test count increased.

## Builder notes

From `STAGE8_NOTES.md` Review 1 section:
- Lists B1 fix (drewRef tracking) ✓
- Lists D1 fix (removed stray line) ✓
- Lists T1 test file copies with SHA-256 hashes ✓
- Notes correctly state what was changed ✓

## Issues for the builder

### Issue 1: B1 incomplete - missing `if (drewRef.current)` guard

**What is wrong:** The SPEC (B1 step 4) requires the `handlePointerUpOrCancel` to replace:
```ts
    // If we drew at least one segment, set hasInk and call onChange
    hasInkRef.current = true;
    onChange(getImage);
```
with:
```ts
    // If we drew at least one segment, set hasInk and call onChange
    if (drewRef.current) {
      drewRef.current = false;
      hasInkRef.current = true;
      onChange(getImage);
    }
```

**Current code** (`src/app/interview/Scratchpad.tsx:100-102`):
```ts
    // If we drew at least one segment, set hasInk and call onChange
    hasInkRef.current = true;
    onChange(getImage);
```

**What the SPEC requires:** The `hasInkRef.current = true;` and `onChange(getImage);` lines must be wrapped inside an `if (drewRef.current)` block, and `drewRef.current = false;` must be added inside that block. The current code still sets `hasInkRef.current = true` and calls `onChange` on every pointer-up regardless of whether a segment was drawn.

**Fix:** Replace lines 100-102 with the exact code from the SPEC:
```ts
    // If we drew at least one segment, set hasInk and call onChange
    if (drewRef.current) {
      drewRef.current = false;
      hasInkRef.current = true;
      onChange(getImage);
    }
```

## For the reviewer

1. The builder added `drewRef` and set it correctly in `handlePointerDown` (line 46) and `handlePointerMove` (line 85), but failed to add the conditional guard in `handlePointerUpOrCancel`. The tap-without-movement bug is still present.

2. D1 (voice-controller.ts case "failed") is correctly fixed: only `chunker.reset();` and `break;` remain, no stray `interjectBaseline = null;`.

3. All five T1 test files are byte-identical to their `.txt` sources.

CHECK: FAIL (1 issue)
