# Stage 6 review: fixes required (handoff to the external model)

Reviewed on 2026-10-27.

## What passed
- **Checks:** `npx vitest run` **exits 0** with 543 tests and no `Errors` line. Typecheck, lint (0 warnings) and a no-key build all pass. `/api/relay-token` is in the build, and the browser bundle contains no `ws` or relay code.
- **Files:** all frozen files are byte-for-byte unchanged, and only allowed files changed. `package.json` added exactly `ws ^8.18.0` and `@types/ws ^8.5.12` plus the `relay` script. `.env.example` added the three variables.
- **No test names lost.** The tests only connect to `127.0.0.1`; other URLs in them are config-parsing strings, not connections.
- **Matches the brief:** the token format and verification, the route handler (503/400/200, `no-store`), `map-upstream.ts`, `config.ts`, `wav.ts`, and most of the session lifecycle.
- **Secrets:** the API key appears only in the upstream handshake, and the `relay_session` log line contains no token, key or transcript.
- **Temporary reverts:** 56 run, in chunks with on-disk backups. **51 were caught**; the 5 misses are in T1 below.

## Two confirmed bugs, reproduced against the real relay code

### B1. `maxSessions` can be exceeded (`relay/src/server.ts`)
`activeSessions` is **incremented only after a successful auth** (line 241). But it's **decremented on every client `close` *and* on every client `error`** (lines 171 and 176), including connections that never authenticated, and twice when both events fire. `Math.max(0, …)` hides the resulting under-count.

**Reproduced:** with `maxSessions: 2`, one valid session plus one bad-token connection that closed with 4001, followed by two more valid clients, gave **3 sessions ready at the same time**.

**Fix:**
- Give each session a `counted: boolean`. Set it, and increment `activeSessions`, at the moment auth succeeds.
- Decrement exactly once, in `closeSession`, and only if `counted` is true (then set it to false).
- Remove the decrements from the `close` and `error` handlers.

### B2. A Meta connection that's still opening when the session ends is left alive, and still sends the API key (`relay/src/server.ts`)
`closeSession` only closes the upstream if `readyState === OPEN`. If the session ends while the upstream socket is still **CONNECTING** (for example `upstreamReadyTimeoutMs` fires, the auth/time limit fires, or the client disconnects), that socket is abandoned. When it later opens, its `open` handler **still sends the handshake containing `Bearer <MODEL_API_KEY>`**, and the connection stays open with nothing attached.

In production that's an orphaned, possibly billable Meta session per incident.

**Reproduced:** with an upstream that delays its WebSocket handshake by 1.5 s and `upstreamReadyTimeoutMs: 300`, the client correctly got 4503. Afterwards the upstream **still received the handshake (`"Bearer test-key"`)**, and **1 upstream socket remained open**.

**Fix:**
- In `closeSession`, if the upstream is `CONNECTING`, call `terminate()`; if it's `OPEN`, close it.
- In the upstream `open` handler, if `session.state === "closed"`, close the socket immediately and **don't send the handshake**.
- Pass `{ handshakeTimeout: opts.upstreamReadyTimeoutMs }` when creating the upstream `WebSocket`.

## Other defects (deviations from the brief)

### B3. The session time limit starts at the wrong moment and doesn't apply while ending
The brief says the limit runs *from auth* and ends the session regardless of state. The code starts the timer only when Meta acknowledges, and the callback skips the `ending` state. So a client that sends `end` while Meta never closes the stream **hangs forever**. The same happens if the client sends `end` while still connecting.

**Fix:**
- Start `sessionTimer` when auth succeeds.
- When it fires in **any** state other than `closed`, send `session time limit reached` (`fatal: true`) and close with 4008.

### B4. Invalid text after auth is silently ignored
`handleClientTextMessage` returns quietly on invalid JSON, and only reports non-`end` JSON in the `ready` state. The brief says any other or invalid text after auth gets `{ type: "error", message: "invalid message", fatal: false }`, with the session left open. Apply that in both `connecting_upstream` and `ready`, for invalid JSON as well as unrecognised messages.

### B5. Wrong WebSocket paths aren't answered with 404
Upgrades on paths other than `/asr` are destroyed without a response. The brief says to send a 404 and then destroy. Write `HTTP/1.1 404 Not Found\r\n\r\n` before `socket.destroy()`, as the origin check already does with 403.

### B6. `bytesIn` undercounts
The `relay_session` log's `bytesIn` only counts audio forwarded in the `ready` state. Also count the pre-ready bytes that are kept in the buffer and later flushed. Don't count bytes discarded over the cap.

### B7. `close()` leaves upstream sockets open
`startRelay().close()` closes client sockets but never ends their sessions, so upstream connections to Meta stay open. In `close()`, run `closeSession(session, 1001)` for every live session, which closes or terminates its upstream, before closing the servers. Track sessions instead of raw client sockets to make this possible.

### B8. `relay/scripts/wav-client.ts` takes the secret on the command line
It reads `--secret <value>`, which ends up in shell history and the process list. The brief says to read `RELAY_SECRET` from the environment. Remove the `--secret` flag. If `RELAY_SECRET` is missing or shorter than 32 characters, print an error that doesn't include the value and exit 1.

### B9. `PORT` isn't validated (`relay/src/config.ts`)
`PORT=abc` produces `NaN`. If `PORT` is set but isn't an integer in 0–65535, add the error `PORT must be an integer between 0 and 65535` (without the value).

## T1. Test gaps (each revert below passed every test)
| # | Revert that wasn't caught | Test to add |
|---|---|---|
| T1a | The token's `v !== 1` check removed | In `tests/relay-token.test.ts`, a correctly signed payload with `v: 2` gives `bad_payload`. |
| T1b | The handler requesting 8 random bytes instead of 16 | In `tests/relay-route.test.ts`, assert `randomHex` was called exactly once **with `16`**. |
| T1c | The handshake sent with `keywords: []` | In `tests/relay-server.test.ts`, the happy-path handshake must deep-equal the **full** expected object, including `keywords: getConfig("maths-oxbridge").asrKeywords`. Assert the array is non-empty so the check can't pass by accident. |
| T1d | The pre-ready buffer cap ignored | Use `preReadyBufferBytes: 1000` and an `ack: "never"` fake. Send three 600-byte frames before acknowledging manually. After `ready`, the fake receives exactly **1000 bytes in total**: the first frame whole plus the first 400 bytes of the second. |
| T1e | Any WebSocket path accepted | A `ws` client connecting to `/other` must fail with HTTP status **404**. Assert the `unexpected-response` status code, and that the fake saw zero connections. |

## Tests required for B1–B9
- **The fake Meta helper must support several sessions at once** (`tests/helpers/fake-meta-asr.ts`). It currently tracks a single connection, so it can't test B1. Track every connection, keep `send`/`close` working on the **latest** connection (existing tests rely on that), and add `openConnections(): number`, which counts connections whose socket isn't closed. **Don't break existing tests.**
- **B1:**
  - **Bad-token scenario:** `maxSessions: 2`, then A valid and ready, then B with a bad token (closes 4001), then C valid and ready, then D valid. D must get `busy` and close 1013.
  - **Disconnect frees a slot:** `maxSessions: 1`. A connects and is ready, A disconnects, then B connects and gets `ready`.
- **B2:** use an upstream defined in the test whose `upgrade` handler waits 1.5 s before `handleUpgrade`, with `upstreamReadyTimeoutMs: 300`. The client gets 4503. Then, 2 s later, the upstream has received **zero** handshakes and has **zero** open sockets. Repeat with the client disconnecting while the upstream is still connecting.
- **B3:**
  - `maxSessionMs: 400`, then `ready`, then the client sends `end`, and the fake **never** closes: the client gets `session time limit reached` and close 4008 within about 600 ms.
  - The same while still connecting (`ack: "never"`, `upstreamReadyTimeoutMs: 5000`, `maxSessionMs: 400`): close 4008.
- **B4:** after `ready`, send the text `not json` → `{error, "invalid message", fatal:false}`, and audio still flows afterwards. During `connecting_upstream` (`ack: "never"`), sending `{"type":"bogus"}` gives the same error.
- **B5:** covered by T1e.
- **B6:** with `preReadyBufferBytes: 1000`, send 600 bytes before ready and 400 after. The `relay_session` log shows `bytesIn: 1000`.
- **B7:** start a session, `ready`, then call `relay.close()`. The fake's `openConnections()` is 0 within 2.5 s.
- **B8:** `tests/relay-wav-client.test.ts` spawns `node <repo>/node_modules/tsx/dist/cli.mjs <repo>/relay/scripts/wav-client.ts --url ws://127.0.0.1:1/asr --wav x.wav --config maths-oxbridge` with **no** `RELAY_SECRET`. It exits 1, prints an error mentioning `RELAY_SECRET`, and makes no connection (port 1 is never reached because the check comes first).
- **B9:** `PORT=abc` and `PORT=70000` each produce the PORT error, and the message doesn't contain the value.

## Constraints for this pass
- **Allowed changes:** `relay/src/server.ts`, `relay/src/config.ts`, `relay/scripts/wav-client.ts`, `tests/helpers/fake-meta-asr.ts`, and `tests/relay-*.test.ts` (new and existing).
- **Every other file is frozen**, including `src/shared/relay-token.ts`, `src/server/relay-token-handler.ts`, `relay/src/map-upstream.ts` and `relay/src/wav.ts`. They're correct; the T1a and T1b gaps are test-only.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **Localhost only. No new dependencies.**

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), **`npx vitest run` exits 0 with no `Errors` line**, and `npm run build` all pass.
- The B1 and B2 reproductions above now hold the limit and leave no upstream socket and no late handshake. The reviewer will rerun them.
- Every T1 revert, and each B1–B9 fix when reverted, makes a test fail.
