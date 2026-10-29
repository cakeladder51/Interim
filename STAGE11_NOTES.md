# Stage 11 Implementation Notes

## Changes Made

### H1: `src/lib/meta.ts` - env errors become `MetaError("config")`
- Added `serverEnv()` wrapper function that catches env errors and throws `MetaError("config", ...)` instead
- Replaced all three `getServerEnv()` calls with `serverEnv()`:
  - In `getMetaClient()` (line ~40)
  - In `chatJSON()` (line ~109)
  - In `chatStream()` (line ~259)
- SHA-256 after edit: `92eaa326...` ✓

### H2: `tests/step-route.test.ts` - fix flaky abort mid-speak test
- Replaced the `new Request(...)` instantiation with a stand-in object whose `signal` is the test's own `AbortController.signal`
- Added deterministic assertion: `expect(events.map((e) => e.event)).toEqual(["move", "token"])`
- SHA-256 after edit: `1a297fcd...` ✓

### H3: `CLAUDE.md` - project guide
- Byte-for-byte copy from `agent-os/review/stage-11-files/CLAUDE.md.txt`
- SHA-256: `96b8526b...` ✓

### New test file: `tests/config-error.test.ts`
- Byte-for-byte copy from `agent-os/review/stage-11-tests/config-error.test.ts.txt`
- 4 tests verifying H1: missing `MODEL_API_KEY` degrades gracefully
- SHA-256: `cb0b89f0...` ✓

## Verification

All acceptance criteria met:
1. Only allowed files changed (4 files), all hashes match expected
2. `npx eslint --max-warnings=0`: 0 problems ✓
3. `npm run typecheck`: passes ✓
4. `npm run build`: passes (no keys set) ✓
5. `npm test`: **921 tests** (917 + 4), exit code 0, no "Errors" line ✓

## Nothing Blocked

All tasks completed successfully with expected hashes.
