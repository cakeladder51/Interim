# Stage 6 brief: Speech-to-text relay (handoff to the external model)

## Goal
Build the **WebSocket relay** that sits between the browser and Meta's Muse Voice Transcribe realtime API. It exists because:
- Meta's realtime socket authenticates with the **raw API key inside its first message**, so the key must never reach the browser
- Vercel functions can't hold long-lived WebSockets

The relay holds the key, authenticates browsers with **short-lived signed tokens** issued by a new Next.js route, pipes microphone audio up to Meta, and translates Meta's events into the app's own relay protocol.

**Everything in this stage must be built and tested fully offline, against a fake Meta server you also write.** Connecting to the real Meta API needs `MODEL_API_KEY`, and deploying the relay to Fly.io is public deployment. **Both are on hold.** Don't run either, and don't write a Dockerfile or `fly.toml` yet; packaging moves to the deploy stage. The browser microphone code is Stage 7, not this stage.

---

## What already exists: read this first

You're starting in a fresh session. **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win. `STATUS.md` lists completed stages, frozen file hashes and held items.

Read these files before writing code:
- `src/contracts/relay-protocol.ts` (the relay protocol, already defined and **frozen**)
- `src/config/load.ts` (`getConfig(id).asrKeywords`)
- `src/server/step-handler.ts` (a handler-factory pattern to copy)
- `src/app/api/step/route.ts` (route files only export `POST`)
- `tests/meta.sdk.test.ts` (how existing tests run real local `node:http` servers)
- `.env.example`

**Stack:**
- Next.js 16.4 (App Router; `next.config.ts` has `cacheComponents: true`, so **no `export const runtime`** in route files, and route files may only export route names).
- TypeScript strict, zod v4 (`import { z } from "zod"`), vitest (node environment; tests live in `tests/` and run with `npx vitest run`), `tsx` (runs TypeScript and resolves the `@/*` → `src/*` alias).
- Server modules used by Next start with `import "server-only"`. **The relay runs as a plain Node process, so nothing it imports may import `server-only`.** `src/config/load.ts` and `src/contracts/*` are safe to import.
- **Acceptance always includes:** `npx vitest run` **exits 0 with no `Errors` / "Unhandled Rejection" lines**. Attach a rejection handler to every promise before it can reject, and close every socket and server in `afterEach`/`afterAll`.

**The relay protocol** (`@/contracts`, frozen):
- **Client → relay:**
  1. The first frame is text JSON `{ "type": "auth", "token": "<token>" }`.
  2. Then **binary** frames of raw PCM16LE, 16 kHz, mono.
  3. `{ "type": "end" }` to finish.
- **Relay → client** (text JSON):
  - `{ "type": "ready" }`
  - `{ "type": "partial", "text" }`
  - `{ "type": "turn_start", "turnId" }`
  - `{ "type": "turn_complete", "turnId", "text" }`
  - `{ "type": "error", "message", "fatal" }`
- Schemas: `RelayClientMessageSchema` and `RelayServerMessageSchema`.

**Meta's upstream API**, from Meta's docs (`wss://api.meta.ai/v1/asr/realtime`):
- **Handshake:** within 10 s of connecting, send one text JSON frame:
  `{ "authorization": { "accessToken": "Bearer <MODEL_API_KEY>" }, "audioEncoding": "PCM_16KHZ", "model": "muse-voice-transcribe-1.0", "mode": "ENDPOINTING", "partialMode": "CUMULATIVE", "keywords": [ ... ] }`
  The HTTP `Authorization` header is ignored.
- **The acknowledgement** is `{ "sessionId": "..." }`, with **no `type` field**. Send no audio before it arrives.
- **Audio:** binary PCM16LE mono frames. Frame boundaries carry no meaning.
- **Events**, as text JSON with a `type` field:
  - `speechStart` `{ turnId, audioProcessedMs }`
  - `transcript` `{ transcript, final, audioProcessedMs }`: a cumulative partial, where each one replaces the previous
  - `speechEnd` `{ turnId }`
  - `speechComplete` `{ turnId, transcript }`: the final text for the turn
  - `audioProgress`
  - `speaker`
  - `error` `{ message, sessionId }`
  - **Unknown types must be ignored.**
- **Ending:** send `{ "type": "endStream" }`, then keep reading until Meta closes the socket with code 1000.
- **Limits:** sessions are capped at 60 minutes. A rejected stream closes with 1013.
- **Caution:** the exact event field names haven't been verified against the live API yet (that's held). Keep the translation logic in **one pure function**, so it's a one-place change later.

## Constraints
- **Allowed files:**
  - new: `relay/**`, `src/shared/relay-token.ts`, `src/server/relay-token-handler.ts`, `src/app/api/relay-token/route.ts`, `tests/relay-*.test.ts`, `tests/helpers/**`, `STAGE6_NOTES.md`
  - modified:
    - `package.json`: add `"ws": "^8.18.0"` to `dependencies`, `"@types/ws": "^8.5.12"` to `devDependencies`, and the script `"relay": "tsx relay/src/main.ts"`. Install them with npm, which updates `package-lock.json`.
    - `.env.example`: add `RELAY_ALLOWED_ORIGINS=`, `RELAY_MAX_SESSIONS=` and `ASR_UPSTREAM_URL=`
- **Frozen; the reviewer checks SHA-256:** every existing file under `src/`, plus `configs/`, `evals/`, `scripts/`, `next.config.ts`, `tsconfig.json` and `vitest.config.ts`.
- **No other new dependencies.** No permission/ACL tooling, and no tool output in the repo. Don't touch `.bridge/` or `AGENTS.md`.
- **No network** beyond `localhost` in tests. Never connect to `api.meta.ai`.
- **Add tests; don't delete or weaken any.**
- If anything is ambiguous, write the question in `STAGE6_NOTES.md` rather than guessing.

---

## Files to create

### 1. `src/shared/relay-token.ts` (pure, `node:crypto` only; **no `server-only`**)
```ts
export const RELAY_TOKEN_TTL_MS = 120_000;
export interface RelayTokenPayload { v: 1; exp: number; nonce: string; configId: string }
export function signRelayToken(payload: RelayTokenPayload, secret: string): string
export function verifyRelayToken(token: string, secret: string, now: number):
  | { ok: true; payload: RelayTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "bad_payload" }
```
- **Format:** `<payloadPart>.<sigPart>`.
  - `payloadPart` = base64url(UTF-8 JSON of the payload).
  - `sigPart` = base64url(HMAC-SHA256(secret, payloadPart)).
- **Verification order:**
  1. Exactly one `.` and both parts non-empty; otherwise `malformed`.
  2. Signature compared with `crypto.timingSafeEqual` on equal-length buffers; a length mismatch counts as `bad_signature`.
  3. Payload JSON parses and matches the shape (zod: `v` is literal 1, `exp` is an int, `nonce` matches `/^[0-9a-f]{32}$/`, `configId` is a non-empty string); otherwise `bad_payload`.
  4. `now >= exp` → `expired`.

### 2. `src/server/relay-token-handler.ts` (`import "server-only"`) and `src/app/api/relay-token/route.ts`
```ts
export function createRelayTokenHandler(deps: {
  getEnv: () => Record<string, string | undefined>;
  now: () => number;
  randomHex: (bytes: number) => string;
}): (request: Request) => Promise<Response>;
```
- **Request:** `POST` with JSON body `{ "configId": "<id>" }`.
- **Responses:**
  - `RELAY_SECRET` missing, or shorter than 32 characters, or `RELAY_URL` missing: **503** `{ "error": { "code": "relay_unavailable", "message": "Voice input is not available right now." } }`. Log once with `console.warn`; never log the secret.
  - Invalid JSON, or `configId` not resolving via `getConfig`: **400** `{ "error": { "code": "bad_request", "message": "..." } }`.
  - Otherwise **200** `{ "token", "url": RELAY_URL, "expiresAt" }`, where `expiresAt = now() + RELAY_TOKEN_TTL_MS`. The token is signed over `{ v: 1, exp: expiresAt, nonce: randomHex(16), configId }`.
  - Every response carries `Cache-Control: no-store`.
- **The route file** is exactly:
  ```ts
  import { createRelayTokenHandler } from "@/server/relay-token-handler";
  import { randomBytes } from "node:crypto";
  export const POST = createRelayTokenHandler({ getEnv: () => process.env, now: () => Date.now(), randomHex: (n) => randomBytes(n).toString("hex") });
  ```

### 3. `relay/src/map-upstream.ts` (pure)
```ts
export type UpstreamEvent = Record<string, unknown>;
export function isUpstreamReady(msg: UpstreamEvent): msg is { sessionId: string }   // has a string sessionId and NO "type" key
export function mapUpstreamEvent(msg: UpstreamEvent):
  | { kind: "send"; message: RelayServerMessage }
  | { kind: "fatal"; message: string }
  | { kind: "ignore" }
```
| upstream `type` | result |
|---|---|
| `speechStart` (with a string `turnId`) | send `{ type: "turn_start", turnId }` |
| `transcript` with `final !== true` (string `transcript`) | send `{ type: "partial", text: transcript }` |
| `transcript` with `final === true` | ignore (`ENDPOINTING` mode completes turns via `speechComplete`) |
| `speechComplete` (string `turnId` and `transcript`) | send `{ type: "turn_complete", turnId, text: transcript }` |
| `error` | fatal, with message `"Transcription service error"`. **Never forward upstream error text to the browser.** |
| `speechEnd`, `audioProgress`, `speaker`, any other or missing `type`, or a known type missing its required fields | ignore |

### 4. `relay/src/server.ts`: the relay (uses `ws` and `node:http`)
```ts
export interface RelayOptions {
  port: number;                       // 0 = random (tests)
  secret: string;                     // RELAY_SECRET
  apiKey: string;                     // MODEL_API_KEY: sent ONLY to upstream
  upstreamUrl: string;                // ASR_UPSTREAM_URL, default wss://api.meta.ai/v1/asr/realtime
  allowedOrigins: string[] | null;    // null = allow any Origin
  maxSessions: number;                // default 50
  authTimeoutMs: number;              // default 5000
  upstreamReadyTimeoutMs: number;     // default 10000
  maxSessionMs: number;               // default 1_800_000 (30 min)
  preReadyBufferBytes: number;        // default 64_000 (2 s of 16 kHz PCM16)
  now?: () => number;                 // default Date.now
}
export function startRelay(opts: RelayOptions): Promise<{ port: number; close(): Promise<void> }>;
```

**HTTP:**
- `GET /healthz` → `200 ok` (text).
- Any other plain HTTP request → 404.
- WebSocket upgrades are accepted **only** on path `/asr`; any other path → `404` and destroy the socket.
- If `allowedOrigins` is set and the request's `Origin` isn't in it → `403` and destroy.
- If active sessions ≥ `maxSessions` → accept, send `{ "type": "error", "message": "busy", "fatal": true }`, then close with code **1013**.
- Set `ws` `maxPayload` to `65536`.

**Per-session lifecycle** (implement it as a small state machine: `awaiting_auth` → `connecting_upstream` → `ready` → `ending` → `closed`):

1. **Auth.** The first message must be a **text** frame parsing to `{ type: "auth", token }` under `RelayClientMessageSchema`.
   - **Any failure** closes with code **4001**, after sending error `"unauthorized"` (`fatal: true`). Failures include:
     - no auth within `authTimeoutMs`
     - a binary first frame, invalid JSON, or a non-auth message
     - `verifyRelayToken` fails
     - a nonce that was already used (**replay**: keep used nonces until their `exp`, then purge them)
     - a `configId` that doesn't resolve
   - **Don't open the upstream connection** in that case.
2. **Connect upstream** to `upstreamUrl` and send the handshake JSON, exactly as above, with `accessToken: "Bearer " + apiKey` and `keywords: getConfig(configId).asrKeywords`.
   - Binary frames from the client **while connecting** are buffered up to `preReadyBufferBytes` in total. Anything beyond that is discarded.
   - If no `isUpstreamReady` message arrives within `upstreamReadyTimeoutMs`, or the upstream fails to connect: send error `"Transcription service unavailable"` (`fatal: true`), close the client with **4503**, and close the upstream.
3. **Ready.** When the acknowledgement arrives, send `{ "type": "ready" }`, then flush the buffered audio in order.
   - From then on, forward every client binary frame to the upstream unchanged.
   - Translate every upstream text frame with `mapUpstreamEvent`:
     - `send` → send it to the client
     - `ignore` → drop it
     - `fatal` → send the error (`fatal: true`), close the client with **4502**, and close the upstream
4. **Client text frames after auth:**
   - `{ type: "end" }` → send `{"type":"endStream"}` upstream and enter `ending`. Keep forwarding events until the upstream closes, then close the client with **1000**.
   - Any other or invalid text → send `{ "type": "error", "message": "invalid message", "fatal": false }` and ignore it.
5. **Upstream closes unexpectedly** (any close not in `ending`, or a non-1000 close while `ending`): send error `"Transcription service disconnected"` (`fatal: true`) and close the client with **4502**.
6. **Client disconnects:** if the upstream is open, send `{"type":"endStream"}` and close it within 2 s (terminate if it hasn't closed by then).
7. **Session time limit:** after `maxSessionMs` from auth, send error `"session time limit reached"` (`fatal: true`), close the client with **4008**, and close the upstream.
8. **Logging:** exactly one `console.info` JSON line when a session ends: `{ tag: "relay_session", configId, durationMs, bytesIn, closeCode }`. **Never log the token, the API key or any transcript text.**

**Close codes summary:** 1000 normal, 1013 busy, 4001 unauthorized, 4008 time limit, 4502 upstream error or disconnect, 4503 upstream unavailable.

### 5. `relay/src/config.ts` (pure) and `relay/src/main.ts`
- **`loadRelayEnv(env: Record<string, string | undefined>): { ok: true; opts: RelayOptions } | { ok: false; errors: string[] }`:**
  - Requires `RELAY_SECRET` (≥ 32 characters) and `MODEL_API_KEY` (non-empty).
  - `PORT` defaults to `8080`.
  - `ASR_UPSTREAM_URL` defaults to `wss://api.meta.ai/v1/asr/realtime`.
  - `RELAY_ALLOWED_ORIGINS` is comma-separated and trimmed; empty means `null`.
  - `RELAY_MAX_SESSIONS` is a positive int, default 50.
  - The other options use the defaults above.
  - Error strings name the variable but **never its value**.
- **`relay/src/main.ts`:**
  - Calls `loadRelayEnv(process.env)`.
  - On failure: print each error and `process.exit(1)`.
  - On success: `startRelay`, log `relay listening on :<port>`, and close cleanly on SIGINT/SIGTERM.
  - **Don't run it against Meta; that's on hold.**

### 6. `relay/scripts/wav-client.ts`: manual test client (for later; held)
`tsx relay/scripts/wav-client.ts --url ws://localhost:8080/asr --wav <file.wav> --config maths-oxbridge`:
1. Mints a token locally with `RELAY_SECRET` from the environment.
2. Reads a 16 kHz mono PCM16 WAV (it rejects other formats with a clear message, and strips the 44-byte header after validating `RIFF`/`WAVE`/`fmt `/`data`).
3. Connects, sends auth, and waits for `ready`.
4. Sends 100 ms frames (3200 bytes) **paced in real time** with `setTimeout`.
5. Sends `end`, then prints every relay message with a timestamp.

Factor the WAV parsing into `relay/src/wav.ts` (pure) so it can be tested.

### 7. `tests/helpers/fake-meta-asr.ts`: a fake Meta server for tests
```ts
export async function startFakeMetaAsr(behaviour?: {
  ack?: "immediate" | "never";          // default immediate: replies { sessionId: "sess-1" } after the handshake
  rejectHandshake?: boolean;            // close 1008 on handshake instead of ack
}): Promise<{
  url: string;                          // ws://127.0.0.1:<port>
  handshakes: unknown[];                // parsed handshake frames received
  audio: Buffer[];                      // binary frames received, in order
  texts: unknown[];                     // all parsed text frames after the handshake
  send(event: object): void;            // send a JSON text frame to the current session
  close(code: number): void;            // close the current session's socket
  connections(): number;
  stop(): Promise<void>;
}>
```

---

## Tests (`vitest`; localhost only)

### `tests/relay-token.test.ts`
- A sign/verify round trip.
- **Each failure reason:**
  - `malformed`: no dot, two dots, empty part
  - `bad_signature`: a tampered signature, a different secret, a shortened signature
  - `bad_payload`: valid signature but bad JSON or wrong shape (sign a crafted payload part directly)
  - `expired`: at `now === exp` and after it; still valid at `exp − 1`
- The signature is exactly HMAC-SHA256 over the payload part. Recompute it in the test.

### `tests/relay-route.test.ts`
Uses `createRelayTokenHandler` with injected env, `now` and `randomHex`.
- **503** for each of: secret missing, secret too short (31 characters), URL missing. The secret value never appears in the response or in the log.
- **400** for invalid JSON and for an unknown `configId`.
- **200:** the body matches `{ token, url, expiresAt: now + 120000 }`; the token verifies with the secret; the payload's `configId` and `nonce` are the injected values.
- `Cache-Control: no-store` on 200, 400 and 503 responses.

### `tests/relay-map.test.ts`
- **Every row of the mapping table.**
- **`isUpstreamReady`:** true for `{sessionId:"x"}`, false for `{sessionId:"x", type:"error"}` and for `{}`.
- The `error` mapping never includes the upstream's own message text.

### `tests/relay-config.test.ts`
- **Required variables:** missing or short `RELAY_SECRET` and missing `MODEL_API_KEY` each produce an error naming the variable, and the error **doesn't contain the value**.
- Each default value.
- Origin list parsing (trimmed, empty → `null`) and `RELAY_MAX_SESSIONS` validation.

### `tests/relay-wav.test.ts`
- Parses a programmatically built 16 kHz mono PCM16 WAV.
- Rejects stereo, 44.1 kHz, 8-bit, and a missing `RIFF`/`WAVE` header, each with a clear error.

### `tests/relay-server.test.ts`
Real relay + fake Meta, both on port 0. Use small timeouts in options (for example `authTimeoutMs: 200`). Close everything after each test. Use the `ws` client.
1. **Health:** `/healthz` → 200 `ok`; another HTTP path → 404; a WS upgrade on a path other than `/asr` fails.
2. **Happy path:**
   - After auth, the fake receives **exactly one** handshake, deep-equal to the expected JSON (including `"Bearer test-key"` and `getConfig("maths-oxbridge").asrKeywords`).
   - The client then receives `ready`.
3. **Audio:**
   - Frames sent after `ready` arrive at the fake byte for byte, in order.
   - Frames sent before `ready` (with the fake on `ack: "never"`, then acknowledging manually via `send({sessionId:"s"})`) are flushed in order after `ready`.
   - Pre-ready bytes beyond `preReadyBufferBytes` are discarded.
4. **Event translation:** with the fake sending `speechStart`, `transcript` (partial), `transcript` (final), `speechEnd`, `audioProgress`, an unknown type, then `speechComplete`, the client receives exactly `turn_start`, `partial`, `turn_complete`, in that order.
5. **Ending:** the client's `{type:"end"}` → the fake receives `{"type":"endStream"}`. The fake closes with 1000 → the client is closed with 1000.
6. **Auth failures** (each closes with **4001** after an `unauthorized` error, and the fake sees **zero** connections):
   - a bad signature
   - an expired token
   - a binary first frame
   - non-auth JSON first
   - an auth timeout
   - a **reused token** (the second connection using the same token is rejected)
   - an unknown `configId` inside a validly signed token
7. **Upstream failures:**
   - `ack: "never"` → after `upstreamReadyTimeoutMs`, error `Transcription service unavailable` and close **4503**
   - the fake sends `{type:"error", message:"secret upstream detail"}` → close **4502**, and the text `secret upstream detail` never reaches the client
   - the fake closes 1011 mid-session → error `Transcription service disconnected` and close **4502**
8. **Client disconnects mid-session:** the fake receives `{"type":"endStream"}`, and its connection is closed within 2.5 s.
9. **Limits:**
   - `allowedOrigins: ["https://ok.example"]`: an upgrade with `Origin: https://bad.example` is rejected with 403, while `https://ok.example` works
   - `maxSessions: 1`: a second concurrent client gets `busy` and close **1013**
   - `maxSessionMs: 300`: the client gets `session time limit reached` and close **4008**
10. **Secrets:**
    - Across all messages the client receives in tests 2–9, the API key string never appears.
    - The `relay_session` log lines (spy on `console.info`) contain no token, API key or transcript text.
    - Exactly one `relay_session` line per finished session.
11. **Invalid text after auth** → `{type:"error", message:"invalid message", fatal:false}`, and the session stays open (`ready` traffic still flows).

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings), **`npx vitest run` exits 0 with no `Errors` line**, and `npm run build` (without any keys) all pass.
2. The Next.js client bundle doesn't include `ws` or any relay code. `src/app/` must not import from `relay/`.
3. **No test connects anywhere except `127.0.0.1`/`localhost`.**
4. Frozen files are byte-for-byte unchanged. `package.json` changes only by the two dependencies and the `relay` script, and `package-lock.json` changes only through `npm install`.
5. Every rule has a test that fails if it's changed. The reviewer will revert rules one at a time across `relay-token.ts`, `relay-token-handler.ts`, `map-upstream.ts`, `server.ts`, `config.ts` and `wav.ts`.
6. No test name is removed.

## Held (not part of this stage)
- **Connecting the relay to the real Meta API** (needs `MODEL_API_KEY`), including verifying Meta's actual event field names in `map-upstream.ts`.
- **Packaging and deploying the relay** to Fly.io (Dockerfile, `fly.toml`, secrets): public deployment.
