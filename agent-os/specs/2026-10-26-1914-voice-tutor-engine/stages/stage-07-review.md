# Stage 7 review 1: fix list (voice in/out)

You're the external model, in a fresh session. Read `STATUS.md`, `stage-07-voice-io.md` (the brief) and this file. **The brief is correct. Never edit an expectation to make a test pass.** If something still fails after you apply a fix exactly as written here, stop and write it in `STAGE7_NOTES.md` (the failing test name and the actual output). Don't loop.

## What passed (keep it)
- **Typecheck and build:** typecheck passes, and the no-key build passes with `/api/tts` in the route list.
- **Bundle scan:** no `ws` server code, no `OPENAI_API_KEY` and no `api.openai.com` anywhere in `.next/static`. The positive control (the mic message) was found.
- **Offline under `next dev`, no keys:**
  - `POST /api/tts` → 503 `tts_unavailable` with `no-store`.
  - `POST /api/relay-token` → 503.
  - The worklet is served at `/audio/capture-worklet.js`.
  - The 12-step text interview passes over HTTP.
  - The only server log line is the one-time `OPENAI_API_KEY` warning.
- **Frozen files:** every one is byte-identical, and `interview-model.ts` reverses exactly to `98035e9d`.
- **`use-interview.ts`:** it contains exactly the brief's edits, but with a different layout (a multi-line `dispatch`, an extra comment), so it can't be byte-verified against `8e4f2ae0`. The reviewer accepts it as-is. **Don't edit `use-interview.ts` again.**
- **`pcm-encoder.ts`, `sentence-chunker.ts` and `capture-worklet.js`:**
  - They match the brief; every V1–V6 and C1–C11 literal is used.
  - Revert checks: pcm 12/13 (the remaining one, the float-ratio boundary, is equivalent: it never differs from the integer boundary for 22.05–96 kHz over an hour of audio), chunker 9/11 (see G1), model 2/2.
- **`tts-handler.ts`:** revert checks 22/27 (see H1 and G2).
- **No test name was lost** against Stage 6.

## Why the 20 tests fail: diagnosis
| File | Failing | Whose fault |
|---|---|---|
| `voice-relay-client.test.ts` | 9 of 12 | **The test.** It signs `exp` in **seconds** (`Date.now()/1000 + 120`), but relay tokens use epoch **milliseconds** (`src/shared/relay-token.ts`, `RELAY_TOKEN_TTL_MS = 120_000`; the relay checks `exp` against `Date.now()`). Every token was already expired, so the relay answered 4001. It has nothing to do with config loading. The brief should have said "ms"; that's now stated in the replacement test. Test 11 timed out because its fake socket never emitted `open`. **Two implementation bugs too:** R1 and R2. |
| `voice-tts-player.test.ts` | 5 of 9 | **The implementation** breaks brief §5 rules 1, 3, 5 and 6 (B1). The tests were also wrong: they use timers (the brief says no timers), test 1 compares an `ArrayBuffer` to a string, and **test 5 asserts `mode()` is `"provider"` where the brief says `"fallback"`. That's a weakened expectation, which is not allowed.** |
| `voice-controller.test.ts` | 6 of 20 | **The implementation** (B2): a mic rejection shows the relay message; a mic at 8 kHz falls through to `listening`; a connection that resolves after `disable()` is never closed. Two failures come from the missing TTS prefetch (B1). The reconnect test had a timing bug of its own: `connect` resolved inside its 10 ms wait. Audio was also being sent through the old connection while reconnecting (B2.4). |

**Weak or tautological tests in those files:**
- `expect(true).toBe(true)` for "drops sendAudio when not OPEN"
- an order check that builds `calls` and never asserts on it
- "fetchToken rejects" never checks the kind
- barge-in never checks that a 1-word partial doesn't stop speech
- the disable test never checks that the playback stopped

**The fix:** replace these three test files with the reviewer's versions. They were verified to pass 64/64 against a brief-correct reference implementation, to keep every one of your test names, and to be lint- and tsc-clean.

## T1: replace three test files (copy verbatim; don't edit them)
| From (read-only) | To |
|---|---|
| `agent-os/review/stage-07-tests/voice-relay-client.test.ts.txt` | `tests/voice-relay-client.test.ts` |
| `agent-os/review/stage-07-tests/voice-tts-player.test.ts.txt` | `tests/voice-tts-player.test.ts` |
| `agent-os/review/stage-07-tests/voice-controller.test.ts.txt` | `tests/voice-controller.test.ts` |

- Overwrite the whole file each time.
- Don't change any expectation. The tts-player and controller files use no timers; `tick()` is `setImmediate`.
- Their fake `fetchAudio` rejects with an `AbortError` when its signal aborts, just like a real `fetch`.

## Implementation fixes

### B1. `src/client/voice/tts-player.ts`: rewrite to this algorithm (brief §5)
**State:**
- `queue: Item[]`, where `Item = { text, ctrl: AbortController | null, audio: Promise<ArrayBuffer> | null }`
- `current: Item | null`, `playback: Playback | null`
- `running`, `speakingFlag`, `fallback` (booleans)
- `failures` (number), `gen` (number)

**Functions:**
- **`setSpeaking(v)`:** if `v !== speakingFlag`, set `speakingFlag = v` and call `deps.onSpeakingChange(v)`. This is the **only** place that calls `onSpeakingChange`.
- **`sticky()`:**
  - Set `fallback = true`.
  - For every item **still in `queue`**: `ctrl.abort()`, then `ctrl = null`, `audio = null`.
  - **Don't remove the items.** They'll be spoken by the fallback.
- **`fail(err)`:** if `err instanceof TtsUnavailableError`, call `sticky()`. Otherwise, if `++failures >= 2`, call `sticky()`.
- **`enqueue(text)`:**
  1. Ignore it if `text.trim() === ""`.
  2. Create `item`. If `!fallback`, set:
     - `item.ctrl = new AbortController()`
     - `item.audio = deps.fetchAudio(text, item.ctrl.signal)`
     - `item.audio.catch(() => {})`, which prevents an unhandled rejection; the real handling happens in `playItem`
  3. Push the item. If `!running`, start `run(gen)`.
- **`async run(g)`:**
  1. Set `running = true`, then `setSpeaking(true)`. Both happen synchronously, inside `enqueue`.
  2. `while (g === gen && queue.length)`: set `current = queue.shift()`, then `await playItem(current, g)`.
  3. After the loop, if `g === gen`: `current = null; running = false; setSpeaking(false)`.
- **`async playItem(item, g)`:**
  - If `item.audio` is null: speak the fallback (below) and return.
  - Otherwise `await item.audio`:
    - **On reject:** if `g !== gen`, return. Otherwise `fail(err)`, then speak this item with the fallback.
    - **On resolve:** if `g !== gen`, return. Otherwise `playback = deps.playAudio(bytes)` and `await playback.done`:
      - **On reject:** if `g !== gen`, return. Otherwise `fail(err)`, then speak this item with the fallback.
      - **On resolve:** if `g === gen`, set `failures = 0`.
- **Speaking with the fallback:** `playback = deps.speakFallback(item.text)`, then `await playback.done`. Catch and ignore a rejection.
- **`stop()`:**
  1. `gen++`
  2. `current?.ctrl?.abort()` (**the item waiting for its audio too**), and abort every queued item's `ctrl`
  3. `queue = []`, `current = null`
  4. `playback?.stop()`, `playback = null`
  5. `running = false`
  6. `setSpeaking(false)`. This makes no callback when idle.
- **`speaking()`** returns `speakingFlag`. **`mode()`** returns `fallback ? "fallback" : "provider"`.
- **Aborted fetches:** they reject after `stop()`, but `g !== gen` by then, so they're never counted as failures. Don't special-case `AbortError`.

### R1, R2. `src/client/voice/relay-client.ts`
- **R1. After a ready timeout, ignore every later event.**
  - Add `let dead = false;`. The timer callback sets `dead = true` before `close(1000)` and the rejection.
  - The `message` and `close` listeners `return` first thing when `dead` is set.
  - Currently a late `ready` sets `resolved = true` and later partials reach the handlers.
- **R2. `end()` must resolve when the close arrives (brief §4 rule 7), not after `endTimeoutMs`.**
  - In `end()`, when the socket is open:
    1. Set `intentionalClose = true` and send `{"type":"end"}`.
    2. Create the promise, storing its resolver in a closure variable `pendingEnd`.
    3. Start `endTimer = setTimeout(() => { pendingEnd = null; socket.close(1000); resolve(); }, endTimeoutMs)`.
  - In the close listener's after-ready branch, after `callOnCloseOnce(code)`: if `pendingEnd` is set, call `clearTimeout(endTimer)`, then `pendingEnd()`, then `pendingEnd = null`.
  - Keep the rule "if the socket is already closed, resolve immediately".

### B2. `src/client/voice/voice-controller.ts`
1. **Separate the mic and relay error paths.**
   - Use `micPromise.then(onMic, onMicError)`. `onMicError` (stale-generation check first) sets `unavailable` with `VOICE_MESSAGES.mic`.
   - Inside `onMic`, start the relay as its **own** chain: `deps.connect(handlers).then(onConn, onConnError)`. Don't chain a second `.then` onto the mic promise. This fixes "a mic rejection shows the relay message".
   - When `createPcmEncoder` throws, stop the mic, set the mic message and `return`. Nothing else may run; today it falls through to `listening`.
2. **`onConn` with a stale generation** (and the same in the reconnect success path): call `conn.close()` and return.
3. **`dispose()` bug (reproduced: after `dispose()`, `mic.stop` and `connection.end` are never called).**
   - Today `dispose` sets `disposed = true` and then calls `disable()`, which returns at once because `disposed` is set. So unmounting the screen leaves the mic and the relay running.
   - Fix: call `disable()` first, then set `disposed = true`, then `generation++`.
4. **Audio only while `listening`.**
   - `onSamples` returns unless `snap.status === "listening"` and `connection !== null`.
   - On an unexpected close, set `connection = null` before setting `reconnecting`.
   - Today samples go through the old, closed connection while reconnecting, which the brief forbids.
5. **`updateSnapshot` emits only on a real change.**
   - Build `next = { ...snap, ...partial }`. If `status`, `message`, `partial` and `speaking` all equal the current values, return without calling `onChange`.
   - The brief says "called after every snapshot change". Today `disable()` while off emits a new object every time, which drives the render loop in S1.
6. **`handleInterviewAction`: follow the brief literally.**
   - `request` and `failed` act in every status.
   - `token` and `done` check `off`/`suppressed` themselves: `done` while off or suppressed resets the chunker.
   - Remove the early `if (snap.status === "off") return;`.

### S1, S2. `src/app/interview/InterviewScreen.tsx`
- **S1. A render loop when the interview ends** (found by reading the code; there's no DOM test environment).
  - `useVoice` returns a new object every render. The effect `useEffect(() => { if (view.status === "ended") voice.disable(); }, [view.status, voice])` therefore runs on every render. `disable()` emits a new snapshot, `setSnapshot` re-renders, and the effect runs again, forever, on every finished interview.
  - **Fix:** destructure the stable callbacks once at the top of the component: `const { pendingTurn, takePendingTurn, disable: disableVoice } = voice;`.
    - Use `[pendingTurn, takePendingTurn, view, sendTurn]` as the voice-turn effect's deps.
    - Use `[view.status, disableVoice]` as the end effect's deps.
    - Inside those effects, call `takePendingTurn()` / `disableVoice()` directly. Method calls on `voice.` make `react-hooks/exhaustive-deps` demand `voice` itself.
  - B2.5 is the second guard against this loop.
- **S2.** Delete the unused `lastInterviewerEntry`.

### H1–H3. `src/server/tts-handler.ts` and the route
- **H1.** Use exactly the brief's signal, `signal: AbortSignal.timeout(TTS_TIMEOUT_MS)`. Remove the `AbortController`, the `setTimeout` and the `.finally(clearTimeout)`. Today the timeout is cleared once the headers arrive, so a stalled audio body is never cut off.
- **H2.** Change `catch (err) {` to `catch {` (a lint warning).
- **H3.** `src/app/api/tts/route.ts` must be **exactly** the brief's two lines:
  ```ts
  import { createTtsHandler } from "@/server/tts-handler";
  export const POST = createTtsHandler({ getEnv: () => process.env, fetch: (input, init) => fetch(input, init) });
  ```

### A1. `src/client/voice/browser-audio.ts`
- In `startBrowserMic`, wrap everything after `getUserMedia` resolves (`addModule`, the node creation, the connections) in `try { … } catch (err) { for (const t of stream.getTracks()) t.stop(); throw err; }`.
- Today a worklet failure leaves the microphone open, with the browser's recording indicator on. This file isn't unit-tested; the reviewer reads the change.

## Test gaps in passing files (append; don't change existing tests)
Copy the two blocks from `agent-os/review/stage-07-tests/additions.test.ts.txt`:
- **G1:** the `describe("chunker additions", …)` block, C12 and C13, goes at the end of `tests/voice-chunker.test.ts`, inside the top-level `describe`. It catches "empty chunk emitted" and "flush keeps buffer". Both pass on your current chunker.
- **G2:** the `describe("Reviewer additions (stage-07-review)", …)` block goes at the end of `tests/tts-route.test.ts`. Add `TTS_MAX_CHARS` and `TTS_TIMEOUT_MS` to that file's import from `../src/server/tts-handler`.
  - It catches the missed reverts: URL, model and voice (the old test compared constants to themselves), the timeout constant, and text logged on the fetch-throws path.
  - "uses AbortSignal.timeout(10000)…" fails until H1 is done; that's expected.
- Copy the blocks verbatim. If either file doesn't already import `vi` or `createSentenceChunker`/`createTtsHandler`, add the import.

## Lint (0 warnings required)
- All 39 test-file warnings disappear with T1.
- The other 3 are fixed by S1 (the missing `voice` dependency on line 55), S2 (the unused `lastInterviewerEntry`) and H2 (the unused `err`).
- Run `npx eslint --max-warnings=0` and fix anything left **without** adding disable comments.

## Constraints for this pass
- **Allowed to change:**
  - `src/client/voice/tts-player.ts`, `relay-client.ts`, `voice-controller.ts`, `browser-audio.ts`
  - `src/app/interview/InterviewScreen.tsx`
  - `src/server/tts-handler.ts`, `src/app/api/tts/route.ts`
  - the five test files named above (T1, G1, G2)
  - `STAGE7_NOTES.md`
- **Everything else is frozen,** including `pcm-encoder.ts`, `sentence-chunker.ts`, `use-voice.ts`, `interview-model.ts`, `use-interview.ts`, `capture-worklet.js`, every other test file and everything under `agent-os/`.
- No new dependencies, and no network beyond `127.0.0.1`. The rest of the brief's constraints still apply: no browser globals at module top level, and never log audio, text, tokens or keys.

## Acceptance
1. `npx tsc --noEmit` and `npx next build` (no keys) pass. **`npx eslint --max-warnings=0` passes.**
2. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.**
   - Expect 687 tests: 658 now, minus the 41 in the three replaced files, plus 64 in their replacements (20 + 13 + 31), plus 2 in G1 and 4 in G2.
   - If the only failure is the known `step-route` abort flake, re-run and note it.
3. The three replacement files are byte-identical to the `.txt` sources. No existing test name disappears.
4. `STAGE7_NOTES.md` lists each fix ID (B1, R1, R2, B2.1–B2.6, S1, S2, H1–H3, A1, T1, G1, G2) with one line on what changed.
