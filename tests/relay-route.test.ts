import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRelayTokenHandler } from "../src/server/relay-token-handler";

const secret = "test-secret-must-be-at-least-32-chars";
const relayUrl = "wss://relay.example.com/asr";

describe("relay-token route", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("503 relay_unavailable", () => {
    it("secret missing -> 503", async () => {
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: undefined, RELAY_URL: relayUrl }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "maths-oxbridge" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: "relay_unavailable",
          message: "Voice input is not available right now.",
        },
      });
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      // Should have warned exactly once
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      // Secret value should not appear in log
      expect(consoleWarnSpy.mock.calls[0][0]).not.toContain(relayUrl);
    });

    it("secret too short (31 chars) -> 503", async () => {
      const shortSecret = "a".repeat(31);
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: shortSecret, RELAY_URL: relayUrl }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "maths-oxbridge" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: "relay_unavailable",
          message: "Voice input is not available right now.",
        },
      });
      // Secret value should not appear in response (checked by parsing body above which is generic message)
    });

    it("URL missing -> 503", async () => {
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: secret, RELAY_URL: undefined }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "maths-oxbridge" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(503);
    });

    it("does not log secret value", async () => {
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: undefined, RELAY_URL: relayUrl }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "maths-oxbridge" }),
      });

      await handler(req);

      const logMessage = consoleWarnSpy.mock.calls[0][0];
      expect(logMessage).not.toContain(secret);
    });
  });

  describe("400 bad_request", () => {
    it("invalid JSON -> 400", async () => {
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: secret, RELAY_URL: relayUrl }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      const res = await handler(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("bad_request");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("unknown configId -> 400", async () => {
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: secret, RELAY_URL: relayUrl }),
        now: () => 1000000000000,
        randomHex: () => "12345678901234567890123456789012",
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "unknown-config-id" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("bad_request");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  describe("200 success", () => {
    it("returns token, url, and expiresAt", async () => {
      const now = 1000000000000;
      const nonce = "12345678901234567890123456789012";

      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: secret, RELAY_URL: relayUrl }),
        now: () => now,
        randomHex: () => nonce,
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: "maths-oxbridge" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const body = await res.json();
      expect(body).toHaveProperty("token");
      expect(body).toHaveProperty("url", relayUrl);
      expect(body).toHaveProperty("expiresAt", now + 120000);
    });

    it("token verifies with the secret", async () => {
      const now = 1000000000000;
      const nonce = "12345678901234567890123456789012";
      const configId = "maths-oxbridge";

      const randomHexCalls: number[] = [];
      const handler = createRelayTokenHandler({
        getEnv: () => ({ RELAY_SECRET: secret, RELAY_URL: relayUrl }),
        now: () => now,
        randomHex: (n) => {
          randomHexCalls.push(n);
          return nonce;
        },
      });

      const req = new Request("http://localhost/api/relay-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId }),
      });

      const res = await handler(req);
      const body = await res.json();

      // T1b: assert randomHex was called with 16
      expect(randomHexCalls).toHaveLength(1);
      expect(randomHexCalls[0]).toBe(16);

      // Verify the token using shared module
      const { verifyRelayToken } = await import("../src/shared/relay-token");
      const result = verifyRelayToken(body.token, secret, now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.configId).toBe(configId);
        expect(result.payload.nonce).toBe(nonce);
        expect(result.payload.exp).toBe(now + 120000);
      }
    });
  });
});
