# Stage 5 review: finish a partial build (handoff to a FRESH external-model session)

Reviewed on 2026-10-27. The previous session stopped partway through. **Read this whole file before touching anything.** Every fix is spelled out, including the exact text to paste, so nothing needs searching, counting or guessing.

## Ground rules for this session (read first)
1. **The brief's step tables are correct.** The reviewer replayed brief-correct versions of all 8 scripts through the real, frozen engine, using this repo's own `src/eval` code: **all 8 pass**. Both earlier failures came from wrong word counts in the script files, not from the engine or the brief.
2. **Never edit an expectation to "match the engine".** Change only what this file lists. If anything still fails after these fixes, **stop**, and write the exact failure message into `STAGE5_NOTES.md`. Don't adjust `expect`, `mock` or `atMs` values to make it pass.
3. **Use the student texts below verbatim.** Their word counts are already verified (`countWords` splits on whitespace). Don't rewrite them.
4. **Frozen files:** everything under `src/` outside `src/eval/`, plus `configs/`, `scripts/latency.ts`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts` and `package-lock.json`. They are currently unchanged; keep them that way.
5. **Add tests; don't delete or weaken any.** Test names are compared.

## Current state (what the reviewer found)
- **The suite is broken:** `tests/regression.test.ts`, `tests/eval-live-mode.test.ts` and the "loads all 8 scripts" test fail, because `loadScripts` rejects `04-low-confidence-off-track.json`. Step 1 says `"words": 20`, but its text has 21 words. The schema check is correct; the file is wrong.
- **Scripts that differ from the brief:**
  - **`03`:** the word counts (17 and 28) and the expected `turnWordBaseline` (17) were changed away from the brief's (20, 26, 20).
  - **`04`:** the word counts are 14 and 21; the brief requires 15 and 30.
  - **`06`:** the word counts (22 and 27) and the expected `turnWordBaseline` (27) were changed away from the brief's (30, 40, 40). The step 0 `live` entry is also missing `"misconceptionId": null`.
  - **`02`:** the `live` entries are missing on steps 0, 2 and 4.
- **Extra expectations that are fine to keep:** extra `interviewerKind: "utterance"`, `hintRung` and `probesAsked` checks that the brief didn't list. They are correct and they pass, so **keep them**.
- **Allowed but wrong:**
  - `package.json`'s `eval` script uses `--env-file=.env.local`. Without a `.env.local` file, `npm run eval` dies with `node: .env.local: not found` (exit 9) instead of printing the hold message. The reviewer confirmed that `--env-file-if-exists` works (it exits 2 with the hold message).
  - `scripts/eval.ts` treats `--min-pass 0` as 0.8, because of `parseFloat(...) || 0.8`.
- **Not allowed:** `scripts/debug.ts` is outside the allowed file list.
- **Not done yet:** the final typecheck, lint and build.

---

## F1. Fix the script files (exact edits)

### `evals/scripts/03-misconception-mid-answer.json`
Replace the `event` of steps 0, 1 and 2, and the two `turnWordBaseline` values, **exactly** as follows. Keep everything else in the file.
- **step 0** `event`:
  `{ "type": "partial", "text": "So suppose root two equals p over q", "words": 8 }`
- **step 1** `event`:
  `{ "type": "partial", "text": "So suppose root two equals p over q then squaring both sides gives two equals p squared over q squared", "words": 20 }`
- **step 1** `expect.state`:
  `{ "lastInterjectAtMs": 26000, "turnWordBaseline": 20 }`
- **step 2** `event`:
  `{ "type": "partial", "text": "So suppose root two equals p over q then squaring both sides gives two equals p squared over q squared oh okay what am I missing", "words": 26 }`
- **step 2** `expect.state`:
  `{ "turnWordBaseline": 20, "lastInterjectAtMs": 26000 }`

### `evals/scripts/04-low-confidence-off-track.json`
- **step 0** `event`:
  `{ "type": "partial", "text": "I think I would just check every pair of numbers including a number with itself", "words": 15 }`
- **step 1** `event`:
  `{ "type": "partial", "text": "I think I would just check every pair of numbers including a number with itself because the same value could be used twice if it is exactly half the target", "words": 30 }`
- Change nothing else. Its expectations already match the brief.

### `evals/scripts/06-rambling-off-topic.json`
- **step 0** `event` (unchanged text):
  `{ "type": "partial", "text": "so about that football match last weekend you know the one where we won", "words": 14 }`
- **step 0** `live`:
  `{ "status": ["off_track"], "misconceptionId": null }`
- **step 1** `event`:
  `{ "type": "partial", "text": "so about that football match last weekend you know the one where we won because they parked the bus for ninety minutes and then we scored right at the end", "words": 30 }`
- **step 2** `event`:
  `{ "type": "partial", "text": "so about that football match last weekend you know the one where we won because they parked the bus for ninety minutes and then we scored right at the end and the whole crowd went completely wild after the whistle", "words": 40 }`
- **step 2** `expect.state`:
  `{ "lastInterjectAtMs": 33000, "turnWordBaseline": 40 }`

### `evals/scripts/02-right-first-time.json`
Add `"live": { "status": ["correct"] }` to **steps 0, 2 and 4**, the three full-answer `turn_complete` steps.

**Leave scripts 01, 05, 07 and 08 alone.** They already match the brief.

## F2. Delete `scripts/debug.ts`
It's a leftover debugging file, and it's outside the allowed list.

## F3. Fix the `eval` npm script (`package.json`)
Set it to exactly:
`"eval": "tsx --conditions=react-server --env-file-if-exists=.env.local scripts/eval.ts"`

Change nothing else in `package.json`.

## F4. Fix `scripts/eval.ts`
1. **Parse `--min-pass` properly.** Parse it with `Number(...)`. If the value is `NaN` or outside `[0, 1]`, print `--min-pass must be a number between 0 and 1` and `process.exit(1)`. **`0` must be accepted as 0**, and the default stays `0.8`.
2. **Show the actual result in the table.** Fill the "actual status" column with the live assessment's status (or `null`), and add a final `why` column from `scoreLive`. Keep `ScoreRow` and `summarize` as they are; build the display rows separately.
3. **Fix the misleading comment.** The comment says the key check runs "before importing". Static `import` statements are hoisted, so that's false. Replace it with an accurate comment: importing these modules performs no network or env access (`getServerEnv()` is lazy), and the key check runs before any call. Keep the check where it is.

## F5. Fix `src/eval/replay.ts`
1. **Add error context, as the brief requires.** Wrap each `runStepRequest` call. On any error, rethrow `new Error(\`Script ${script.id} step ${i}: ${original message}\`)`, using `start` instead of the index for the implicit start.
2. **Add a request hook** so the "no `words` key" invariant can be tested properly:
   - Add an optional `onRequest?: (body: unknown) => void` to `replayScript`'s `opts`.
   - The `fetchImpl` wrapper calls it with `JSON.parse(init.body)` before calling the handler.

## F6. Fix `src/eval/schema.ts`
1. **Name the refined schema `ScriptSchema`**, as the brief says. Rename the current unrefined object to `ScriptBaseSchema` (not exported), and export the refined one as `ScriptSchema`. Update `load-scripts.ts` and the tests to use `ScriptSchema`. The type `Script` stays `z.infer` of it.
2. **Use the contract `AssessmentSchema`** (`import { AssessmentSchema } from "@/contracts"`) instead of the local copy, so the two can't drift apart.
3. **Validate canvas images:** require `image` to start with `"data:image/png;base64,"` and be at most 1,500,000 characters. That's the same rule as the API contract, so a bad script fails at load time rather than with a 400 mid-replay.

## F7. Tests to add (keep all existing tests)
- **`tests/eval-score.test.ts`:** expected `misconceptionId: null` with an actual of `"lowest-terms-missing"` gives `pass: false` and why `"misconception lowest-terms-missing != null"`.
- **`tests/regression.test.ts`:**
  - **No `words` key:** replace the placeholder test with a real one. For every script, call `replayScript(script, { onRequest })`, collect every request body, and assert that no `event` object has a `words` key and that every partial event has exactly the keys `type` and `text`.
  - **Error context:** take a loaded script, clone it, and on a step where `assessCalled` is expected, **delete its `mock`** (bypassing the schema). Assert that `replayScript` rejects with a message containing both the script id and `step <i>`.
- **`tests/eval-cli.test.ts`:**
  - Assert that `package.json`'s `scripts.eval` contains `--env-file-if-exists=.env.local` and `--conditions=react-server`.
  - **Key-present path, no network:** create a temp directory with an empty `evals/scripts/` and spawn `node <repo>/node_modules/tsx/dist/cli.mjs --conditions=react-server <repo>/scripts/eval.ts`, with `cwd` set to that temp directory and `env` = `{ ...process.env, MODEL_API_KEY: "fake-key-no-network", TSX_TSCONFIG_PATH: <repo>/tsconfig.json }`.
    1. With no extra arguments: the exit code is `1` (pass rate 0 < 0.8) and stdout includes `Loaded 0 scripts`.
    2. With `--min-pass 0`: the exit code is `0`.
    3. With `--min-pass 2`: the exit code is `1` and the output includes `--min-pass must be a number between 0 and 1`.
    
    **Delete any `scripts/out/eval-*.json` files these runs create**: snapshot the directory before, and remove only the new files afterwards. Remove the temp directory too.
- **`tests/eval-schema.test.ts`:** a canvas step whose image doesn't start with `data:image/png;base64,` is rejected.

## F8. Update `STAGE5_NOTES.md`
Replace its contents with a short, accurate note:
- the script texts and word counts now come from `stage-05-review.md`
- `--env-file-if-exists` is used
- any remaining open questions, if there are any

## F9. Final checks (run all of them and report the results)
`npm run typecheck`, `npm run lint` (0 warnings), `npm test`, `npm run build` (without `MODEL_API_KEY`), and `npm run eval` without a key (it must print the hold message and exit 2).

## Acceptance
- All 8 scripts load and pass deterministically. The scripts match the brief's tables exactly, apart from the extra `interviewerKind`/`hintRung`/`probesAsked` checks noted above. The reviewer will diff them field by field.
- `npm run eval` without a key prints `MODEL_API_KEY is not set. The live eval is on hold until a key is available.` and exits 2.
- `scripts/debug.ts` is gone. Frozen files are byte-for-byte unchanged. `package.json` differs from before Stage 5 only in the `eval` script.
- No test name is removed. The reviewer will then run temporary reverts across `schema.ts`, `expect.ts`, `score.ts`, `replay.ts` and `scripts/eval.ts`, and edit script expectations to check that the suite catches them.
