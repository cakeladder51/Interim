# Stage 1 re-review 4: last fixes (handoff to the external model)

Re-reviewed on 2026-10-26. Typecheck, lint (0 warnings), tests (47/47) and build all pass.

**Verified fixed:** S1. The `logged` flag in `chatStream` gives exactly one log line on every path. All S2 tests are present.

**Temporary-revert checks:** each fix was reverted one at a time, the relevant tests were run, and the files were restored byte for byte.

| Reverted fix | Caught by the tests? |
|---|---|
| F1 (SDK abort → timeout) | yes, 6 tests fail |
| F2 (silent stream timeout) | **no**, all 11 pass |
| S1 (never-responds log) | yes |
| R1 (chatJSON failure logging) | yes |
| 400 no-retry | yes |
| F5 (`at` = 0) | yes |
| F6 (tokens keep spaces) | yes |

## T1. The "stall after headers" tests never actually send headers (`tests/meta.sdk.test.ts:43-51`)

In `stall-stream` mode, the server calls `res.writeHead(200, …)` and returns. Node doesn't send headers until the body is written or flushed, so the client never receives them. These requests therefore behave exactly like `hang` (never responds), and the **silent-end path that F2 fixed is never exercised.**

**Confirmed:** with `res.flushHeaders()` added, the current code passes all 11 tests, and reverting F2 makes 2 tests fail. Without it, reverting F2 makes none fail.

**Fix:**
1. In `stall-stream` mode, call `res.flushHeaders()` right after `writeHead`. This covers both the `chatStream` stall test and the stall logging test.
2. Add a mode `partial-then-stall`:
   - flush headers
   - write two delta chunks (`"Hello "`, `"world"`)
   - then write nothing more and don't end the response

   Then add a test calling `chatStream({ firstTokenTimeoutMs: 1000, totalTimeoutMs: 300 })` that asserts:
   - the tokens collected before the throw are `["Hello ", "world"]`
   - it throws `MetaError{code:"timeout"}`
   - exactly 1 `model_call` line is logged, `ok:false`

   This is the real-world failure: the model stalls mid-reply.

## T2. Housekeeping: stray files written into the repo

An `acl-repair/` folder appeared in the repo root during the last fix pass:
- `acl-backup-*.json`
- `acl-backup-*.json.ps1` (an 800-line PowerShell ACL repair script)
- `acl-report-*.jsonl`

According to its report, a sandbox ACL repair tool ran against `D:\CodeFiles\Interim` and **added a FullControl allow entry for the current user to the repo folder's permissions** (`grant_dacl` completed and verified; recovery script included). It isn't app code, isn't covered by `.gitignore`, and isn't in the allowed file list.

**For the external model:**
- Don't run permission or ACL tooling against this repo.
- Don't write tool output into the repo.
- Only touch the paths allowed by the stage brief.

**For the user (not the external model):**
- Decide whether to keep that permission change.
- Move `acl-repair/` out of the repo. Keep the backup `.json` and recovery `.ps1` somewhere safe if you might want to restore the original permissions.
- Don't commit the folder.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- Reverting F2 (making the silent-timeout check unreachable) makes the stall tests and the new partial-then-stall test fail.
- There is no `acl-repair/` folder or other stray file in the repo.
