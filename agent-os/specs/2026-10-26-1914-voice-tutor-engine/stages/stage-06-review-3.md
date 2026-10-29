# Stage 6 review 3: two test gaps and one cleanup (handoff to the external model)

Reviewed on 2026-10-28. This re-reviews the round-2 fixes from `stage-06-review-2.md`. **The relay code is correct.** This pass is test-only, plus a 3-line dead-code removal.

## What passed
- **Checks:** `tsc --noEmit` passes, eslint has 0 problems, and `next build` (no keys) passes, with `/api/relay-token` present. **`npx vitest run` exits 0:** 578 tests, no `Errors` line, no unhandled rejections.
- **No test names lost** (compared file by file with round 1): `relay-config` 22→28, `relay-server` 41→53.
- **Files:**
  - only allowed files changed, and the frozen relay files are byte-identical
  - `tests/helpers/raw-ws-upstream.ts` is **byte-identical** to the code in review-2
  - `tsconfig.json`: the added `"exclude": [..., "agent-os/review"]` is **accepted**. The reviewer's probe scripts live there and must not be type-checked by the app.
  - **Process note:** that file was frozen. When a frozen file blocks you, stop and say so in `STAGE6_NOTES.md` rather than editing it silently.
- **All six round-2 fixes are correct**, re-checked against the real relay:

  | Fix | Observation |
  |---|---|
  | B1 | Three clients authenticating at once with `maxSessions: 1` → 1 ready, 1 upstream handshake. A bad-token client no longer frees a slot. |
  | B2 | `trackedSessions()` returns to 0. |
  | B3 | A mid-session invalid frame → "Transcription service disconnected" / 4502. Refused or never-opened → "Transcription service unavailable" / 4503, including `end` sent while still connecting. |
  | B4 | An upstream that never answers the close frame is closed after ~2010 ms. |
  | B5 | A client error (a frame over `maxPayload`) still sends `endStream` upstream. |
  | B6 | `PORT` and `RELAY_MAX_SESSIONS` accept digits only. |
  | Round-1 | The orphaned-upstream case still holds: 0 handshakes and 0 upstream connections. |

- **Temporary reverts:**
  - token, handler, map, wav and wav-client: 35/36 last round (the skip was a stale anchor, since fixed)
  - config: **12/12**
  - server: **38/41**. One is equivalent (the `open` handler's "session closed" guard, which `terminate()` makes unreachable). The **two real misses** are G1 and G2 below.

## G1. The auth-time `busy` message isn't tested
**Revert that passed every test:** the `busy` error sent from `handleAuth`, changed to `message: "full"`.
- T2a checks only the close codes (1013), not the message, even though review-2 asked for it.
- T3a and T3b reject their extra client at **upgrade** time, which is a different code path.

**Test to add** (new test; don't edit T2a), in `describe("review-2")` of `tests/relay-server.test.ts`:

`G1: auth-time busy rejection sends exactly the busy error`
- Same setup as T2a: `maxSessions: 1`, `startFakeMetaAsr()`, three clients all **open** before any sends auth, then auth on all three in the same tick (three different nonces).
- Attach every client's `message` and `close` listeners **before** sending auth.
- Wait 500 ms.
- Exactly one client's messages contain `{ type: "ready" }`.
- For each of the other two: `expect(messages[i]).toEqual([{ type: "error", message: "busy", fatal: true }])` (the whole array, so nothing else was sent), and its close code is `1013`.

## G2. Terminating a still-connecting upstream isn't tested independently of `handshakeTimeout`
**Revert that passed every test:** in `closeSession`, the `else if (readyState === WebSocket.CONNECTING) { terminate(); }` branch disabled.

T3c uses `upstreamReadyTimeoutMs: 300`, and that same value is the `handshakeTimeout`, so `ws` aborts the handshake at 300 ms by itself. (This was the reviewer's mistake in specifying T3c, not yours.) The `terminate()` only matters when the session ends **before** that timeout.

**Test to add** in the same `describe`:

`G2: client disconnect while upstream CONNECTING (long ready timeout) -> upstream never connects`
- **Upstream:** copy T3c's upstream exactly: an `http` server whose `upgrade` handler waits **1500 ms** before `wss.handleUpgrade(...)`, one shared `WebSocketServer({ noServer: true })`, and `wss.emit("connection", ws, req)` in the callback, counting `connection` events.
- **Relay options:** `upstreamReadyTimeoutMs: **5000**`, `maxSessionMs: 30_000`, `authTimeoutMs: 500`, `maxSessions: 50`, `preReadyBufferBytes: 64000`.
- **Client:** on `open`, send a valid auth, then `setTimeout(() => clientWs.close(), 200)`.
- **After waiting 2500 ms in total:**
  - `connectionCount` is **`0`**
  - `relay.trackedSessions()` is **`0`**
- **Cleanup:** terminate every `wss.clients`, then `server.closeAllConnections()` and close the server.
- Reviewer-verified on the current code: connection events 0, tracked sessions 0. With `terminate()` removed, the upgrade completes at 1500 ms and the count is 1.

## C1. Remove the dead `upstreamTerminateTimer` field (`relay/src/server.ts`)
`Session.upstreamTerminateTimer` is declared, initialised to `null` and cleared, but **never assigned**: the B4 timer is a local `const`, which is correct, because it must outlive `closeSession`. Delete exactly these three lines and nothing else:
- `  upstreamTerminateTimer: NodeJS.Timeout | null; // B4: terminate fallback` (in `interface Session`)
- `    if (session.upstreamTerminateTimer) clearTimeout(session.upstreamTerminateTimer);` (in `closeSession`)
- `      upstreamTerminateTimer: null,` (in `createSession`)

## Constraints for this pass
- **Allowed changes:** `tests/relay-server.test.ts` (add the two tests only), and `relay/src/server.ts` (C1's three deletions only).
- **Every other file is frozen,** including `tsconfig.json` (now at SHA-256 `28727cb8…72b9`), `relay/src/config.ts`, both test helpers, and everything under `agent-os/`.
- **This review is correct as written. Never edit an expected value to make a test pass.** If a test fails, stop and write down what you saw in `STAGE6_NOTES.md`.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **Localhost only. No new dependencies.**

## Acceptance
1. `npm run typecheck`, `npm run lint` (0 warnings) and `npm run build` pass, and **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line** (580 tests).
2. `relay/src/server.ts` differs from SHA-256 `e45f4982…9949` only by the three deleted lines. The reviewer will re-insert them and check the hash.
3. The reverts "auth-time busy message changed" and "CONNECTING not terminated" each make a test fail.
