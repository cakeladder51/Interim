# Stage 6 review 2: fixes required (handoff to the external model)

Reviewed on 2026-10-27. This re-reviews the round-1 fixes from `stage-06-review.md`.

## What passed
- **Checks:** `npx vitest run` **exits 0** (29 files, 560 tests, no `Errors` line, no unhandled rejections). Typecheck, lint (0 warnings) and a no-key build pass.
- **Files:** only allowed files changed. The frozen files are byte-identical: `src/shared/relay-token.ts`, `src/server/relay-token-handler.ts`, `relay/src/map-upstream.ts`, `relay/src/wav.ts`.
- **No test names lost:** config 20→22, server 29→41, token 17→18, wav-client 0→2.
- **Round-1 bugs fixed, re-checked against the real relay:**
  - **B1 bad-token bypass is fixed.** With `maxSessions: 2`, a valid client, a bad token (closed 4001) and two more valid clients now give 2 ready sessions, and the 4th client gets close 1013.
  - **B2 orphaned upstream is fixed.** An upstream that delays its WebSocket handshake by 1.5 s, with `upstreamReadyTimeoutMs: 300`: the client gets 4503, and the upstream gets **0** handshakes and has **0** open sockets.
- B3–B9, T1a–T1e and the multi-session fake helper are in place.
- **Temporary reverts:** see "Revert checks" below.

## Bugs to fix (all in `relay/src/server.ts` unless stated)

### B1. `maxSessions` can still be exceeded by clients that connect before any of them authenticates
The busy check runs at **upgrade** time against `activeSessions`, but `activeSessions` only goes up at **auth success**. Any number of clients can therefore connect while the count is below the limit, then all authenticate.

**Reproduced:** with `maxSessions: 1`, three clients connected first and then all sent valid auth. Result: **3 sessions ready at once, and 3 handshakes (3 billable Meta sessions) sent upstream.**

**Fix:** keep the upgrade-time check, and add a second check in `handleAuth`.
- Place it **after** the token, replay and `configId` checks, and **before** the nonce is recorded and `counted`/`activeSessions++` are set.
- If `activeSessions >= opts.maxSessions`: send `{ "type": "error", "message": "busy", "fatal": true }`, then `closeSession(session, 1013)` and return.
- Don't record the nonce in that case, so the token can be retried, and don't open an upstream.

### B2. The `sessions` array is never pruned (unbounded memory growth)
`handleConnection` does `sessions.push(session)` for **every** connection, including failed auths, but nothing ever removes an entry. A long-running relay keeps every `Session`, with its client socket and buffers, forever.

**Fix:**
- Make it `const sessions = new Set<Session>()`: `add` in `handleConnection`, and `delete` in `closeSession`.
- In `close()`, iterate over a copy (`for (const s of [...sessions])`).
- Add a test-only accessor to the value `startRelay` returns. The return type becomes:
  ```ts
  Promise<{ port: number; close(): Promise<void>; trackedSessions(): number }>
  ```
  `trackedSessions()` returns `sessions.size`. `relay/src/main.ts` needs no change.

### B3. A mid-session upstream socket error is reported as "unavailable" / 4503
The upstream `error` handler always sends `"Transcription service unavailable"` and closes with 4503, whatever the state. The brief says an upstream that drops **after** connecting gets `"Transcription service disconnected"` and close 4502.

**Reproduced:** after `ready`, the fake upstream wrote an invalid WebSocket frame. The client got `["Transcription service unavailable"]` and close **4503**.

**Fix:** decide by whether the upstream socket **ever opened**, not by session state.
- In `connectUpstream`, add a local `let opened = false;` and set it to `true` as the first line of the `open` handler.
- In `upstreamWs.on("error", …)`:
  - If `!opened` and the session isn't `closed`: send `"Transcription service unavailable"` (`fatal: true`) and `closeSession(session, 4503)`, as now. This covers connection refused, the handshake timeout, and a client that sent `end` while still connecting (see T3d).
  - If `opened`: do nothing. `ws` always emits `close` after `error`, and the existing `close` handler then produces "disconnected" / 4502.
- **Keep the listener attached**, even when it does nothing. An `error` event with no listener crashes the process.

### B4. An upstream that never answers the close frame is never terminated (the 2 s rule doesn't hold)
`closeSession` calls `upstreamWs.close(1000)`, which moves the socket to `CLOSING`. The client-disconnect handler's 2 s timer only terminates when `readyState === OPEN`, so it never fires after that. The socket then waits for `ws`'s own 30 s close timeout. Every other `closeSession` path (4008, 4502, 4503, 1001) has no fallback at all.

**Reproduced:** with an upstream that completes the WebSocket handshake but never answers a close frame, the client got `ready` and then disconnected. The upstream received `endStream`, but its TCP socket was **still open 4 s later** (the brief requires closing within 2 s).

**Fix:** handle this in one place, `closeSession`:
- When the upstream is `OPEN`, call `close(1000)`, then start a 2000 ms timer that calls `terminate()` if `readyState !== WebSocket.CLOSED`. Call `.unref()` on the timer.
- Keep `terminate()` for `CONNECTING`.
- Remove the now-redundant `setTimeout(…, 2000)` from the client `close` handler. Keep its `endStream` send, which must still happen **before** `closeSession`.

### B5. A client socket error skips the `endStream` to the upstream
`clientWs.on("error", () => closeSession(session, 1011))` closes the session before the `close` handler runs, so the upstream never gets `{"type":"endStream"}`. Brief rule 6 says a client disconnect sends `endStream`. This is realistic: a client frame over `maxPayload` (65536) triggers `error`.

**Fix:** make the client `error` listener a no-op, with a one-line comment that `close` always follows. The `close` handler then does the disconnect work. Keep the listener attached, as in B3.

### B6 (minor). `PORT` and `RELAY_MAX_SESSIONS` accept partly numeric strings (`relay/src/config.ts`)
`parseInt` accepts `"12abc"` (12) and `"1.5"` (1). Require `/^\d+$/` before parsing:
- **`PORT`:** a string that doesn't match (or is above 65535) gives the existing error `PORT must be an integer between 0 and 65535`.
- **`RELAY_MAX_SESSIONS`:** keep the existing contract, where an invalid value falls back to 50 (existing tests assert `"abc"`, `"0"` and `"-5"` give `ok: true`). A string that doesn't match `/^\d+$/` also falls back to 50.

## Tests to add (add only; don't delete or weaken any test)

Put the new server tests in `tests/relay-server.test.ts`, inside a new `describe("review-2")`. Close every relay, fake, raw server and client in `afterEach`.

| # | Test |
|---|---|
| T2a (B1) | `maxSessions: 1`, acking fake. Open three `ws` clients to `/asr`, and wait until **all three are open** without sending anything. Then send valid auth on all three (three different tokens) in the same tick, and wait 500 ms. **Exactly one** client has received `ready`. The other two each received exactly `{ type: "error", message: "busy", fatal: true }` and closed with **1013**. The fake has `handshakes.length === 1` and `connections() === 1`. |
| T2b (B2) | `trackedSessions()` is `0` right after `startRelay`, and `1` once a client is `ready`. Then: that client sends `end` and the fake closes 1000 (client closed 1000); a bad-token client is closed 4001; and a client that never authenticates is closed 4001 by the auth timeout (`authTimeoutMs: 200`). After all of those, `trackedSessions()` is **`0`**. |
| T2c (B3) | Add `sendRawFrame(bytes: Buffer): void` to `tests/helpers/fake-meta-asr.ts`. It writes raw bytes to the **latest** connection's TCP socket: `(ws as unknown as { _socket: import("node:net").Socket })._socket.write(bytes)`. Test: after `ready`, call `fake.sendRawFrame(Buffer.from([0x83, 0x00]))` (opcode 3 is reserved, so this is a protocol error). The client receives **exactly one** error, `{ type: "error", message: "Transcription service disconnected", fatal: true }`, and closes with **4502**. No received message contains `unavailable`. |
| T2d (B3 regression guard) | Upstream connection refused. Get a free port by listening on port 0 with `node:net`, read the port, and close that server. Use `ws://127.0.0.1:<port>` as `upstreamUrl`, with `upstreamReadyTimeoutMs: 8000`. After auth, the client receives `{ type: "error", message: "Transcription service unavailable", fatal: true }` and closes with **4503**, all within 5 s. (Windows retries a refused connection for about 2 s, so set the vitest timeout for this test to 10 s.) |
| T2e (B4) | Create `tests/helpers/raw-ws-upstream.ts` with the exact code below. Test 1: relay `upstreamUrl` = `raw.url`; the client authenticates and gets `ready`. Record `t0`, then `client.close()`. Poll every 50 ms: `raw.openSockets()` must reach **0** within **2500 ms** of `t0`. Test 2: the same upstream with `maxSessionMs: 300`. After the client is closed with 4008, `raw.openSockets()` reaches 0 within 2500 ms of that close. |
| T2f (B5) | After `ready`, the client sends one binary frame of **70 000 bytes** (over `maxPayload`). The client is closed with **1009**. Within 1000 ms, `fake.texts` contains `{ type: "endStream" }`, and exactly one `relay_session` log line is written for that session. |
| T2g (B6) | In `tests/relay-config.test.ts`: `PORT` set to `"12abc"` and to `"1.5"` each give `ok: false` with the PORT error, and the message doesn't contain the value. `"0"` gives port 0 and `"65535"` gives 65535. `RELAY_MAX_SESSIONS` set to `"5abc"` and to `"1.5"` each give `ok: true` with `maxSessions: 50`. |
| T2h (handshake) | Strengthen the happy-path handshake check **by adding** one assertion (keep the existing ones). The whole object must equal the expected one, so an unexpected extra field fails: `expect(fakeMeta.handshakes[0]).toEqual({ authorization: { accessToken: "Bearer test-api-key" }, audioEncoding: "PCM_16KHZ", model: "muse-voice-transcribe-1.0", mode: "ENDPOINTING", partialMode: "CUMULATIVE", keywords: getConfig("maths-oxbridge").asrKeywords })`. Also keep the non-empty-array assertion on `keywords`. |

**`tests/helpers/raw-ws-upstream.ts`** (use exactly this):
```ts
import net from "node:net";
import { createHash } from "node:crypto";

// A minimal WebSocket upstream: completes the HTTP upgrade, sends {"sessionId":"s"},
// then ignores every frame it receives. It never answers a close frame.
export async function startUnresponsiveUpstream(): Promise<{
  url: string;
  openSockets(): number;
  stop(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on("data", (d) => {
      if (upgraded) return;
      buf = Buffer.concat([buf, d]);
      const head = buf.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      setTimeout(() => {
        const payload = Buffer.from(JSON.stringify({ sessionId: "s" }));
        if (!sock.destroyed) sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }, 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    openSockets: () => sockets.size,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
```

## Revert checks
- `token`, `handler`, `map`, `config`, `wav`, `wavclient`: **35/36 caught**. The one skip was a stale anchor in the reviewer's script; it has been re-anchored.
- `server`: **28/33 caught.** 1 is equivalent, and 4 are real test gaps. The round-1 review asked for tests that would catch these; they weren't written as specified.

| Revert | Result | Why |
|---|---|---|
| B2: the `open` handler's `state === "closed"` guard removed | **equivalent**, no test needed | `closeSession` terminates a CONNECTING upstream, so `open` can never fire for a closed session. The guard is defence in depth; keep it. |
| B1: `counted` never set | **missed** | The required "disconnect frees a slot" test is missing (T3b). |
| B1: never decremented in `closeSession` | **missed** | Same as above (T3b). The existing `bad token doesn't block new sessions` test uses `maxSessions: 1` with the bad client **first**, so it can't catch the original bug either (T3a). |
| B2: CONNECTING upstream not terminated | **missed** | The `open` guard still blocks the handshake. The tests check handshakes but not whether the upstream connection was ever **established** (T3c). |
| B2: `handshakeTimeout` removed | **missed** | The upstream-ready timer only fires in `connecting_upstream`. A client that sends `end` while still connecting to an upstream that never answers the HTTP upgrade relies on `handshakeTimeout` alone (T3d). |

### Tests for the misses (add in `describe("review-2")` in `tests/relay-server.test.ts`)
| # | Test |
|---|---|
| T3a (B1, exactly as round 1 specified) | `maxSessions: 2`, using a fake that acks every connection. Client A authenticates and gets `ready`. Client B sends a token signed with a wrong secret and closes with 4001. Client C authenticates and gets `ready`. Then client D authenticates: D receives `{ type: "error", message: "busy", fatal: true }` and closes with **1013**. A and C are still open (`readyState === WebSocket.OPEN`). |
| T3b (B1) | `maxSessions: 1`. A authenticates and gets `ready`. A closes (`A.close()`), and you wait for A's `close` event plus 100 ms. Then B authenticates with a new token and **gets `ready`**. Then C authenticates and gets `busy` / **1013**. |
| T3c (B2) | Copy the existing `upstream timeout while CONNECTING` setup (an upstream whose `upgrade` handler waits 1500 ms before `handleUpgrade`, with `upstreamReadyTimeoutMs: 300`). Create the upstream's `WebSocketServer` **once**, outside the handler, and count `wss.on("connection")` events. To make that event fire, call `wss.emit("connection", ws, req)` inside the `handleUpgrade` callback. The client closes with 4503. After 2500 ms in total, the connection count is **0**: termination aborts the request before the upgrade completes. Reviewer-verified on the current code: count 0, close 4503. |
| T3d (B2 `handshakeTimeout`) | Use an upstream that accepts TCP and never answers: `net.createServer((s) => s.on("error", () => {}))`, keeping the sockets so you can destroy them in cleanup. Relay options: `upstreamReadyTimeoutMs: 300`, `maxSessionMs: 60000`. On `open`, the client sends auth and then `{"type":"end"}` **in the same tick**. Within **1500 ms**, the client receives `{ type: "error", message: "Transcription service unavailable", fatal: true }` and closes with **4503**. Reviewer-verified on the current code: 4503 after 313 ms. It must still hold after the B3 fix above, which is why B3 keys on `opened` rather than the state. |

## Constraints for this pass
- **Allowed changes:** `relay/src/server.ts`, `relay/src/config.ts`, `tests/helpers/fake-meta-asr.ts`, the new `tests/helpers/raw-ws-upstream.ts`, and `tests/relay-*.test.ts`.
- **Every other file is frozen,** including `relay/src/main.ts`, `relay/scripts/wav-client.ts`, `relay/src/map-upstream.ts`, `relay/src/wav.ts`, `src/**`, `package.json` and `package-lock.json`.
- **This review is correct as written. Never edit an expected value to make a test pass.** If a test still fails after the fix, stop and write down what you saw in `STAGE6_NOTES.md`.
- **Add tests; don't delete or weaken any.** Test names are compared file by file.
- **Localhost only. No new dependencies.** Never connect to `api.meta.ai`.

## Acceptance
1. `npm run typecheck`, `npm run lint` (0 warnings) and `npm run build` pass, and **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line**.
2. The reviewer re-runs these reproductions against the real relay, and each must now hold:
   - B1: three clients authenticating at once with `maxSessions: 1` → 1 ready, 2 busy/1013, 1 upstream handshake
   - B3: a mid-session invalid frame → 4502 "disconnected"
   - B4: an upstream that never answers a close frame is closed within 2 s
   - B5: a client error still sends `endStream`
   - plus the round-1 B1/B2 reproductions
3. Reverting any B1–B6 fix here, or any round-1 fix covered by T3a–T3d, makes at least one test fail. The reviewer reruns the full server revert group.
4. No test name is removed.
