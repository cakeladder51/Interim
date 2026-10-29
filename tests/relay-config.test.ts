import { describe, it, expect } from "vitest";
import { loadRelayEnv } from "../relay/src/config";

describe("relay-config", () => {
  describe("requires variables", () => {
    it("missing RELAY_SECRET -> error naming variable", () => {
      const result = loadRelayEnv({ MODEL_API_KEY: "test-key" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain("RELAY_SECRET is missing");
        // Error should not contain values from other vars
        for (const err of result.errors) {
          expect(err).not.toContain("test-key");
        }
      }
    });

    it("RELAY_SECRET too short (31 chars) -> error", () => {
      const shortSecret = "a".repeat(31);
      const result = loadRelayEnv({
        RELAY_SECRET: shortSecret,
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain("RELAY_SECRET");
        expect(result.errors[0]).toContain("too short");
        // Error should not contain the actual value
        expect(result.errors[0]).not.toContain(shortSecret);
      }
    });

    it("missing MODEL_API_KEY -> error naming variable", () => {
      const result = loadRelayEnv({ RELAY_SECRET: "a".repeat(32) });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain("MODEL_API_KEY is missing");
        // Error should not contain values
        for (const err of result.errors) {
          expect(err).not.toContain("test-key");
        }
      }
    });

    it("both missing -> both errors", () => {
      const result = loadRelayEnv({});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toHaveLength(2);
        expect(result.errors).toContain("RELAY_SECRET is missing");
        expect(result.errors).toContain("MODEL_API_KEY is missing");
      }
    });
  });

  describe("defaults", () => {
    it("PORT defaults to 8080", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.port).toBe(8080);
      }
    });

    it("PORT respects env value", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "9000",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.port).toBe(9000);
      }
    });

    it("PORT invalid (abc) -> error", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("PORT") && e.includes("integer"))).toBe(true);
        // Error should not contain the value
        expect(result.errors.some((e) => e.includes("abc"))).toBe(false);
      }
    });

    it("PORT out of range (70000) -> error", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "70000",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("PORT") && e.includes("integer"))).toBe(true);
        // Error should not contain the value
        expect(result.errors.some((e) => e.includes("70000"))).toBe(false);
      }
    });

    it("ASR_UPSTREAM_URL defaults to Meta API", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.upstreamUrl).toBe("wss://api.meta.ai/v1/asr/realtime");
      }
    });

    it("RELAY_ALLOWED_ORIGINS empty -> null", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_ALLOWED_ORIGINS: "",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.allowedOrigins).toBeNull();
      }
    });

    it("RELAY_MAX_SESSIONS defaults to 50", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });

    it("authTimeoutMs defaults to 5000", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.authTimeoutMs).toBe(5000);
      }
    });

    it("upstreamReadyTimeoutMs defaults to 10000", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.upstreamReadyTimeoutMs).toBe(10000);
      }
    });

    it("maxSessionMs defaults to 1.8M ms (30 min)", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessionMs).toBe(1_800_000);
      }
    });

    it("preReadyBufferBytes defaults to 64000", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.preReadyBufferBytes).toBe(64000);
      }
    });
  });

  describe("origin list parsing", () => {
    it("comma-separated origins are trimmed", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_ALLOWED_ORIGINS: " https://a.com , https://b.com ",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
      }
    });

    it("empty origins list -> null", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_ALLOWED_ORIGINS: "  ,  ",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.allowedOrigins).toBeNull();
      }
    });

    it("single origin works", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_ALLOWED_ORIGINS: "https://example.com",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.allowedOrigins).toEqual(["https://example.com"]);
      }
    });
  });

  describe("RELAY_MAX_SESSIONS validation", () => {
    it("positive int works", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "100",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(100);
      }
    });

    it("zero -> default", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "0",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });

    it("negative -> default", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "-5",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });

    it("non-numeric -> default", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "abc",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });

    // T2g: B6 validation for PORT and RELAY_MAX_SESSIONS
    it("T2g: PORT '12abc' -> error", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "12abc",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("PORT") && e.includes("integer"))).toBe(true);
        expect(result.errors.some((e) => e.includes("12abc"))).toBe(false);
      }
    });

    it("T2g: PORT '1.5' -> error", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "1.5",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("PORT") && e.includes("integer"))).toBe(true);
        expect(result.errors.some((e) => e.includes("1.5"))).toBe(false);
      }
    });

    it("T2g: PORT '0' -> port 0", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "0",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.port).toBe(0);
      }
    });

    it("T2g: PORT '65535' -> port 65535", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        PORT: "65535",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.port).toBe(65535);
      }
    });

    it("T2g: RELAY_MAX_SESSIONS '5abc' -> default 50", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "5abc",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });

    it("T2g: RELAY_MAX_SESSIONS '1.5' -> default 50", () => {
      const result = loadRelayEnv({
        RELAY_SECRET: "a".repeat(32),
        MODEL_API_KEY: "test-key",
        RELAY_MAX_SESSIONS: "1.5",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.opts.maxSessions).toBe(50);
      }
    });
  });
});
