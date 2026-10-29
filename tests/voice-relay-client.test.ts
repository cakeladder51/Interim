import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import {
  connectRelay,
  RelayConnectError,
  RELAY_READY_TIMEOUT_MS,
  RELAY_END_TIMEOUT_MS,
} from "../src/client/voice/relay-client";
import type { WebSocketLike, RelayHandlers } from "../src/client/voice/relay-client";
import { startRelay } from "../relay/src/server";
import { startFakeMetaAsr } from "./helpers/fake-meta-asr";
import { signRelayToken } from "../src/shared/relay-token";

const SECRET = "s".repeat(40);
const API_KEY = "test-api-key";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeHandlers() {
  const events: unknown[][] = [];
  const handlers = {
    onPartial: vi.fn((text: string) => {
      events.push(["partial", text]);
    }),
    onTurnStart: vi.fn((turnId: string) => {
      events.push(["turn_start", turnId]);
    }),
    onTurnComplete: vi.fn((turnId: string, text: string) => {
      events.push(["turn_complete", turnId, text]);
    }),
    onClose: vi.fn((info: { code: number; intentional: boolean }) => {
      events.push(["close", info]);
    }),
  } satisfies RelayHandlers;
  return { handlers, events };
}

describe("voice-relay-client", () => {
  type Fake = Awaited<ReturnType<typeof startFakeMetaAsr>>;
  type Relay = Awaited<ReturnType<typeof startRelay>>;
  const fakes: Fake[] = [];
  const relays: Relay[] = [];
  const sockets: WebSocket[] = [];
  let fake: Fake;
  let port: number;

  async function start(opts: { ack?: "immediate" | "never"; maxSessions?: number; upstreamReadyTimeoutMs?: number } = {}) {
    fake = await startFakeMetaAsr(opts.ack ? { ack: opts.ack } : undefined);
    fakes.push(fake);
    const relay = await startRelay({
      port: 0,
      secret: SECRET,
      apiKey: API_KEY,
      upstreamUrl: fake.url,
      allowedOrigins: null,
      maxSessions: opts.maxSessions ?? 5,
      authTimeoutMs: 500,
      upstreamReadyTimeoutMs: opts.upstreamReadyTimeoutMs ?? 1000,
      maxSessionMs: 30_000,
      preReadyBufferBytes: 64000,
    });
    relays.push(relay);
    port = relay.port;
  }

  // Relay tokens carry `exp` in epoch MILLISECONDS (see src/shared/relay-token.ts, RELAY_TOKEN_TTL_MS).
  function makeToken(secret = SECRET) {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return {
      token: signRelayToken({ v: 1, exp: Date.now() + 120_000, nonce, configId: "maths-oxbridge" }, secret),
      url: `ws://127.0.0.1:${port}/asr`,
    };
  }

  function createSocket(url: string): WebSocketLike {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    return ws as unknown as WebSocketLike;
  }

  beforeEach(async () => {
    await start();
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    for (const r of relays.splice(0)) await r.close();
    for (const f of fakes.splice(0)) await f.stop();
  });

  describe("1. Connect", () => {
    it("resolves when relay sends ready", async () => {
      const { handlers } = makeHandlers();
      const conn = await connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers });
      expect(conn).toBeDefined();
      expect(fake.handshakes.length).toBe(1);
      conn.close();
    });
  });

  describe("2. Audio", () => {
    it("sends audio frames in order", async () => {
      const { handlers } = makeHandlers();
      const conn = await connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers });
      const frames = [1, 2, 3].map((n) => Uint8Array.from({ length: 3200 }, (_, i) => (i * n + n) & 0xff));
      for (const f of frames) conn.sendAudio(f);
      await waitFor(() => Buffer.concat(fake.audio).length >= 9600);
      const received = Buffer.concat(fake.audio);
      expect(received.length).toBe(9600);
      expect(received.equals(Buffer.concat(frames.map((f) => Buffer.from(f))))).toBe(true);
      conn.close();
    });
  });

  describe("3. Events", () => {
    it("maps events correctly", async () => {
      const { handlers, events } = makeHandlers();
      const conn = await connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers });
      fake.send({ type: "speechStart", turnId: "t1" });
      fake.send({ type: "transcript", transcript: "I think", final: false });
      fake.send({ type: "speechComplete", turnId: "t1", transcript: "I think it is two" });
      await waitFor(() => events.length >= 3);
      expect(events).toEqual([
        ["turn_start", "t1"],
        ["partial", "I think"],
        ["turn_complete", "t1", "I think it is two"],
      ]);
      conn.close();
    });
  });

  describe("4. end()", () => {
    it("sends endStream and resolves on close", async () => {
      const { handlers } = makeHandlers();
      const conn = await connectRelay({
        fetchToken: async () => makeToken(),
        createSocket,
        handlers,
        endTimeoutMs: 10_000,
      });
      const t0 = Date.now();
      let ended = false;
      const endP = conn.end().then(() => {
        ended = true;
      });
      await waitFor(() => fake.texts.some((t) => (t as { type?: string }).type === "endStream"));
      expect(ended).toBe(false);
      fake.close(1000);
      await endP;
      // resolved by the close, not by the 10 s end timeout
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 1000, intentional: true });
    });
  });

  describe("5. unexpected close", () => {
    it("calls onClose with 4502 for upstream error", async () => {
      const { handlers } = makeHandlers();
      await connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers });
      fake.close(1011);
      await waitFor(() => handlers.onClose.mock.calls.length > 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 4502, intentional: false });
    });
  });

  describe("6. fetchToken rejects", () => {
    it("rejects with unavailable and never creates socket", async () => {
      const createSocketSpy = vi.fn(createSocket);
      const { handlers } = makeHandlers();
      const err = await connectRelay({
        fetchToken: () => Promise.reject(new Error("no token")),
        createSocket: createSocketSpy,
        handlers,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayConnectError);
      expect(err).toMatchObject({ kind: "unavailable", code: null, name: "RelayConnectError" });
      expect(createSocketSpy).not.toHaveBeenCalled();
    });
  });

  describe("7. wrong secret", () => {
    it("rejects with unauthorized", async () => {
      const { handlers } = makeHandlers();
      await expect(
        connectRelay({ fetchToken: async () => makeToken("x".repeat(40)), createSocket, handlers })
      ).rejects.toMatchObject({ kind: "unauthorized", code: 4001 });
      expect(handlers.onClose).not.toHaveBeenCalled();
    });
  });

  describe("8. maxSessions", () => {
    it("rejects with busy when max sessions reached", async () => {
      await start({ maxSessions: 1 });
      const { handlers } = makeHandlers();
      const conn1 = await connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers });
      await expect(
        connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers })
      ).rejects.toMatchObject({ kind: "busy", code: 1013 });
      conn1.close();
    });
  });

  describe("9. upstream unavailable", () => {
    it("rejects with upstream when upstreamReadyTimeout", async () => {
      await start({ ack: "never", upstreamReadyTimeoutMs: 300 });
      const { handlers } = makeHandlers();
      await expect(
        connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers })
      ).rejects.toMatchObject({ kind: "upstream", code: 4503 });
    });
  });

  describe("10. ready timeout", () => {
    it("rejects with timeout", async () => {
      await start({ ack: "never", upstreamReadyTimeoutMs: 5000 });
      const { handlers } = makeHandlers();
      const t0 = Date.now();
      await expect(
        connectRelay({ fetchToken: async () => makeToken(), createSocket, handlers, readyTimeoutMs: 200 })
      ).rejects.toMatchObject({ kind: "timeout", code: null });
      expect(Date.now() - t0).toBeLessThan(1000);
    });
  });

  // ---- 11. Unit tests with a hand-written fake WebSocketLike (no relay) ----
  class FakeSocket implements WebSocketLike {
    readyState = 0;
    sent: (string | Uint8Array)[] = [];
    closeCalls: (number | undefined)[] = [];
    private listeners = new Map<string, ((e: { data?: unknown; code?: number }) => void)[]>();
    send(data: string | Uint8Array) {
      this.sent.push(data);
    }
    close(code?: number) {
      this.closeCalls.push(code);
    }
    addEventListener(type: "open" | "message" | "close" | "error", listener: (e: { data?: unknown; code?: number }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: "open" | "message" | "close" | "error", e: { data?: unknown; code?: number } = {}) {
      if (type === "open") this.readyState = 1;
      if (type === "close") this.readyState = 3;
      for (const l of this.listeners.get(type) ?? []) l(e);
    }
    message(obj: unknown) {
      this.emit("message", { data: JSON.stringify(obj) });
    }
  }

  async function connectFake(opts: { readyTimeoutMs?: number; endTimeoutMs?: number } = {}) {
    const sock = new FakeSocket();
    const { handlers, events } = makeHandlers();
    const p = connectRelay({ fetchToken: async () => ({ token: "tok", url: "ws://unit" }), createSocket: () => sock, handlers, ...opts });
    await tick();
    sock.emit("open");
    expect(sock.sent).toEqual([JSON.stringify({ type: "auth", token: "tok" })]);
    sock.message({ type: "ready" });
    const conn = await p;
    return { sock, conn, handlers, events };
  }

  describe("11. invalid messages ignored", () => {
    it("ignores invalid JSON and binary data", async () => {
      const { sock, events } = await connectFake();
      expect(() => {
        sock.emit("message", { data: "not json" });
        sock.message({ type: "unknown" });
        sock.message({ type: "partial" });
        sock.emit("message", { data: new ArrayBuffer(10) });
        sock.emit("message", { data: Buffer.from(JSON.stringify({ type: "partial", text: "binary" })) });
      }).not.toThrow();
      expect(events).toEqual([]);
      sock.message({ type: "partial", text: "ok" });
      expect(events).toEqual([["partial", "ok"]]);
    });

    it("drops sendAudio when not OPEN", async () => {
      const { sock, conn } = await connectFake();
      const frame = new Uint8Array([1, 2]);
      sock.readyState = 2;
      conn.sendAudio(frame);
      expect(sock.sent).toHaveLength(1); // only the auth frame
      sock.readyState = 1;
      conn.sendAudio(frame);
      expect(sock.sent).toHaveLength(2);
      expect(sock.sent[1]).toBe(frame);
    });

    it("maps close codes before ready", async () => {
      const cases: [number, string][] = [
        [4001, "unauthorized"],
        [1013, "busy"],
        [4502, "upstream"],
        [4503, "upstream"],
        [1006, "closed"],
        [1000, "closed"],
      ];
      for (const [code, kind] of cases) {
        const sock = new FakeSocket();
        const { handlers } = makeHandlers();
        const p = connectRelay({ fetchToken: async () => ({ token: "t", url: "ws://unit" }), createSocket: () => sock, handlers });
        await tick();
        sock.emit("open");
        sock.message({ type: "partial", text: "before ready" }); // ignored before ready
        sock.emit("error");
        sock.emit("close", { code });
        await expect(p).rejects.toMatchObject({ kind, code });
        expect(handlers.onPartial).not.toHaveBeenCalled();
        expect(handlers.onClose).not.toHaveBeenCalled();
      }
    });

    it("ready timeout closes the socket and ignores later events", async () => {
      const sock = new FakeSocket();
      const { handlers, events } = makeHandlers();
      const p = connectRelay({
        fetchToken: async () => ({ token: "t", url: "ws://unit" }),
        createSocket: () => sock,
        handlers,
        readyTimeoutMs: 30,
      });
      await tick();
      sock.emit("open");
      await expect(p).rejects.toMatchObject({ kind: "timeout", code: null });
      expect(sock.closeCalls).toEqual([1000]);
      sock.message({ type: "ready" });
      sock.message({ type: "partial", text: "late" });
      sock.emit("close", { code: 1000 });
      expect(events).toEqual([]);
    });

    it("end() resolves when the close arrives", async () => {
      const { sock, conn, handlers } = await connectFake({ endTimeoutMs: 60_000 });
      let ended = false;
      const endP = conn.end().then(() => {
        ended = true;
      });
      expect(sock.sent[sock.sent.length - 1]).toBe(JSON.stringify({ type: "end" }));
      await tick();
      expect(ended).toBe(false);
      sock.emit("close", { code: 1000 });
      await endP;
      expect(sock.closeCalls).toEqual([]);
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 1000, intentional: true });
    });

    it("end() forces close(1000) after endTimeoutMs", async () => {
      const { sock, conn } = await connectFake({ endTimeoutMs: 30 });
      const t0 = Date.now();
      await conn.end();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
      expect(sock.closeCalls).toEqual([1000]);
    });

    it("end() on a closed socket resolves immediately without sending", async () => {
      const { sock, conn, handlers } = await connectFake({ endTimeoutMs: 60_000 });
      sock.emit("close", { code: 4502 });
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 4502, intentional: false });
      const sentBefore = sock.sent.length;
      await conn.end();
      expect(sock.sent).toHaveLength(sentBefore);
    });

    it("close() closes with 1000 and onClose is intentional, exactly once", async () => {
      const { sock, conn, handlers } = await connectFake();
      conn.close();
      expect(sock.closeCalls).toEqual([1000]);
      sock.emit("close", { code: 1000 });
      sock.emit("close", { code: 1000 });
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 1000, intentional: true });
    });

    it("an unexpected close calls onClose once with intentional false", async () => {
      const { sock, handlers } = await connectFake();
      sock.emit("close", { code: 4502 });
      sock.emit("close", { code: 4502 });
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 4502, intentional: false });
    });

    it("constants and error class", () => {
      expect(RELAY_READY_TIMEOUT_MS).toBe(12_000);
      expect(RELAY_END_TIMEOUT_MS).toBe(3_000);
      const e = new RelayConnectError("busy", 1013);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("RelayConnectError");
      expect(e.kind).toBe("busy");
      expect(e.code).toBe(1013);
    });
  });
});
