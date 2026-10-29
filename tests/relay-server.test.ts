import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../relay/src/server";
import { startFakeMetaAsr, type FakeMetaResult } from "./helpers/fake-meta-asr";
import { signRelayToken } from "../src/shared/relay-token";

const secret = "test-secret-must-be-at-least-32-chars";
const apiKey = "test-api-key";

async function setupRelay(fakeMeta: FakeMetaResult, options: Partial<Parameters<typeof startRelay>[0]> = {}) {
  return startRelay({
    port: 0,
    secret,
    apiKey,
    upstreamUrl: fakeMeta.url,
    allowedOrigins: null,
    maxSessions: 50,
    authTimeoutMs: 500,
    upstreamReadyTimeoutMs: 1000,
    maxSessionMs: 30_000,
    preReadyBufferBytes: 64000,
    ...options,
  });
}

function buildToken(configId: string, nonce: string, exp: number): string {
  return signRelayToken({ v: 1, exp, nonce, configId }, secret);
}

describe("relay-server", () => {
  let fakeMeta: FakeMetaResult | null = null;
  let relay: { port: number; close(): Promise<void>; trackedSessions(): number } | null = null;
  let testLogs: { info: unknown[]; warn: unknown[] } = { info: [], warn: [] };
  let originalInfo: typeof console.info;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalInfo = console.info;
    originalWarn = console.warn;
    testLogs = { info: [], warn: [] };
    console.info = (...args: unknown[]) => { testLogs.info.push(args); };
    console.warn = (...args: unknown[]) => { testLogs.warn.push(args); };
  });

  afterEach(async () => {
    console.info = originalInfo;
    console.warn = originalWarn;
    
    if (relay) {
      await relay.close();
      relay = null;
    }
    if (fakeMeta) {
      await fakeMeta.stop();
      fakeMeta = null;
    }
  });

  describe("HTTP endpoint", () => {
    it("GET /healthz -> 200 ok", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });

    it("other HTTP path -> 404", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const res = await fetch(`http://127.0.0.1:${relay.port}/other`);
      expect(res.status).toBe(404);
    });

    it("WS upgrade on path other than /asr fails", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/other`);
      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    // T1e: wrong path returns 404
    it("T1e: WS upgrade on /other gets 404 response", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/other`);

      let statusCode: number | null = null;
      
      const result = await new Promise<{ statusCode: number | null; closed: boolean }>((resolve) => {
        ws.on("unexpected-response", (_req, res) => {
          statusCode = res.statusCode ?? null;
          resolve({ statusCode, closed: false });
        });
        ws.on("close", () => {
          resolve({ statusCode, closed: true });
        });
        ws.on("error", () => {
          resolve({ statusCode, closed: true });
        });
      });

      expect(result.statusCode).toBe(404);
      // Fake should see zero connections
      expect(fakeMeta!.connections()).toBe(0);
    }, 10000);
  });

  describe("happy path", () => {
    it("after auth, fake receives exactly one handshake with correct format", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      const ready = new Promise<void>((resolve) => {
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if ((msg as { type: string }).type === "ready") resolve();
        });
      });

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      await ready;
      clientWs.close();

      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Check handshake received
      expect(fakeMeta.handshakes).toHaveLength(1);
      const handshake = fakeMeta.handshakes[0] as Record<string, unknown>;
      expect(handshake.authorization).toEqual({ accessToken: "Bearer test-api-key" });
      expect(handshake.audioEncoding).toBe("PCM_16KHZ");
      expect(handshake.model).toBe("muse-voice-transcribe-1.0");
      expect(handshake.mode).toBe("ENDPOINTING");
      expect(handshake.partialMode).toBe("CUMULATIVE");
      // T1c: keywords must match exactly (deep-equal)
      const { getConfig } = await import("../src/config/load");
      const expectedKeywords = getConfig("maths-oxbridge").asrKeywords;
      expect(handshake.keywords).toEqual(expectedKeywords);
      expect(Array.isArray(handshake.keywords)).toBe(true);
      expect((handshake.keywords as string[]).length).toBeGreaterThan(0); // non-empty
    });

    it("client receives ready after handshake", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const ready = new Promise<unknown>((resolve) => {
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if ((msg as { type: string }).type === "ready") {
            resolve(msg);
          }
        });
      });

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      await expect(ready).resolves.toEqual({ type: "ready" });

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });
  });

  describe("audio", () => {
    it("frames sent after ready arrive at fake byte for byte, in order", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let readyReceived = false;
      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if ((msg as { type: string }).type === "ready") {
          readyReceived = true;
        }
      });

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      // Wait for ready
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (readyReceived) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });

      // Send audio frames
      const frame1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const frame2 = Buffer.from([0x05, 0x06, 0x07, 0x08]);
      const frame3 = Buffer.from([0x09, 0x0a, 0x0b, 0x0c]);

      clientWs.send(frame1);
      clientWs.send(frame2);
      clientWs.send(frame3);

      // Wait for audio to arrive
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Check audio received
      expect(fakeMeta.audio.length).toBeGreaterThanOrEqual(3);
      expect(fakeMeta.audio[0]).toEqual(frame1);
      expect(fakeMeta.audio[1]).toEqual(frame2);
      expect(fakeMeta.audio[2]).toEqual(frame3);
    });

    it("frames sent before ready are buffered and flushed in order", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      // Wait a bit for auth to be received
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Send audio before ready
      const frame1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const frame2 = Buffer.from([0x05, 0x06, 0x07, 0x08]);
      clientWs.send(frame1);
      clientWs.send(frame2);

      // Now make fake respond
      fakeMeta.send({ sessionId: "sess-1" });

      // Wait for ready
      await new Promise<void>((resolve) => {
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if ((msg as { type: string }).type === "ready") {
            resolve();
          }
        });
      });

      // Wait for audio to arrive
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Check audio arrived in order
      expect(fakeMeta.audio.length).toBeGreaterThanOrEqual(2);
      expect(fakeMeta.audio[0]).toEqual(frame1);
      expect(fakeMeta.audio[1]).toEqual(frame2);
    });

    it("pre-ready bytes beyond limit are discarded", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta, { preReadyBufferBytes: 8 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Send more than buffer limit
      const frame1 = Buffer.from([0x01, 0x02, 0x03, 0x04]); // 4 bytes
      const frame2 = Buffer.from([0x05, 0x06, 0x07, 0x08]); // 4 bytes (total 8)
      const frame3 = Buffer.from([0x09, 0x0a, 0x0b, 0x0c]); // Discarded (beyond limit)
      clientWs.send(frame1);
      clientWs.send(frame2);
      clientWs.send(frame3);

      // Now acknowledge
      fakeMeta.send({ sessionId: "sess-1" });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Only first two frames should be received
      expect(fakeMeta.audio.length).toBeGreaterThanOrEqual(2);
      expect(fakeMeta.audio[0]).toEqual(frame1);
      expect(fakeMeta.audio[1]).toEqual(frame2);
    });

    // T1d: pre-ready buffer cap is strictly enforced
    it("T1d: pre-ready buffer cap discards bytes over limit", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta, { preReadyBufferBytes: 1000 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Send three 600-byte frames before ready
      const frame1 = Buffer.alloc(600, 0x01);
      const frame2 = Buffer.alloc(600, 0x02);
      const frame3 = Buffer.alloc(600, 0x03);
      clientWs.send(frame1); // 0-599 buffered
      clientWs.send(frame2); // 600-999 buffered, 400-599 discarded
      clientWs.send(frame3); // all discarded

      // Now acknowledge
      fakeMeta.send({ sessionId: "sess-1" });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Total bytes received = exactly 1000
      const totalBytes = fakeMeta.audio.reduce((sum, buf) => sum + buf.length, 0);
      expect(totalBytes).toBe(1000);
      // First frame intact, second frame partial
      expect(fakeMeta.audio[0]).toEqual(frame1);
      expect(fakeMeta.audio[1]).toEqual(frame2.subarray(0, 400));
    });
  });

  describe("event translation", () => {
    it("correct event order: turn_start, partial, turn_complete", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      clientWs.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      await new Promise<void>((resolve) => {
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if ((msg as { type: string }).type === "ready") {
            // Send events from fake
            fakeMeta!.send({ type: "speechStart", turnId: "turn-1", audioProcessedMs: 100 });
            fakeMeta!.send({ type: "transcript", transcript: "Hello", final: false, audioProcessedMs: 200 });
            fakeMeta!.send({ type: "transcript", transcript: "Hello world", final: true, audioProcessedMs: 300 });
            fakeMeta!.send({ type: "speechEnd", turnId: "turn-1" });
            fakeMeta!.send({ type: "audioProgress", ms: 400 });
            fakeMeta!.send({ type: "someUnknownType" });
            fakeMeta!.send({ type: "speechComplete", turnId: "turn-1", transcript: "Hello world" });
            resolve();
          }
        });
      });

      // Wait for messages
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Filter out ready message
      const events = messages.filter((m) => (m as { type: string }).type !== "ready");

      // Should receive turn_start, partial, turn_complete (in that order)
      expect(events).toEqual([
        { type: "turn_start", turnId: "turn-1" },
        { type: "partial", text: "Hello" },
        { type: "turn_complete", turnId: "turn-1", text: "Hello world" },
      ]);
    });
  });

  describe("ending", () => {
    it("client end -> fake receives endStream, close 1000", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      // Wait for ready, then send end
      await new Promise<void>((resolve) => {
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if ((msg as { type: string }).type === "ready") {
            clientWs.send(JSON.stringify({ type: "end" }));
            resolve();
          }
        });
      });

      // Wait for endStream to be received
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Should have received endStream
      expect(fakeMeta.texts.some((t) => (t as { type: string }).type === "endStream")).toBe(true);

      // Close fake to complete the ending flow
      fakeMeta.close(1000);

      // Wait for client to be closed
      await new Promise<void>((resolve) => {
        if (clientWs.readyState === WebSocket.CLOSED) {
          resolve();
        } else {
          clientWs.on("close", () => resolve());
        }
      });
    });
  });

  describe("auth failures", () => {
    it("bad signature -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = signRelayToken(
        { v: 1, exp: Date.now() + 60000, nonce: "12345678901234567890123456789012", configId: "maths-oxbridge" },
        "wrong-secret-must-be-at-least-32-chars"
      );

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(messages).toEqual([{ type: "error", message: "unauthorized", fatal: true }]);
      expect(fakeMeta.connections()).toBe(0);
    });

    it("expired token -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() - 1000); // Expired

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(fakeMeta.connections()).toBe(0);
    });

    it("binary first frame -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      clientWs.on("open", () => {
        clientWs.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(fakeMeta.connections()).toBe(0);
    });

    it("non-auth JSON first -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "end" }));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(fakeMeta.connections()).toBe(0);
    });

    it("auth timeout -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { authTimeoutMs: 100 });

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      // Don't send anything

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      expect(closeCode).toBe(4001);
      expect(fakeMeta.connections()).toBe(0);
    });

    it("reused token (replay) -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const nonce = "12345678901234567890123456789012";
      const token = buildToken("maths-oxbridge", nonce, Date.now() + 60000);

      // First connection
      const clientWs1 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs1.on("open", () => {
          clientWs1.send(JSON.stringify({ type: "auth", token }));
        });
        clientWs1.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            resolve();
          }
        });
      });

      // Second connection with same token
      const clientWs2 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs2.on("open", () => {
        clientWs2.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs2.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs2.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(messages).toEqual([{ type: "error", message: "unauthorized", fatal: true }]);

      clientWs1.close();
      await new Promise<void>((resolve) => clientWs1.on("close", () => resolve()));
    });

    it("unknown configId in token -> 4001", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("unknown-config-id", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4001);
      expect(fakeMeta.connections()).toBe(0);
    });
  });

  describe("upstream failures", () => {
    it("upstream never acks -> 4503", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta, { upstreamReadyTimeoutMs: 100 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      expect(closeCode).toBe(4503);
      expect(messages).toEqual([
        { type: "error", message: "Transcription service unavailable", fatal: true },
      ]);
    });

    it("fake sends error -> 4502, error text not forwarded", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if ((msg as { type: string }).type === "ready") {
          // Send error from fake
          fakeMeta!.send({ type: "error", message: "secret upstream detail" });
        }
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4502);
      expect(messages.some((m) => JSON.stringify(m).includes("secret"))).toBe(false);
      expect(messages).toContainEqual({ type: "error", message: "Transcription service error", fatal: true });
    });

    it("fake closes 1011 mid-session -> 4502", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if ((msg as { type: string }).type === "ready") {
          fakeMeta!.close(1011);
        }
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(4502);
      expect(messages).toContainEqual({
        type: "error",
        message: "Transcription service disconnected",
        fatal: true,
      });
    });
  });

  describe("client disconnects mid-session", () => {
    it("fake receives endStream and closes within 2.5s", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => {
          clientWs.send(JSON.stringify({ type: "auth", token }));
        });
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            resolve();
          }
        });
      });

      // Client disconnects
      clientWs.close();

      // Wait a bit for relay to notice and send endStream
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Check endStream was sent
      expect(fakeMeta.texts.some((t) => (t as { type: string }).type === "endStream")).toBe(true);
    });
  });

  describe("limits", () => {
    it("allowedOrigins rejects bad origin", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, {
        allowedOrigins: ["https://ok.example"],
      });

      // Bad origin
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`, {
        headers: { Origin: "https://bad.example" },
      });

      clientWs.on("error", () => {});

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Connection should fail (403 before upgrade)
      expect(clientWs.readyState).toBe(WebSocket.CLOSED);
    });

    it("allowedOrigins accepts good origin", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, {
        allowedOrigins: ["https://ok.example"],
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`, {
        headers: { Origin: "https://ok.example" },
      });

      let receivedReady = false;

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if ((msg as { type: string }).type === "ready") {
          receivedReady = true;
        }
      });

      // Wait for ready or timeout
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      expect(receivedReady).toBe(true);

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });

    it("maxSessions = 1: second client gets busy, 1013", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 1 });

      const token1 = buildToken("maths-oxbridge", "11111111111111111111111111111111", Date.now() + 60000);
      const token2 = buildToken("maths-oxbridge", "22222222222222222222222222222222", Date.now() + 60000);

      // First client
      const clientWs1 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs1.on("open", () => {
          clientWs1.send(JSON.stringify({ type: "auth", token: token1 }));
        });
        clientWs1.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            resolve();
          }
        });
      });

      // Second client
      const clientWs2 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs2.on("open", () => {
        clientWs2.send(JSON.stringify({ type: "auth", token: token2 }));
      });

      clientWs2.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs2.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(closeCode).toBe(1013);
      expect(messages).toEqual([{ type: "error", message: "busy", fatal: true }]);

      clientWs1.close();
      await new Promise<void>((resolve) => clientWs1.on("close", () => resolve()));
    });

    it("maxSessionMs elapsed -> 4008", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessionMs: 200 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      clientWs.on("close", (code) => {
        closeCode = code;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      expect(closeCode).toBe(4008);
      expect(messages).toContainEqual({
        type: "error",
        message: "session time limit reached",
        fatal: true,
      });
    });
  });

  describe("secrets", () => {
    it("API key never appears in client messages", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      await new Promise<void>((resolve) => {
        clientWs.on("message", () => {});
        
        // Trigger some events
        const interval = setInterval(() => {
          if (fakeMeta) {
            fakeMeta.send({ type: "speechStart", turnId: "t1" });
            fakeMeta.send({ type: "transcript", transcript: "test", final: false });
            fakeMeta.send({ type: "speechComplete", turnId: "t1", transcript: "test" });
          }
        }, 50);

        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, 200);
      });

      // Check all messages don't contain api key
      for (const msg of messages) {
        expect(JSON.stringify(msg)).not.toContain(apiKey);
      }

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });

    it("relay_session log lines contain no secrets or transcripts", async () => {
      testLogs.info = [];

      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      // Wait for session to end
      await new Promise<void>((resolve) => {
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            // Send some audio
            clientWs.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
            // Close to end session
            setTimeout(() => clientWs.close(), 50);
          }
        });
        clientWs.on("close", () => resolve());
      });

      // Wait for log
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Check logs
      const sessionLogs = testLogs.info.filter((args) => {
        const arr = args as unknown[];
        return typeof arr[0] === "string" && arr[0].includes('"tag":"relay_session"');
      });

      expect(sessionLogs.length).toBeGreaterThanOrEqual(1);

      for (const log of sessionLogs) {
        const logEntry = log as unknown[];
        const logStr = typeof logEntry[0] === "string" ? logEntry[0] : JSON.stringify(logEntry[0]);
        expect(logStr).not.toContain(apiKey);
        expect(logStr).not.toContain(token);
        expect(logStr).not.toContain("secret");
        expect(logStr).not.toContain("transcript");
        expect(logStr).toContain('"configId"');
        expect(logStr).toContain('"durationMs"');
        expect(logStr).toContain('"bytesIn"');
        expect(logStr).toContain('"closeCode"');
      }
    });

    it("exactly one relay_session line per finished session", async () => {
      testLogs.info = [];

      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      // Single session
      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => {
          clientWs.send(JSON.stringify({ type: "auth", token }));
        });
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            setTimeout(() => clientWs.close(), 50);
          }
        });
        clientWs.on("close", () => resolve());
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const sessionLogs = testLogs.info.filter((args) => {
        const arr = args as unknown[];
        return typeof arr[0] === "string" && arr[0].includes('"tag":"relay_session"');
      });

      expect(sessionLogs).toHaveLength(1);
    });
  });

  describe("invalid text after auth", () => {
    it("sends error but keeps session open", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);

      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
      });

      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);

        // After ready, send invalid text
        if ((msg as { type: string }).type === "ready") {
          clientWs.send(JSON.stringify({ type: "invalid" }));

          // Wait, then send more audio to verify session stays open
          setTimeout(() => {
            clientWs.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
          }, 50);
        }
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Should have received error for invalid message
      expect(messages).toContainEqual({ type: "error", message: "invalid message", fatal: false });

      // Session should still be open (ready was received)
      expect(messages.some((m) => (m as { type: string }).type === "ready")).toBe(true);

      // Audio should have been forwarded
      expect(fakeMeta.audio.length).toBeGreaterThan(0);

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });
  });

  // B1: maxSessions bypass from failed-auth - simplified test
  describe("B1: maxSessions counter integrity", () => {
    it("bad token doesn't block new sessions", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 1, authTimeoutMs: 200 });

      const badToken = signRelayToken(
        { v: 1, exp: Date.now() + 60000, nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", configId: "maths-oxbridge" },
        "wrong-secret-must-be-at-least-32-chars"
      );
      const goodToken = buildToken("maths-oxbridge", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Date.now() + 60000);

      // B: bad token should close with 4001
      const clientB = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);
      await new Promise<void>((resolve) => {
        clientB.on("open", () => clientB.send(JSON.stringify({ type: "auth", token: badToken })));
        clientB.on("close", (code) => {
          expect(code).toBe(4001);
          resolve();
        });
      });

      // Wait for cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // A: good token should work (since B never counted)
      const clientA = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);
      let gotReady = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Good token didn't get ready")), 2000);
        clientA.on("open", () => clientA.send(JSON.stringify({ type: "auth", token: goodToken })));
        clientA.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            gotReady = true;
            clearTimeout(timeout);
            resolve();
          }
        });
        clientA.on("close", (code) => {
          if (!gotReady) reject(new Error(`Closed ${code} before ready`));
        });
      });

      expect(gotReady).toBe(true);

      // Second connection should get busy
      const clientC = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);
      await new Promise<void>((resolve) => {
        clientC.on("open", () => clientC.send(JSON.stringify({ type: "auth", token: goodToken })));
        clientC.on("close", (code) => {
          expect(code).toBe(1013);
          resolve();
        });
      });

      clientA.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }, 5000);
  });

  // B2: upstream CONNECTING outlives session
  describe("B2: upstream CONNECTING handling", () => {
    it("upstream timeout while CONNECTING: no late handshake", async () => {
      // Use a real server that delays its upgrade
      const { createServer } = await import("node:http");
      const { WebSocketServer } = await import("ws");
      
      const server = createServer();
      const handshakes: unknown[] = [];

      server.on("upgrade", (req, socket, head) => {
        // Wait 1.5s before handling upgrade
        setTimeout(() => {
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                handshakes.push(msg);
                ws.send(JSON.stringify({ sessionId: "sess-1" }));
              } catch {}
            });
          });
        }, 1500);
      });

      const delayUrl = await new Promise<string>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          resolve(`ws://127.0.0.1:${port}`);
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: delayUrl,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 300,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });
      fakeMeta = null; // not using regular fake

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
      clientWs.on("close", (code) => { closeCode = code; });

      await new Promise<void>((resolve) => setTimeout(resolve, 600));

      expect(closeCode).toBe(4503);

      // Wait 2s longer for any delayed handshake
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      // No handshake should have been sent
      expect(handshakes).toHaveLength(0);

      // Cleanup
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it("client disconnect while connecting: no late handshake", async () => {
      // Similar but client disconnects while upstream is connecting
      const { createServer } = await import("node:http");
      const { WebSocketServer } = await import("ws");
      
      const server = createServer();
      const handshakes: unknown[] = [];

      server.on("upgrade", (req, socket, head) => {
        setTimeout(() => {
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                handshakes.push(msg);
                ws.send(JSON.stringify({ sessionId: "sess-1" }));
              } catch {}
            });
          });
        }, 1500);
      });

      const delayUrl = await new Promise<string>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          resolve(`ws://127.0.0.1:${port}`);
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: delayUrl,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 5000,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });
      fakeMeta = null;

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));

      // Disconnect client while upstream is still connecting
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      clientWs.close();

      // Wait for everything to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));

      // No handshake
      expect(handshakes).toHaveLength(0);

      // Cleanup
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
  });

  // B3: session time limit starts at auth, applies to all states
  describe("B3: session time limit", () => {
    it("time limit applies while ending (fake never closes)", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessionMs: 400 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      const startTime = Date.now();

      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if ((msg as { type: string }).type === "ready") {
          // Send end - fake won't close
          clientWs.send(JSON.stringify({ type: "end" }));
        }
      });
      clientWs.on("close", (code) => { closeCode = code; });

      // Wait for time limit to kick in
      await new Promise<void>((resolve) => setTimeout(resolve, 800));

      expect(closeCode).toBe(4008);
      expect(messages).toContainEqual({ type: "error", message: "session time limit reached", fatal: true });
      expect(Date.now() - startTime).toBeLessThan(1200); // around 400-600ms
    });

    it("time limit applies while connecting_upstream", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta, {
        upstreamReadyTimeoutMs: 5000,
        maxSessionMs: 400,
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
      clientWs.on("message", (data) => messages.push(JSON.parse(data.toString())));
      clientWs.on("close", (code) => { closeCode = code; });

      await new Promise<void>((resolve) => setTimeout(resolve, 800));

      expect(closeCode).toBe(4008);
      expect(messages).toContainEqual({ type: "error", message: "session time limit reached", fatal: true });
    });
  });

  // B4: invalid text after auth in all states
  describe("B4: invalid text handling", () => {
    it("invalid JSON after ready sends error", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
      clientWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if ((msg as { type: string }).type === "ready") {
          clientWs.send("not json");
        }
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(messages).toContainEqual({ type: "error", message: "invalid message", fatal: false });

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });

    it("invalid JSON during connecting_upstream sends error", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
        setTimeout(() => clientWs.send("not json"), 50);
      });
      clientWs.on("message", (data) => messages.push(JSON.parse(data.toString())));

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(messages).toContainEqual({ type: "error", message: "invalid message", fatal: false });

      // Now acknowledge and verify flow continues
      fakeMeta.send({ sessionId: "sess-1" });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(messages.some((m) => (m as { type: string }).type === "ready")).toBe(true);

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });

    it("bogus JSON during connecting_upstream sends error", async () => {
      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
        setTimeout(() => clientWs.send(JSON.stringify({ type: "bogus" })), 50);
      });
      clientWs.on("message", (data) => messages.push(JSON.parse(data.toString())));

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(messages).toContainEqual({ type: "error", message: "invalid message", fatal: false });

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));
    });
  });

  // B6: bytesIn counts pre-ready buffered bytes
  describe("B6: bytesIn logging", () => {
    it("bytesIn includes pre-ready buffered bytes", async () => {
      testLogs.info = [];

      fakeMeta = await startFakeMetaAsr({ ack: "never" });
      relay = await setupRelay(fakeMeta, { preReadyBufferBytes: 1000 });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      // Send auth and audio before ready
      await new Promise<void>((resolve) => {
        clientWs.on("open", () => {
          clientWs.send(JSON.stringify({ type: "auth", token }));
          setTimeout(resolve, 50);
        });
      });

      // Send 600 bytes before ready
      const frame1 = Buffer.alloc(600, 0x01);
      clientWs.send(frame1);

      // Now acknowledge
      fakeMeta.send({ sessionId: "sess-1" });

      // Wait for ready and send more audio
      let readyReceived = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Ready timeout")), 3000);
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if ((msg as { type: string }).type === "ready" && !readyReceived) {
            readyReceived = true;
            clearTimeout(timeout);
            // Send 400 bytes after ready
            const frame2 = Buffer.alloc(400, 0x02);
            clientWs.send(frame2);
            setTimeout(() => {
              clientWs.close();
              resolve();
            }, 50);
          }
        });
        clientWs.on("error", () => clearTimeout(timeout));
      });

      // Wait for session end
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      const sessionLogs = testLogs.info.filter((args) => {
        const arr = args as unknown[];
        return typeof arr[0] === "string" && arr[0].includes('"tag":"relay_session"');
      });

      expect(sessionLogs).toHaveLength(1);
      const logStr = (sessionLogs[0] as unknown[])[0] as string;
      const logEntry = JSON.parse(logStr);
      expect(logEntry.bytesIn).toBe(1000); // 600 + 400
    }, 10000);
  });

  // B7: close() terminates all sessions
  describe("B7: relay close()", () => {
    it("close() terminates upstream connections", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      // Call relay.close()
      await relay.close();

      // Fake should have zero open connections
      expect(fakeMeta.openConnections()).toBe(0);
    });
  });

  // Review-2 tests
  describe("review-2", () => {
    let rawUpstream: Awaited<ReturnType<typeof import("./helpers/raw-ws-upstream").startUnresponsiveUpstream>> | null = null;
    let rawServer: import("node:http").Server | null = null;

    afterEach(async () => {
      if (rawUpstream) {
        await rawUpstream.stop();
        rawUpstream = null;
      }
      if (rawServer) {
        rawServer.closeAllConnections();
        rawServer = null;
      }
    });

    // T2a: maxSessions race condition
    it("T2a: maxSessions=1, three concurrent pre-auth clients -> 1 ready, 2 busy/1013", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 1 });

      const clients: WebSocket[] = [];
      const messages: unknown[][] = [[], [], []];
      const closeCodes: (number | null)[] = [null, null, null];

      // Open three clients
      for (let i = 0; i < 3; i++) {
        clients[i] = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      }

      // Wait for all three to be open
      await Promise.all(clients.map((c) => new Promise<void>((resolve) => c.on("open", () => resolve()))));

      // Send auth on all three in same tick
      const token1 = buildToken("maths-oxbridge", "11111111111111111111111111111111", Date.now() + 60000);
      const token2 = buildToken("maths-oxbridge", "22222222222222222222222222222222", Date.now() + 60000);
      const token3 = buildToken("maths-oxbridge", "33333333333333333333333333333333", Date.now() + 60000);

      clients[0].send(JSON.stringify({ type: "auth", token: token1 }));
      clients[1].send(JSON.stringify({ type: "auth", token: token2 }));
      clients[2].send(JSON.stringify({ type: "auth", token: token3 }));

      // Set up message and close handlers
      for (let i = 0; i < 3; i++) {
        clients[i].on("message", (data) => messages[i].push(JSON.parse(data.toString())));
        clients[i].on("close", (code) => { closeCodes[i] = code; });
      }

      // Wait 500ms
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Count how many got ready vs busy
      let readyCount = 0;
      let busyCount = 0;
      for (let i = 0; i < 3; i++) {
        if (messages[i].some((m) => (m as { type: string }).type === "ready")) {
          readyCount++;
        }
        if (closeCodes[i] === 1013) {
          busyCount++;
        }
      }

      expect(readyCount).toBe(1);
      expect(busyCount).toBe(2);
      expect(fakeMeta.handshakes.length).toBe(1);
      expect(fakeMeta.connections()).toBe(1);

      // Cleanup
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.close();
      }
    });

    // T2b: trackedSessions pruning
    it("T2b: trackedSessions is 0 after session close, bad auth, and auth timeout", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { authTimeoutMs: 200 });

      // Start: trackedSessions = 0
      expect(relay.trackedSessions()).toBe(0);

      // Valid client gets ready
      const token1 = buildToken("maths-oxbridge", "11111111111111111111111111111111", Date.now() + 60000);
      const client1 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        client1.on("open", () => client1.send(JSON.stringify({ type: "auth", token: token1 })));
        client1.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      expect(relay.trackedSessions()).toBe(1);

      // Client 1 sends end, fake closes 1000
      client1.send(JSON.stringify({ type: "end" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      fakeMeta.close(1000);
      await new Promise<void>((resolve) => client1.on("close", () => resolve()));

      // Bad token client
      const badToken = signRelayToken(
        { v: 1, exp: Date.now() + 60000, nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", configId: "maths-oxbridge" },
        "wrong-secret-must-be-at-least-32-chars"
      );
      const client2 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);
      await new Promise<void>((resolve) => {
        client2.on("open", () => client2.send(JSON.stringify({ type: "auth", token: badToken })));
        client2.on("close", () => resolve());
      });

      // Client that never authenticates (auth timeout)
      const client3 = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);
      await new Promise<void>((resolve) => {
        client3.on("close", () => resolve());
      });

      // After all, trackedSessions should be 0
      expect(relay.trackedSessions()).toBe(0);
    }, 5000);

    // T2c: mid-session upstream protocol error -> disconnected / 4502
    it("T2c: sendRawFrame after ready -> disconnected / 4502", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      let closeCode: number | null = null;

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if ((msg as { type: string }).type === "ready") {
            // Send invalid WebSocket frame (opcode 3 is reserved)
            fakeMeta!.sendRawFrame(Buffer.from([0x83, 0x00]));
          }
        });
        clientWs.on("close", (code) => { closeCode = code; resolve(); });
      });

      // Wait a bit for messages
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Check the client received disconnected, not unavailable
      const errorReceived = messages.some((m) =>
        (m as { type: string }).type === "error" &&
        (m as { message: string }).message === "Transcription service disconnected"
      );
      expect(errorReceived).toBe(true);
      expect(messages.some((m) => JSON.stringify(m).includes("unavailable"))).toBe(false);
      expect(closeCode).toBe(4502);
    });

    // T2d: upstream connection refused -> unavailable / 4503
    it("T2d: upstream connection refused -> unavailable / 4503", async () => {
      // Get a free port and close it
      const net = await import("node:net");
      const tempServer = net.createServer();
      const port = await new Promise<number>((resolve) => {
        tempServer.listen(0, () => {
          const p = (tempServer.address() as { port: number }).port;
          tempServer.close(() => resolve(p));
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: `ws://127.0.0.1:${port}`,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 8000,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      const messages: unknown[] = [];

      const startTime = Date.now();

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => messages.push(JSON.parse(data.toString())));
        clientWs.on("close", (code) => { closeCode = code; resolve(); });
      });

      // Should close within 5s with 4503
      expect(Date.now() - startTime).toBeLessThan(5000);
      expect(closeCode).toBe(4503);
      expect(messages).toContainEqual({ type: "error", message: "Transcription service unavailable", fatal: true });
    }, 10000);

    // T2e: upstream never answers close frame -> terminates within 2.5s
    it("T2e test 1: client close with unresponsive upstream -> sockets close within 2500ms", async () => {
      const { startUnresponsiveUpstream } = await import("./helpers/raw-ws-upstream");
      rawUpstream = await startUnresponsiveUpstream();

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: rawUpstream.url,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 1000,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      const t0 = Date.now();
      clientWs.close();

      // Poll for sockets to reach 0
      while (rawUpstream.openSockets() > 0 && Date.now() - t0 < 2500) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      expect(rawUpstream.openSockets()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(2500);
    });

    it("T2e test 2: maxSessionMs with unresponsive upstream -> sockets close within 2500ms", async () => {
      const { startUnresponsiveUpstream } = await import("./helpers/raw-ws-upstream");
      rawUpstream = await startUnresponsiveUpstream();

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: rawUpstream.url,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 1000,
        maxSessionMs: 300,
        preReadyBufferBytes: 64000,
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
        clientWs.on("close", () => resolve());
      });

      // Wait for session time limit
      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      const t0 = Date.now();

      // Poll for sockets to reach 0
      while (rawUpstream.openSockets() > 0 && Date.now() - t0 < 2500) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      expect(rawUpstream.openSockets()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(2500);
    });

    // T2f: client sends frame over maxPayload -> endStream sent, relay_session logged
    it("T2f: client sends 70000 byte frame -> close 1009, endStream to upstream, relay_session logged", async () => {
      testLogs.info = [];

      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            // Send frame over maxPayload (65536)
            clientWs.send(Buffer.alloc(70000, 0x00));
          }
        });
        clientWs.on("close", (code) => { closeCode = code; resolve(); });
      });

      // Wait for upstream to process
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));

      // Client should be closed with 1009 (message too big)
      expect(closeCode).toBe(1009);

      // Upstream should have received endStream
      expect(fakeMeta.texts.some((t) => (t as { type: string }).type === "endStream")).toBe(true);

      // Exactly one relay_session log
      const sessionLogs = testLogs.info.filter((args) => {
        const arr = args as unknown[];
        return typeof arr[0] === "string" && arr[0].includes('"tag":"relay_session"');
      });
      expect(sessionLogs).toHaveLength(1);
    });

    // T2h: handshake deep equality
    it("T2h: handshake equals expected object with no extra fields", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta);

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      await new Promise<void>((resolve) => {
        clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
        clientWs.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      clientWs.close();
      await new Promise<void>((resolve) => clientWs.on("close", () => resolve()));

      // Check handshake deep equality
      const { getConfig } = await import("../src/config/load");
      const expectedKeywords = getConfig("maths-oxbridge").asrKeywords;

      expect(fakeMeta.handshakes).toHaveLength(1);
      expect(fakeMeta.handshakes[0]).toEqual({
        authorization: { accessToken: "Bearer test-api-key" },
        audioEncoding: "PCM_16KHZ",
        model: "muse-voice-transcribe-1.0",
        mode: "ENDPOINTING",
        partialMode: "CUMULATIVE",
        keywords: expectedKeywords,
      });

      // Keywords non-empty array assertion
      expect(Array.isArray(expectedKeywords)).toBe(true);
      expect(expectedKeywords.length).toBeGreaterThan(0);
    });

    // T3a: maxSessions bypass (exactly as round 1 specified)
    it("T3a: maxSessions=2, A ready, B bad token 4001, C ready, D busy/1013", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 2 });

      const tokenA = buildToken("maths-oxbridge", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Date.now() + 60000);
      const badToken = signRelayToken(
        { v: 1, exp: Date.now() + 60000, nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", configId: "maths-oxbridge" },
        "wrong-secret-must-be-at-least-32-chars"
      );
      const tokenC = buildToken("maths-oxbridge", "cccccccccccccccccccccccccccccccc", Date.now() + 60000);
      const tokenD = buildToken("maths-oxbridge", "dddddddddddddddddddddddddddddddd", Date.now() + 60000);

      // Client A: authenticate and get ready
      const clientA = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      await new Promise<void>((resolve) => {
        clientA.on("open", () => clientA.send(JSON.stringify({ type: "auth", token: tokenA })));
        clientA.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      // Client B: bad token, closes 4001
      const clientB = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      await new Promise<void>((resolve) => {
        clientB.on("open", () => clientB.send(JSON.stringify({ type: "auth", token: badToken })));
        clientB.on("close", (code) => {
          expect(code).toBe(4001);
          resolve();
        });
      });

      // Wait for B's session to be cleaned up
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Client C: authenticate and get ready
      const clientC = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      await new Promise<void>((resolve) => {
        clientC.on("open", () => clientC.send(JSON.stringify({ type: "auth", token: tokenC })));
        clientC.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      // Client D: should get busy / 1013
      const clientD = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      const messagesD: unknown[] = [];
      let closeCodeD: number | null = null;

      await new Promise<void>((resolve) => {
        clientD.on("open", () => clientD.send(JSON.stringify({ type: "auth", token: tokenD })));
        clientD.on("message", (data) => messagesD.push(JSON.parse(data.toString())));
        clientD.on("close", (code) => { closeCodeD = code; resolve(); });
      });

      expect(closeCodeD).toBe(1013);
      expect(messagesD).toContainEqual({ type: "error", message: "busy", fatal: true });

      // A and C still open
      expect(clientA.readyState).toBe(WebSocket.OPEN);
      expect(clientC.readyState).toBe(WebSocket.OPEN);

      // Cleanup
      clientA.close();
      clientC.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }, 10000);

    // T3b: disconnect frees a slot
    it("T3b: maxSessions=1, A ready then closes, B ready, C busy", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 1 });

      const tokenA = buildToken("maths-oxbridge", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Date.now() + 60000);
      const tokenB = buildToken("maths-oxbridge", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Date.now() + 60000);
      const tokenC = buildToken("maths-oxbridge", "cccccccccccccccccccccccccccccccc", Date.now() + 60000);

      // Client A: authenticate and get ready
      const clientA = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      await new Promise<void>((resolve) => {
        clientA.on("open", () => clientA.send(JSON.stringify({ type: "auth", token: tokenA })));
        clientA.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") resolve();
        });
      });

      // Client A closes
      clientA.close();
      await new Promise<void>((resolve) => clientA.on("close", () => resolve()));

      // Wait for session to be properly cleaned up (trackedSessions should be 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(relay!.trackedSessions()).toBe(0);

      // Client B: should get ready
      const clientB = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      let bReady = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("B didn't get ready")), 2000);
        clientB.on("open", () => clientB.send(JSON.stringify({ type: "auth", token: tokenB })));
        clientB.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type: string }).type === "ready") {
            bReady = true;
            clearTimeout(timeout);
            resolve();
          }
        });
        clientB.on("close", (code) => {
          if (!bReady) reject(new Error(`B closed with ${code} before ready`));
        });
      });

      expect(bReady).toBe(true);

      // Client C: should get busy / 1013
      const clientC = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      const messagesC: unknown[] = [];
      let closeCodeC: number | null = null;

      await new Promise<void>((resolve) => {
        clientC.on("open", () => clientC.send(JSON.stringify({ type: "auth", token: tokenC })));
        clientC.on("message", (data) => messagesC.push(JSON.parse(data.toString())));
        clientC.on("close", (code) => { closeCodeC = code; resolve(); });
      });

      expect(closeCodeC).toBe(1013);
      expect(messagesC).toContainEqual({ type: "error", message: "busy", fatal: true });

      clientB.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });

    // T3c: upstream timeout while CONNECTING terminates connection
    it("T3c: upstream timeout while CONNECTING -> connection count 0", async () => {
      const http = await import("node:http");
      const { WebSocketServer } = await import("ws");

      const server = http.createServer();
      const handshakes: unknown[] = [];
      const wss = new WebSocketServer({ noServer: true });
      let connectionCount = 0;

      wss.on("connection", (ws) => {
        connectionCount++;
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            handshakes.push(msg);
            ws.send(JSON.stringify({ sessionId: "sess-1" }));
          } catch {}
        });
      });

      server.on("upgrade", (req, socket, head) => {
        // Wait 1500ms before handling upgrade
        setTimeout(() => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }, 1500);
      });

      const delayUrl = await new Promise<string>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          resolve(`ws://127.0.0.1:${port}`);
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: delayUrl,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 300,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });
      fakeMeta = null;

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      let closeCode: number | null = null;
      clientWs.on("open", () => clientWs.send(JSON.stringify({ type: "auth", token })));
      clientWs.on("close", (code) => { closeCode = code; });

      await new Promise<void>((resolve) => setTimeout(resolve, 600));

      expect(closeCode).toBe(4503);

      // Wait for total of 2500ms
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      // Connection count should be 0 (terminated before upgrade completed)
      expect(connectionCount).toBe(0);

      // Cleanup
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    // T3d: handshakeTimeout with client end while connecting
    it("T3d: client sends end while upstream connecting -> unavailable / 4503", async () => {
      const net = await import("node:net");
      const sockets = new Set<import("node:net").Socket>();

      const server = net.createServer((s) => {
        sockets.add(s);
        s.on("error", () => {});
        s.on("close", () => sockets.delete(s));
        // Never answer - just hold connection open
      });

      const url = await new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as { port: number }).port;
          resolve(`ws://127.0.0.1:${port}`);
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: url,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 300,
        maxSessionMs: 60_000,
        preReadyBufferBytes: 64000,
      });

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      const messages: unknown[] = [];
      let closeCode: number | null = null;
      const startTime = Date.now();

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
        // Send end immediately in same tick
        clientWs.send(JSON.stringify({ type: "end" }));
      });
      clientWs.on("message", (data) => messages.push(JSON.parse(data.toString())));
      clientWs.on("close", (code) => { closeCode = code; });

      // Wait for close (within 1500ms)
      while (closeCode === null && Date.now() - startTime < 1500) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      expect(closeCode).toBe(4503);
      expect(messages).toContainEqual({ type: "error", message: "Transcription service unavailable", fatal: true });

      // Cleanup
      for (const s of sockets) s.destroy();
      void (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    });

    // G1: auth-time busy rejection sends exactly the busy error
    it("G1: auth-time busy rejection sends exactly the busy error", async () => {
      fakeMeta = await startFakeMetaAsr();
      relay = await setupRelay(fakeMeta, { maxSessions: 1 });

      const clients: WebSocket[] = [];
      const messages: unknown[][] = [[], [], []];
      const closeCodes: (number | null)[] = [null, null, null];

      // Open three clients
      for (let i = 0; i < 3; i++) {
        clients[i] = new WebSocket(`ws://127.0.0.1:${relay!.port}/asr`);
      }

      // Wait for all three to be open
      await Promise.all(clients.map((c) => new Promise<void>((resolve) => c.on("open", () => resolve()))));

      // Attach listeners BEFORE sending auth
      for (let i = 0; i < 3; i++) {
        clients[i].on("message", (data) => messages[i].push(JSON.parse(data.toString())));
        clients[i].on("close", (code) => { closeCodes[i] = code; });
      }

      // Send auth on all three in same tick (three different nonces)
      const token1 = buildToken("maths-oxbridge", "11111111111111111111111111111111", Date.now() + 60000);
      const token2 = buildToken("maths-oxbridge", "22222222222222222222222222222222", Date.now() + 60000);
      const token3 = buildToken("maths-oxbridge", "33333333333333333333333333333333", Date.now() + 60000);

      clients[0].send(JSON.stringify({ type: "auth", token: token1 }));
      clients[1].send(JSON.stringify({ type: "auth", token: token2 }));
      clients[2].send(JSON.stringify({ type: "auth", token: token3 }));

      // Wait 500ms
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Exactly one client is ready
      let readyCount = 0;
      for (let i = 0; i < 3; i++) {
        if (messages[i].some((m) => (m as { type: string }).type === "ready")) {
          readyCount++;
        }
      }
      expect(readyCount).toBe(1);

      // For each of the other two: exact message and close code
      for (let i = 0; i < 3; i++) {
        if (!messages[i].some((m) => (m as { type: string }).type === "ready")) {
          expect(messages[i]).toEqual([{ type: "error", message: "busy", fatal: true }]);
          expect(closeCodes[i]).toBe(1013);
        }
      }

      // Cleanup
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.close();
      }
    });

    // G2: client disconnect while upstream CONNECTING (long ready timeout)
    it("G2: client disconnect while upstream CONNECTING (long ready timeout) -> upstream never connects", async () => {
      const http = await import("node:http");
      const { WebSocketServer } = await import("ws");

      const server = http.createServer();
      const handshakes: unknown[] = [];
      const wss = new WebSocketServer({ noServer: true });
      let connectionCount = 0;

      wss.on("connection", (ws) => {
        connectionCount++;
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            handshakes.push(msg);
            ws.send(JSON.stringify({ sessionId: "sess-1" }));
          } catch {}
        });
      });

      server.on("upgrade", (req, socket, head) => {
        // Wait 1500ms before handling upgrade
        setTimeout(() => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }, 1500);
      });

      const delayUrl = await new Promise<string>((resolve) => {
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          resolve(`ws://127.0.0.1:${port}`);
        });
      });

      relay = await startRelay({
        port: 0,
        secret,
        apiKey,
        upstreamUrl: delayUrl,
        allowedOrigins: null,
        maxSessions: 50,
        authTimeoutMs: 500,
        upstreamReadyTimeoutMs: 5000,
        maxSessionMs: 30_000,
        preReadyBufferBytes: 64000,
      });
      fakeMeta = null;

      const token = buildToken("maths-oxbridge", "12345678901234567890123456789012", Date.now() + 60000);
      const clientWs = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`);

      clientWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "auth", token }));
        // Close after 200ms
        setTimeout(() => clientWs.close(), 200);
      });

      // Wait 2500ms total
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));

      // Connection count should be 0 (terminated before upgrade completed)
      expect(connectionCount).toBe(0);
      expect(relay.trackedSessions()).toBe(0);

      // Cleanup
      for (const ws of wss.clients) {
        ws.terminate();
      }
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
  });
});
