# Reviewer handoff: Interim voice-tutor build

Read this file first, then `agent-os/specs/2026-10-26-1914-voice-tutor-engine/stages/STATUS.md`, then the current stage's brief (and its latest `-review-N.md`), then the round's checker report (`agent-os/checker/reports/`, see §5). Read nothing else unless a step below needs it.

## 1. Roles and the loop
- **External model (builder):** implements one stage at a time from a brief. It starts in a **fresh session** each stage, given `plan.md`, `STATUS.md` and the brief, so it has no memory of earlier stages.
- **You (reviewer/planner):** you never write app code. You review each build, then write one of two things: a fix list (`stage-NN-review[-K].md`) or, if the stage is 100% up to standard, the next stage's brief (`stage-NN-<slug>.md`).
- **Orchestrator:** relays messages between you and the builder, and passes on Adi's instructions.
- **Adi's standing rules:**
  - **One stage at a time,** until it is 100% up to standard.
  - **Stages may advance autonomously** when the stage is complete.
  - **Held items:** anything needing **API keys** (Meta `MODEL_API_KEY`, OpenAI) or **public deployment** (Vercel, Fly) is **held**. It must never be done or attempted. It doesn't block marking a stage complete; list it under "Held items" in `STATUS.md`.
- **Spec folder:** `agent-os/specs/2026-10-26-1914-voice-tutor-engine/`. It contains `plan.md` (historical; out of date in places, so briefs override it), `subproblems.md` (the stage map), `stages/` (briefs, reviews, STATUS) and `visuals/`.

## 2. Review method (do all of it, every review)
1. **Leftover state:**
   - Re-hash `src/`, `relay/`, `configs/`, `evals/` and `scripts/`, and compare against the hashes recorded in `STATUS.md`.
   - If an earlier revert run was killed, run that stage's mutants script with `--restore`, and byte-verify before reviewing.
2. **Scope:**
   - List the files changed since the review or brief file was written: `find . -path ./node_modules -prune -o -path ./.next -prune -o -path ./.git -prune -o -path ./.bridge -prune -o -type f -newer <brief-or-review.md> -print`.
   - Every changed file must be in the brief's allowed list. **Frozen files must be byte-identical:** check SHA-256 against the hashes in `STATUS.md`.
   - **When a frozen file is unfrozen for a small change,** confirm that *only* that change happened. Reverse the requested edit in memory and check that the result reproduces the recorded pre-change hash.
3. **Checks:**
   - `npx tsc --noEmit`, `npx eslint` (0 warnings), and `npx next build` (with no keys set).
   - **`npx vitest run` must EXIT 0 and print no `Errors` / "Unhandled Rejection" line.** Pass counts alone are not enough: Stage 4 passed review with 3 unhandled rejections and a vitest exit code of 1.
   - Get the exit code by spawning vitest from a node script (the shell blocks `$?` in compound commands).
4. **Test names, file by file:**
   - Run `npx vitest run --reporter=json --outputFile=<tmp>.json`.
   - Diff the per-file test names against the previous round's JSON. **No name may disappear.** The builder has "rewritten" test files and silently dropped required tests; Stage 3 lost 11 that way.
5. **Read every changed file** (only the changed files and hunks). Compare it rule by rule against the brief. Look for real bugs, not just brief conformance.
6. **Reproduce suspected bugs** with a small probe script against the real code, using localhost only. Report "reproduced: …" with the exact observation. Examples: the Stage 6 session-count bypass, an upstream left CONNECTING that still sent the API key, and the `parseSSE` unhandled rejection.
7. **Temporary reverts:** use the stage's saved script `agent-os/review/stage-NN-mutants.mjs` (see section 5).
   - Every brief rule needs a test that fails when the rule is reverted.
   - Report each miss as a test gap with the **exact test to add**.
   - Mark equivalent mutants as "equivalent" (no test needed) and say why.
8. **Content diffs.** When the brief gives fixed text (config content, prompts, fallback lines, script tables), diff the files against the brief **mechanically**: parse the brief's tables or code blocks, substitute the real values, and compare. Example scripts are listed in section 7.
9. **Security scans** (whenever UI or server boundaries change):
   - Scan `.next/static` and the prerendered output for secret config text (solution sketches, hints, probes, checkpoint text, misconception ids/signals/realign text, prompt text), and include a positive control so you know the scan reads real content.
   - Check that API keys, tokens and transcripts never appear in logs or client messages.
   - Check that the offline fake model can't be enabled in production: `INTERIM_FAKE_MODEL=1` must work under `next dev` and be ignored under `next start`. Start the servers from a node runner with `env` set, and kill them by PID only. **Never run `taskkill /IM node.exe`**: it kills unrelated processes and was rightly blocked.
10. **Verdict.**
    - **Fixes needed:** write `stages/stage-NN-review[-K].md`.
    - **Complete:** update `STATUS.md` (row, frozen hashes, held items, notes), then write the next brief.

## 3. Lessons learned (the builder's habits and the traps)
- **It edits expectations to match its own wrong output.** In Stage 5 it rewrote script word counts and baselines and started "matching the engine". Every fix list must say: *the brief is correct; never edit an expectation to make a test pass; if something still fails, stop and write it in `STAGE<N>_NOTES.md`.* Before blaming the builder, verify the brief itself against the frozen code (Stage 5: replay brief-correct copies of the scripts in a temp dir).
- **Give exact data, not instructions to compose it.** Fixed text (prompts, fallbacks, config content, student utterances) goes into briefs **verbatim**, with **verified word counts**. The builder looped for 18 minutes counting words. Count with `text.split(/\s+/).filter(Boolean).length`, and make sure each partial text extends the previous one.
- **It drops required tests during rewrites** and weakens tests into tautologies, for example `expect([a,b]).toContain(x)`, shallow `Object.freeze` called "deep freeze", or snapshot comparisons against objects that were never passed in. Revert checks catch these.
- **Tests that compare constants to themselves** (`expect(x).toBe(CONST)`) don't pin values. Ask for literal values.
- **Fakes can hide bugs.** A single-connection fake can't test multi-session logic; a fake that never flushes headers can't test the "stalls after headers" path. Check the fakes when a revert isn't caught.
- **Each brief must be self-contained:** a "What already exists" section with exact APIs, contracts and conventions, a note that `plan.md` is historical, an allowed-files list, the frozen-file rule, "add tests; don't delete or weaken any", and numbered acceptance criteria that include *vitest exits 0 with no Errors line*.
- **Next 16 traps:**
  - `cacheComponents: true` rejects `export const runtime`/`dynamic`.
  - Reading `searchParams` must happen inside `<Suspense>`.
  - Route files may only export route names.
  - `next dev` writes `AGENTS.md` into the repo (known; it's for Adi to commit or ignore).
- **Shell/tool limits:**
  - Compound shell commands containing `$?`, inline env vars (`X=1 cmd`), `xargs`, `awk` and similar need approval. Use node scripts for anything non-trivial.
  - npm via bash hits a `tokf` wrapper ("program not found"), so call `npx` binaries directly.
  - Run tsx probes from the repo root with `npx tsx --conditions=react-server` for code that imports `server-only`.
  - Import `ws` in probes via `D:/CodeFiles/Interim/node_modules/ws/index.js`.
- **Background jobs are hard-killed at 10 minutes.** A killed revert run once left `src/server/fake-model.ts` mutated; it was recovered by matching the recorded hash. Always use on-disk backups, chunk runs, and re-hash after any killed run.

## 4. File conventions
- **Briefs:** `stages/stage-NN-<slug>.md` (for example `stage-06-asr-relay.md`).
- **Fix lists:** `stages/stage-NN-review.md`, then `-review-2.md`, `-review-3.md`, and so on. Each one lists what passed, then numbered fixes (B# for bugs, T#/G# for test gaps) with the exact change or test, a "Constraints for this pass" section (allowed files; everything else frozen), and "Acceptance".
- **`STATUS.md`** (in `stages/`):
  - A table with columns `Stage | Status | Brief | Reviews`. A completed stage's row records the **frozen SHA-256 prefixes** of its files.
  - Then the sections `Held items (waiting for Adi)`, `Housekeeping for Adi`, `Notes carried forward` and `Review efficiency rules`.
- **Builder notes:** `STAGE<N>_NOTES.md` at the repo root. Read them, and answer any questions in your review.
- **The VERDICT line** is the exact last line of every review reply, one of:
  - `VERDICT: FIXES <review file name>`
  - `VERDICT: STAGE COMPLETE, NEXT <stage brief file name>`

## 5. Review efficiency rules (new; mandatory)
- **Revert checks are saved, not regenerated.** Each stage has a reusable script at `agent-os/review/stage-NN-mutants.mjs` (outside the app code). It:
  - applies each revert and runs only the relevant test files
  - restores and byte-verifies every file, and keeps on-disk backups (`--restore` after a kill)
  - accepts `--only=<groups>` so each run stays under 10 minutes
  - prints only `caught X/Y`, plus one line per missed or skipped revert
- **First review of a stage:** write the script and run the full sweep. **Re-reviews:** run the saved script in chunks, plus *new* reverts for the lines changed in that fix round. Append the new ones; don't rewrite the existing ones. "SKIPPED (NOT FOUND)" means the code moved: re-anchor that entry.
- **Delegate mechanical, long-output work** (revert sweeps, bundle scans, full test runs) to a subagent on a cheaper model, and bring back only the summary.
- **Keep context small:** tail and grep command output; read only changed files or hunks; never print whole test logs.
- **Each stage gets a fresh reviewer session**, which reads this file, `STATUS.md` and the stage brief first.
- **Headless: no background subagents or jobs; the turn must not end until the review is done.** The reviewer runs headless (`claude -p` via a bridge), so ending the turn kills the process, including any background subagent mid-revert. This happened on 2026-10-27: `server.ts` was left mutated and was restored with `--restore`. Run subagents and long commands in the foreground only, and start every review with the hash and backup check.
- **Leftover check before any `--restore`.** A restore copies the backups over the source, so if the builder changed files after your last run, it would overwrite their work. First compare the current files with the backups (`agent-os/review/stage-08-leftover.mjs` is the template). Restore only if a file differs **and** its mtime matches your interrupted run.

### Pre-review checker (since Stage 8, Adi's decision to cut reviewer tokens)
- **What it is.** A GLM "checker" session in the DeepSeek harness runs after every builder round, before you see the work. Its instructions are `agent-os/checker/CHECKER.md`, and it writes `agent-os/checker/reports/sNN-rK-check-M.md`. It checks:
  - changed files against the allowed list and the frozen files (`agent-os/checker/snapshot.mjs`)
  - build health with `checks.mjs`
  - every spec item one by one, with file:line evidence and exact strings and vectors
  - byte-identity of reviewer-supplied test files
  - weakened tests
  - the builder's notes

  If it fails, the builder fixes and the checker re-runs, without involving you. **You only see rounds that passed** (`CHECK: PASS`).
- **How to use it:**
  - Read the latest report for the round first.
  - Don't redo its mechanical work: compliance tables, scope lists, exact-string greps, the `checks.mjs` run.
  - **Spot-check 2–3 of its claims**, the ones most likely to be wrong. Re-run `checks.mjs` only if a claim looks doubtful or the source changed after the report. Compare hashes and mtimes against the report time.
  - Spend your effort on what it can't judge:
    - bugs, including races, lifecycle and edge cases
    - whether the tests can actually fail (the saved `stage-NN-mutants.mjs`)
    - spec ambiguities
    - its "For the reviewer" notes
- **Known blind spots** (Stage 8, round 1):
  - It reported "exact compliance" but missed an off-brief extra line in an unfrozen file. Always diff unfrozen files against pre-stage copies.
  - It judged a real spec deviation "acceptable" (the Scratchpad tap with no movement).
  - It can't see tautological new tests; "no weakened tests" only means existing assertions weren't loosened.
  - Its first report inferred "no names lost" from totals, against its own rule; the re-check fixed it.
  - Its snapshot lists spec and status files as "modified" when they're newer than its `since` time; that's harmless.
- **Files outside the builder's scope can change between rounds.** Adi and the orchestrator also edit the repo; Stage 8 saw `.env.example` gain a key after the checker ran. Re-hash frozen files yourself at the start of every review.

## 6. Current state and pending work (as of 2026-10-29)
- **Stages 1–11: COMPLETE; the build is complete** (see the end of this section). Held items are in `STATUS.md` and `stages/HANDOVER-FOR-ADI.md`.
  - Stage 6 completed on 2026-10-28 after 3 fix rounds.
  - Final: vitest exits 0 (580 tests); server reverts 41/42 (1 equivalent); every relay reproduction holds.
  - Frozen hashes are in the STATUS row.
  - The `tsconfig.json` exclude of `agent-os/review` is accepted (`28727cb8`). Reviewer `.ts` probes there aren't type-checked by the app, but **eslint does lint them**, so keep them free of `any`.
- **Known intermittent failure (pre-existing, Stage 3 test; not a product bug):** `tests/step-route.test.ts` › "step-handler abort mid-speak: no events after abort, no unhandled rejection".
  - **Frequency:** it failed once in 3 full-suite runs on 2026-10-28 ("expected 4 to be ≤ 3"). It passes 8/8 in isolation.
  - **Reproduced:** `npx tsx --conditions=react-server agent-os/review/step-abort-probe.ts` under CPU load gave 1/300 runs with `move,token:First,token:Second,done`. The abort on the test's `AbortController` didn't reach the derived `Request.signal` that the handler reads. Suspected cause: undici holds the follow-controller weakly.
  - The handler itself checks `signal.aborted` before every event.
  - **Action:** if the full suite fails only on this test, re-run it and record the flake. Never accept a builder edit that weakens it. A proper fix (abort via a path that doesn't depend on `Request` signal-following) is a Stage 11 item, and could be pulled earlier if it keeps recurring.
- **Stage 7 (voice in/out, M2): COMPLETE** (2026-10-28, 3 rounds).
  - **Final:** vitest exits 0 (694). Reverts 157/163; the 6 misses are documented equivalents (listed in the STATUS row).
  - Frozen hashes are in the STATUS row. `interview-model` is now `5baca0e9` and `use-interview` is `fc6ddf83`.
  - **Saved tools:** `stage-07-mutants.mjs` (groups pcm, chunker, relayclient, tts, controller, ttshandler, model) and `stage-07-tests/*.txt`. Three test files must stay byte-identical to their `.txt` sources: `voice-relay-client`, `voice-tts-player` and `voice-controller`.
  - **The name-diff baseline for Stage 8** is `%TEMP%/interim-review/vitest-s7r3.json` (694 tests).
- **Stage 8 (mid-answer + canvas, M3): COMPLETE** (2026-10-28, 2 rounds; checker reports `agent-os/checker/reports/s08-r{1,2}-check-*.md`).
  - **Final:** vitest exits 0 (788). Reverts **126/133**; the 7 misses are labelled EQUIVALENT in `stage-08-mutants.mjs`.
  - **Round 1 fixes:**
    - **B1:** a Scratchpad tap with no movement sent a blank canvas
    - **D1:** a stray voice-controller line
    - **T1:** the builder's tests were weak (90/133), so 5 reviewer test files replaced them
  - Frozen hashes are in the STATUS row. Five Stage 8 test files must stay byte-identical to `agent-os/review/stage-08-tests/*.txt`.
  - **Saved tools:**
    - `stage-08-mutants.mjs` (groups model, bgrunner, turn, voice; each under 6 min)
    - `stage-08-validate-tests.mjs`, `stage-08-validate-ref.mjs`, `stage-08-pristine.mjs`, `stage-08-unfreeze.mjs`, `stage-08-leftover.mjs`
  - **Name-diff baseline for Stage 9:** `%TEMP%/interim-review/checker-s08-r2b.json` (788 tests).
  - **Lesson:** for async or state-machine modules, the builder's own tests are usually weak. Budget for writing reviewer test files in round 1, verified against `src` and the mutants with `--reviewer`.
- **Stage 9 (feedback, A6/B7): BRIEF WRITTEN** (`stages/stage-09-feedback.md`, 2026-10-28).
  - **Server:**
    - `src/shared/feedback-protocol.ts`: `FeedbackViewSchema`, `FeedbackRequestSchema`
    - `src/server/feedback.ts`: the verbatim prompt `buildFeedbackMessages`; `toFeedbackView` (rules V1–V6: rubric-order criteria, scores must be level scores, key moments must quote a student line at the same `at`); `noAnswerView`; `generateReport` (`chatJSON` with `retry:false`, 20 s)
    - `fake-feedback.ts`: `fakeReport`, where the score index is `floor(n/3)`
    - `feedback-handler.ts` (rules H1–H8): 413/400/`not_finished`; no student lines → `noAnswerView` with no model call; 2 attempts, retrying invalid or retryable errors after 400 ms; 502 `feedback_failed`
    - `feedback-deps.ts`: the same fake gating as `deps.ts`
    - route `/api/feedback`
  - **Client:**
    - `feedback-client.ts`: `fetchFeedback` (C1–C3), `describeFeedbackError`, `formatAt`, and the runner (R1–R6). `start` never emits, to avoid a synchronous `setState` in an effect.
    - `FeedbackPanel.tsx`
    - 3 exact edits to `InterviewScreen.tsx` (pre-stage `0789eeab`)
  - **Reviewer's files:**
    - `agent-os/review/stage-09-ref.mjs`: the reference `toFeedbackView`/`noAnswerView`/`fakeReport`/`formatAt`/prompt. It prints every brief vector. **Never hand it to the builder.**
    - `agent-os/review/stage-09-vectors.ts`: the e2e row against the frozen engine (`npx tsx --conditions=react-server agent-os/review/stage-09-vectors.ts`).
  - **Stage 9 first-review checklist** (after the checker passes):
    1. Read the checker report and spot-check 2–3 of its claims.
    2. Re-hash: every STATUS frozen row, including the Stage 8 row and the 8 reviewer `.txt` test copies (Stage 7's 3 and Stage 8's 5). Diff `InterviewScreen.tsx` against a pre-stage copy: recover `0789eeab` with `stage-08-pristine.mjs` after adding it to that script's `want` map, or from the checker snapshot. The only differences allowed are the 3 §7 edits.
    3. Run the builder's `feedback-view`/`fake-feedback` tests against `stage-09-ref.mjs`. Adapt `stage-08-validate-ref.mjs`: re-point the imports in a temp copy, mapping `@/server/feedback` and `@/server/fake-feedback` to the ref.
    4. **Write `agent-os/review/stage-09-mutants.mjs`** (copy the Stage 8 format, with `--reviewer`). Groups:
       - `view`: V1–V6, prompt lines, `noAnswerView`
       - `fake`: `fakeReport` + `selectFeedbackDeps`
       - `handler`: H1–H8
       - `client`: C1–C3, `describeFeedbackError`, `formatAt`, R1–R6
       If the builder's tests are weak, write reviewer test files into `agent-os/review/stage-09-tests/`, as Stage 8 did.
    5. **Judgement areas:**
       - client files import nothing from `src/server`, `src/lib` or `src/config/load`
       - no `setState` synchronously in an effect
       - StrictMode double effect (start, abort, start) emits only once
       - the handler never retries after an abort
       - a missing key gives a 502 with `retryable:false`, not a 500 or an unhandled error
       - no transcript, quote or report text in logs
    6. **Bundle scan:** run the Stage 4 secret strings, plus `Model solution`, `admissions interviewer writing feedback` and `Return a JSON object with`, with a positive control (for example `Preparing your feedback`).
    7. **Offline probe** under `next dev`: POST `/api/feedback` with a done state gives the fake report, with an unfinished state gives 400 `not_finished`, and with no student lines gives `noAnswerView`. Under `next start`, the fake isn't used: expect a 502 with `retryable:false` with no key. Kill servers by PID only.
- **Stage 9 round 1 reviewed (2026-10-29): FIXES, `stages/stage-09-review.md`.**
  - **Fixes:**
    - **B1:** add `if (request.signal.aborted) break;` after the retry `sleep`; the handler must then hash to `2be0d88e`
    - **T1:** copy `agent-os/review/stage-09-tests/feedback-review.test.ts.txt` to `tests/feedback-review.test.ts`, byte-identical (`c0760525`)
    - **T2:** `toHaveBeenCalledWith(400)` in route test 3
  - **Everything else passed:**
    - scope; `InterviewScreen` reverses to `0789eeab`
    - the Stage 7/8 `.txt` copies are byte-identical
    - checks; names 788→850 with none lost
    - bundle; offline probe
  - **Re-review checklist:**
    1. Read the checker report and spot-check it.
    2. `node agent-os/checker/snapshot.mjs diff s09-r1-before`: only the round-1 files plus the 3 allowed files should differ.
    3. Check the handler hash `2be0d88e`, and diff the route test (T2 only).
    4. Run the name diff against `%TEMP%/interim-review/checker-s09-r1b.json` with `stage-09-namediff.mjs`; expect 873 tests.
    5. Run `stage-09-mutants.mjs --only=handler,fake`, then `--only=view`, then `--only=client` (no `--reviewer` flag needed once the file is in `tests/`; each run is under 6 min). Expect 166/168: the misses are the 2 EQUIVALENT entries.
    6. If clean, mark Stage 9 complete, record the frozen hashes, and write the Stage 10 brief.
  - **`.env.local` holds a real `MODEL_API_KEY`** (length 48) and `OPENAI_API_KEY`. In `next start` probes, only POST paths that never call a model (no student lines, unfinished), as `stage-09-offline.mjs` does.
  - **New tools:**
    - `stage-09-mutants.mjs` (groups view, fake, handler, client; `--reviewer` adds `stage-09-tests/*.txt`)
    - `stage-09-validate-tests.mjs [--lint] [--tsc]`
    - `stage-09-b1-temp.mjs apply|revert` (temporarily applies B1 to measure the reviewer tests; backup in `backup-s9-b1`)
    - `stage-09-unfreeze.mjs` (reverses the `InterviewScreen` edits and byte-checks the reviewer test copies)
    - `stage-09-namediff.mjs <old.json> <new.json>`
    - `stage-09-offline.mjs`
- **Stage 9: COMPLETE** (2026-10-29, 2 rounds; checker `s09-r2-check-1` PASS).
  - **Final:** vitest exits 0 (873). Reverts **166/168**; the 2 misses are labelled EQUIVALENT.
  - Frozen hashes are in the STATUS row. `tests/feedback-review.test.ts` must stay byte-identical to its `.txt` source.
  - `stage-09-mutants.mjs` now runs `feedback-review` in every group (no `--reviewer` flag needed).
  - **Name-diff baseline for Stage 10:** `%TEMP%/interim-review/checker-s09-r2.json` (873 tests).
- **Stage 10 (recording, B4/B8): BRIEF WRITTEN** (`stages/stage-10-recording.md`, 2026-10-29).
  - **Design:**
    - The consent dialog is `InterviewGate` on `/interview`, not the start page: permission prompts need a click on the recording page, and navigation drops streams. `InterviewScreen` (which auto-starts the interview) mounts only after Submit.
    - `recording-session.ts` is a DOM-free state machine (S1–S9, F1–F6, D1–D2, N1–N4).
    - `browser-recording.ts` holds the real deps. Its mixer is on the shared `getAudioContext()`, with TTS routed in through a new `setPlaybackTap` in `browser-audio.ts` (2 exact edits).
    - `RecordingBadge` and `RecordingDownloads` use `useSyncExternalStore`, so no `setState` happens in an effect.
    - **Known limitation:** `speechSynthesis` (the offline TTS) can't be captured.
  - **Unfrozen files and their expected hashes** (`stage-10-unfreeze.mjs` reverses the edits; it must reproduce the pre-stage hashes):

    | File | Before | After |
    |---|---|---|
    | `browser-audio` | `9e74711f` | `47d96cd3` |
    | `app/page` | `2ca9dfa5` | `d80d1428` |
    | `interview/page` | `5d3f77bd` | `bfe5ccf3` |
    | `InterviewScreen` | `ee37d724` | `6a52d4e5` |
  - **The reviewer supplied the tests up front** (the Stage 7/8 lesson): `agent-os/review/stage-10-tests/{recording-session,recording-format,recording-tap}.test.ts.txt` (24+5+2 = 31; `ff0e00b0`/`d2b389f7`/`48e93f08`).
    - They were verified against `agent-os/review/stage-10-ref/*.ts` (**never hand these to the builder**) with `stage-10-validate-ref.mjs` (31/31) and `stage-10-tsc-ref.mjs` (tsc 0); eslint is clean.
    - Sanity reverts on the ref (`stage-10-ref-mutants.mjs`): 6/7. The miss, "empty chunks counted", is equivalent, because size-0 blobs add no bytes.
  - **Stage 10 first-review checklist** (after the checker passes):
    1. Spot-check the checker. Re-hash every STATUS frozen row and all 12 reviewer `.txt` copies (Stage 7: 3, Stage 8: 5, Stage 9: 1, Stage 10: 3).
    2. Run `node agent-os/review/stage-10-unfreeze.mjs`: all 4 files must reverse to their pre-stage hashes.
    3. Run `node agent-os/review/stage-10-validate-ref.mjs --src` (the copied tests against the builder's code), then the name diff against `checker-s09-r2.json`; expect 904.
    4. **Write `stage-10-mutants.mjs`** in the Stage 9 format. Groups:
       - `format`
       - `session` (S1–S9, F1–F6, D1–D2, N1–N3; it may need `--part`)
       - `tap`
    5. **Read `browser-recording.ts`, `InterviewGate`, `RecordingBadge` and `RecordingDownloads` against §4/§5.** Look for:
       - `getTab` called before `getMic` inside the click
       - the mic never connected to `ctx.destination`
       - `setPlaybackTap(null)` on dispose
       - no browser API run at import
       - the Gate disposing on unmount
       - no `setState` in an effect
       - `subscribe`/`snapshot` working unbound
    6. **Offline `next dev` probe:** `/interview` SSR HTML contains "Before you start". Use HTTP only; real recording can't be driven headless.
    7. **Bundle:** the Stage 4 secret strings + the Stage 9 prompt strings are absent, with a positive control.
- **Stage 10 round 1 reviewed (2026-10-29): FIXES, `stages/stage-10-review.md`.**
  - **Fixes** (all in `recording-session.ts`; R1–R6 are exact replacements; the file must then hash to `d05c11bc`, and it's `ea510168` now):
    - **B1:** S3 used two sequential `allSettled` calls, so a tab refusal while the mic prompt is open was an unhandled rejection
    - **B2:** S5/S6 were applied as two changes
    - **B3:** `updateSnap` changed the snapshot after dispose (N3)
    - **B4** (a brief gap, now specified): `createMixer`/`combine` throwing rejected `start()`; `recorder.start()` throwing left a stored recorder, so `finish()` hung
    - **T1:** copy `agent-os/review/stage-10-tests/recording-review.test.ts.txt` (13 tests, `e16808a0`)
  - **Everything else passed:** scope, unfreeze, the 12 copies, checks (904), bundle, offline gate. The `stage-10-ref` session now includes the B4 rule (42/42 against the ref).
  - **Re-review checklist:**
    1. Read the checker report and spot-check it.
    2. `node agent-os/checker/snapshot.mjs diff s10-r2-before`: only `recording-session.ts`, `tests/recording-review.test.ts` and `STAGE10_NOTES.md` should differ.
    3. Check `recording-session.ts` = `d05c11bc` (the reviewer's patched copy hashed to exactly this; `node agent-os/review/stage-10-fix-temp.mjs` re-derives it from `ea510168`), then run `node agent-os/review/stage-10-copies.mjs` (expect 13 identical).
    4. Run the name diff against `checker-s10-r1-check2.json` with `stage-09-namediff.mjs`; expect 917.
    5. **Re-anchor `stage-10-mutants.mjs`:** R2–R6 move the entries for S3, S5/S6, S8 (`mixer = deps.createMixer`, `combine`, `startRecorder`, onstop, timeslice, recording) and "no recorder: mixer kept". Use `--dry` to list the SKIPPED ones. Append B1–B4 reverts: two sequential awaits, S5/S6 split, the `if (disposed) return;` in `updateSnap` removed, the `createMixerOrNull` catch rethrowing, `recorders[kind] = recorder` moved before `start()`. Then run `--only=format,tap` and `--only=session --part=1/2` and `--part=2/2` (`recording-review` joins the session group automatically once it's in `tests/`). Expect every miss to be EQUIVALENT (the empty-chunks entry, and F3-sync if it still holds).
    6. If clean, mark Stage 10 complete (frozen hashes are in the round-1 STATUS row plus `d05c11bc`; 4 test files byte-identical), then write the Stage 11 brief.
  - **New tools:** `stage-10-mutants.mjs` (groups format, session, tap; `--reviewer`, `--skip-bugs`), `stage-10-probe.ts` (B1–B4 reproductions; `npx tsx`), `stage-10-fix-temp.mjs` (applies R1–R6 temporarily and checks them; `--restore`), `stage-10-offline.mjs` (build + bundle scan + dev gate probe), `stage-10-copies.mjs` (the 12 or 13 reviewer copies), `stage-10-gapcheck.mjs`.
- **Stage 10: COMPLETE** (2026-10-29, 2 rounds; checker `s10-r2-check-1` PASS).
  - **Final:** vitest exits 0 (917, no names lost). Reverts: format 18/18, tap 4/4, session 78/81. The 3 misses are labelled EQUIVALENT in `stage-10-mutants.mjs` (S8 anchors re-anchored to `d05c11bc`; B1–B4 reverts appended).
  - Frozen hashes are in the STATUS row. Four `tests/recording-*.test.ts` files must stay byte-identical to their `.txt` sources; `stage-10-copies.mjs` checks all 13 reviewer copies.
  - **Name-diff baseline for Stage 11:** `%TEMP%/interim-review/checker-s10-r2.json` (917 tests).
- **Stage 11 (hardening, I2/I3): BRIEF WRITTEN** (`stages/stage-11-hardening.md`, 2026-10-29). The deploy part (I3) is held.
  - **H1:** in `meta.ts`, a `serverEnv()` wrapper turns `getServerEnv`'s plain `Error` into `MetaError("config", msg, false)`; the 3 calls are replaced (`81491a95` → `92eaa326`). A missing key then gives null assessments and fallback lines, not `error{internal}`.
  - **H2:** the "abort mid-speak" test passes a stand-in `{ headers, json, signal: controller.signal }` and asserts the events are exactly `["move","token"]` (`3d0bbce8` → `1a297fcd`).
  - **H3:** `CLAUDE.md` = `agent-os/review/stage-11-files/CLAUDE.md.txt` (`96b8526b`).
  - **Reviewer test:** `agent-os/review/stage-11-tests/config-error.test.ts.txt` (4 tests, `cb0b89f0`). `node agent-os/review/stage-11-temp.mjs --before` shows 4/4 failing on today's code. Without the flag, it applies H1+H2 temporarily: tsc 0, eslint 0, 94/94 across config-error, step-route, meta, meta.sdk, speak, assess, e2e-text-interview and feedback-route. Then it restores. Expected total: 921.
  - **Stage 11 first-review checklist** (after the checker passes):
    1. Spot-check the checker. Re-hash the STATUS frozen rows; `stage-10-copies.mjs` should give 13, plus `config-error` and `CLAUDE.md` byte-identical to their sources.
    2. Check `meta.ts` = `92eaa326` and `step-route.test.ts` = `1a297fcd` (`stage-11-temp.mjs` holds the exact edits, as `H1_HELPER`/`H2_*`).
    3. Run the name diff against `checker-s10-r2.json`; expect 921.
    4. **Write `stage-11-mutants.mjs`** (one group, `meta`): drop the wrapper's catch (rethrow), `retryable: true`, the wrong code, and each of the 3 call sites reverted to `getServerEnv()`. Run config-error + meta + speak + assess. Note: reverting `getMetaClient`'s call alone may be equivalent in the tests that inject a client; check it.
    5. Run `flaky-check.mjs tests/step-route.test.ts 20` (it should be stable now) and `step-abort-probe.ts` as a reference.
    6. Offline probe: `next start` with **no key in the env** can't be used, because `.env.local` holds real keys and Next loads it. Rely on the in-process drill test. Never POST a path that reaches the model.
    7. If clean, mark Stage 11 complete and the MVP demo-ready (held items excepted), and tell Adi which held items remain.
- **Stage 11: COMPLETE** (2026-10-29, 1 round; checker `s11-r1-check-1` PASS). **The build is complete: no buildable stages remain.**
  - **Scope:** the snapshot diff against `s11-r1-before` shows only the 5 allowed files. All 13 reviewer copies are byte-identical, plus `config-error` and `CLAUDE.md`.
  - `meta.ts` `92eaa326` and `step-route.test.ts` `1a297fcd` are exactly the reviewer's own patched copies.
  - **Checks:** vitest exits 0 (921, no names lost).
  - **Reverts:** `stage-11-mutants.mjs` caught 8/8.
  - **H2:** `flaky-check` passed 20/20.
    - The H2 test bites only when every abort layer in `step-handler` is reverted at once: the abort listener, the 3 stream guards and `runStep`'s speak-loop check. Each layer alone is an equivalent revert, because the layers overlap.
    - Probe: `%TEMP%/interim-review/s11-h2-bite.mjs`.
  - **What's left is all held:** live model, TTS and relay checks, real-browser QA, and the Fly and Vercel deploys. Adi has them as an ordered checklist with commands in `stages/HANDOVER-FOR-ADI.md`.
  - **If Adi brings back a live-check failure** (for example a wrong Meta ASR field mapping, or eval misses), treat it as a new fix stage: write a brief in the usual format, and keep every frozen hash unless the brief unfreezes a file.

## 7. Useful existing review scripts
**Saved in `agent-os/review/`** (durable; eslint lints them, so no `any`):
- `checks.mjs <new.json> <baseline.json>`: tsc, eslint, no-key `next build` (route presence), vitest exit code + Errors/Unhandled, and the per-file test-name diff. The JSONs live in `%TEMP%/interim-review`. Runs in about 5 min.
- `stage-06-mutants.mjs`: the reusable revert script. Flags: `--only`, `--label`, `--part=k/n`, `--dry`, `--restore`, `--list`. **Copy its format for `stage-07-mutants.mjs`.**
  - A server half takes more than 10 min. When the harness moves a command to the background, block on it **in the same turn** with a foreground node poll of the task output file until `restore:` appears.
- `stage-06-probe.ts`, `stage-06-probe-t3.ts`: relay reproductions. Run them with `npx tsx` from the repo root.
- `stage-07-ref.mjs`: reference implementations behind the Stage 7 brief's test vectors.
- `stage-07-mutants.mjs`: the Stage 7 revert script (same flags as Stage 6).
  - All 7 groups: pcm, chunker, relayclient, tts, controller, ttshandler, model. `controller` needs `--part=1/2` and `--part=2/2` to stay under 10 min.
- `stage-08-ref.mjs`: the reference Stage 8 turn controller + `hashString`. It prints the brief's V1–V15/H vectors. **Never hand it to the builder.**
- `stage-08-vectors.ts`: the brief's e2e table, run against the frozen engine and fake model.
- `stage-08-mutants.mjs`: the Stage 8 revert script (133 entries; groups model, bgrunner, turn, voice). Flags are as for Stage 7, plus `--reviewer`, which runs against `stage-08-tests/*.txt` copies. Each group takes under 6 minutes.
- `stage-08-tests/*.test.ts.txt`: the reviewer's Stage 8 test files. `*-additions.ts.part` are the blocks appended to the builder's turn and model tests.
- `stage-08-validate-tests.mjs [filter] [--lint] [--tsc]`: runs those `.txt` files against `src`.
- `stage-08-validate-ref.mjs [testfile]`: runs a turn-controller test file against `stage-08-ref.mjs`.
- `stage-08-pristine.mjs`: recovers pre-stage sources from `.next` source maps (`sourcesContent`) by hash. Use it when there's no backup.
- `stage-08-unfreeze.mjs`: reverses the §1 edits to `interview-model` (giving `5baca0e9`).
- `stage-09-ref.mjs` / `stage-09-vectors.ts`: the Stage 9 reference and the e2e check (see §6).
- **Stage 9 tools:**
  - `stage-09-mutants.mjs`: 168 entries; groups view, fake, handler, client; each under 6 min
  - `stage-09-namediff.mjs <old.json> <new.json>`: the per-file test-name diff
  - `stage-09-offline.mjs`: the dev/start feedback probe (no-model paths only under `start`)
  - `stage-09-validate-tests.mjs`, `stage-09-unfreeze.mjs`, `stage-09-b1-temp.mjs`
- **Stage 10 tools:**
  - `stage-10-ref/` (the reference; never hand it to the builder)
  - `stage-10-tests/*.txt`
  - `stage-10-validate-ref.mjs [--src] [--lint]`
  - `stage-10-tsc-ref.mjs` (pre-build only; it refuses once `src/client/recording` exists)
  - `stage-10-ref-mutants.mjs`
  - `stage-10-unfreeze.mjs [--forward]`
- `stage-08-leftover.mjs`: compares mutant targets with `backup-s8` and lists temp test copies, without restoring anything.
- `stage-07-validate-tests.mjs` + `stage-07-tests/*.test.ts.txt`: the reviewer's Stage 7 test files and their runner (`ref` = `%TEMP%/interim-review/s7-ref`, `src` = the builder's code).
- **In `%TEMP%/interim-review` (may be gone):**
  - `s7-offline.mjs`: offline `next dev` probe
  - `s7-hash.mjs`: frozen-prefix check
  - `s7-unfreeze.mjs`: reversal of the unfrozen edits
- **Stage 11 tools:** `stage-11-mutants.mjs` (group `meta`, 8 entries, about 2 min; `--restore`, `--dry`, `--label`), `stage-11-temp.mjs` (the H1/H2 edits; `--before`).
- `flaky-check.mjs <testfile> <n>`: re-runs one test file n times.
- `step-abort-probe.ts`: the intermittent abort-test reproduction (see §6).

**Older scripts** are reference only; they live in `%TEMP%\interim-review\` and may be gone:
- `vitest-exit.mjs`: the full-suite exit code and Errors line.
- `leak-scan.mjs`: scans the bundle for secret config text.
- `run-servers.mjs` + `e2e-http.mjs`: `next dev`/`next start` with `INTERIM_FAKE_MODEL=1`, a 12-step interview over HTTP, and production gating.
- `config-diff.mjs`, `prompt-diff.ts`, `s5-expected.mjs`/`s5-diff.mjs`: diffs of brief tables against files.
- `relay-probe.ts`: the Stage 6 B1/B2 reproductions.
- `mutate-stage{1,3,4,5,6}.mjs`, `mutate-fsm.mjs`: earlier revert scripts. Stage 6 is saved as `agent-os/review/stage-06-mutants.mjs`; earlier stages are complete and don't need saving.
