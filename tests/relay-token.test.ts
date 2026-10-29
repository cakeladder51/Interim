import { describe, it, expect } from "vitest";
import { signRelayToken, verifyRelayToken, RELAY_TOKEN_TTL_MS, type RelayTokenPayload } from "../src/shared/relay-token";
import { createHmac } from "node:crypto";

const secret = "test-secret-must-be-at-least-32-chars";
const startTime = 1000000000000;

function base64urlEncode(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("relay-token", () => {
  describe("signRelayToken", () => {
    it("creates a token with the correct format", () => {
      const payload: RelayTokenPayload = {
        v: 1,
        exp: startTime + RELAY_TOKEN_TTL_MS,
        nonce: "12345678901234567890123456789012",
        configId: "maths-oxbridge",
      };

      const token = signRelayToken(payload, secret);

      // Should have exactly one dot
      expect(token.split(".")).toHaveLength(2);

      const [payloadPart, sigPart] = token.split(".");
      expect(payloadPart.length).toBeGreaterThan(0);
      expect(sigPart.length).toBeGreaterThan(0);
    });

    it("signature is HMAC-SHA256 over payload part", () => {
      const payload: RelayTokenPayload = {
        v: 1,
        exp: startTime + RELAY_TOKEN_TTL_MS,
        nonce: "12345678901234567890123456789012",
        configId: "maths-oxbridge",
      };

      const token = signRelayToken(payload, secret);
      const [payloadPart, sigPart] = token.split(".");

      const expectedSig = createHmac("sha256", secret)
        .update(payloadPart)
        .digest()
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      expect(sigPart).toBe(expectedSig);
    });
  });

  describe("verifyRelayToken", () => {
    it("round trip: sign and verify", () => {
      const payload: RelayTokenPayload = {
        v: 1,
        exp: startTime + RELAY_TOKEN_TTL_MS,
        nonce: "12345678901234567890123456789012",
        configId: "maths-oxbridge",
      };

      const token = signRelayToken(payload, secret);
      const result = verifyRelayToken(token, secret, startTime + 1000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.v).toBe(1);
        expect(result.payload.nonce).toBe(payload.nonce);
        expect(result.payload.configId).toBe(payload.configId);
        expect(result.payload.exp).toBe(payload.exp);
      }
    });

    // T1a: v !== 1 check
    it("T1a: payload with v: 2 -> bad_payload", () => {
      const badPayload = {
        v: 2,
        exp: startTime + 100000,
        nonce: "12345678901234567890123456789012",
        configId: "maths-oxbridge",
      };
      const badPayloadPart = base64urlEncode(JSON.stringify(badPayload));

      const sig = createHmac("sha256", secret)
        .update(badPayloadPart)
        .digest()
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const token = `${badPayloadPart}.${sig}`;

      const result = verifyRelayToken(token, secret, startTime);
      expect(result).toEqual({ ok: false, reason: "bad_payload" });
    });

    describe("malformed", () => {
      it("no dot -> malformed", () => {
        const result = verifyRelayToken("nothere", secret, startTime);
        expect(result).toEqual({ ok: false, reason: "malformed" });
      });

      it("two dots -> malformed", () => {
        const result = verifyRelayToken("a.b.c", secret, startTime);
        expect(result).toEqual({ ok: false, reason: "malformed" });
      });

      it("empty payload part -> malformed", () => {
        const result = verifyRelayToken(".sig", secret, startTime);
        expect(result).toEqual({ ok: false, reason: "malformed" });
      });

      it("empty sig part -> malformed", () => {
        const result = verifyRelayToken("payload.", secret, startTime);
        expect(result).toEqual({ ok: false, reason: "malformed" });
      });
    });

    describe("bad_signature", () => {
      it("tampered signature -> bad_signature", () => {
        const payload: RelayTokenPayload = {
          v: 1,
          exp: startTime + RELAY_TOKEN_TTL_MS,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const [payloadPart, sigPart] = token.split(".");

        // Tamper with signature
        const tamperedSig = sigPart.slice(0, -1) + (sigPart[sigPart.length - 1] === "a" ? "b" : "a");
        const tamperedToken = `${payloadPart}.${tamperedSig}`;

        const result = verifyRelayToken(tamperedToken, secret, startTime + 1000);
        expect(result).toEqual({ ok: false, reason: "bad_signature" });
      });

      it("different secret -> bad_signature", () => {
        const payload: RelayTokenPayload = {
          v: 1,
          exp: startTime + RELAY_TOKEN_TTL_MS,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const result = verifyRelayToken(token, "different-secret-must-be-32-chars", startTime + 1000);
        expect(result).toEqual({ ok: false, reason: "bad_signature" });
      });

      it("shortened signature -> bad_signature", () => {
        const payload: RelayTokenPayload = {
          v: 1,
          exp: startTime + RELAY_TOKEN_TTL_MS,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const [payloadPart, sigPart] = token.split(".");
        const shortenedToken = `${payloadPart}.${sigPart.slice(0, -5)}`;

        const result = verifyRelayToken(shortenedToken, secret, startTime + 1000);
        expect(result).toEqual({ ok: false, reason: "bad_signature" });
      });
    });

    describe("bad_payload", () => {
      it("valid signature but bad JSON -> bad_payload", () => {
        // Create payload part with invalid JSON
        const badPayloadPart = base64urlEncode("this is not json");

        // Sign it
        const sig = createHmac("sha256", secret)
          .update(badPayloadPart)
          .digest()
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const token = `${badPayloadPart}.${sig}`;

        const result = verifyRelayToken(token, secret, startTime);
        expect(result).toEqual({ ok: false, reason: "bad_payload" });
      });

      it("valid signature but wrong shape -> bad_payload", () => {
        // Valid JSON but wrong shape
        const badPayload = { v: 2, exp: startTime + 100000, nonce: "123", configId: "test" };
        const badPayloadPart = base64urlEncode(JSON.stringify(badPayload));

        const sig = createHmac("sha256", secret)
          .update(badPayloadPart)
          .digest()
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const token = `${badPayloadPart}.${sig}`;

        const result = verifyRelayToken(token, secret, startTime);
        expect(result).toEqual({ ok: false, reason: "bad_payload" });
      });

      it("valid signature but invalid nonce format -> bad_payload", () => {
        const badPayload = {
          v: 1,
          exp: startTime + 100000,
          nonce: "not32chars",
          configId: "maths-oxbridge",
        };
        const badPayloadPart = base64urlEncode(JSON.stringify(badPayload));

        const sig = createHmac("sha256", secret)
          .update(badPayloadPart)
          .digest()
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const token = `${badPayloadPart}.${sig}`;

        const result = verifyRelayToken(token, secret, startTime);
        expect(result).toEqual({ ok: false, reason: "bad_payload" });
      });

      it("valid signature but empty configId -> bad_payload", () => {
        const badPayload = {
          v: 1,
          exp: startTime + 100000,
          nonce: "12345678901234567890123456789012",
          configId: "",
        };
        const badPayloadPart = base64urlEncode(JSON.stringify(badPayload));

        const sig = createHmac("sha256", secret)
          .update(badPayloadPart)
          .digest()
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const token = `${badPayloadPart}.${sig}`;

        const result = verifyRelayToken(token, secret, startTime);
        expect(result).toEqual({ ok: false, reason: "bad_payload" });
      });
    });

    describe("expired", () => {
      it("at now === exp -> expired", () => {
        const exp = startTime + RELAY_TOKEN_TTL_MS;
        const payload: RelayTokenPayload = {
          v: 1,
          exp,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const result = verifyRelayToken(token, secret, exp); // now === exp

        expect(result).toEqual({ ok: false, reason: "expired" });
      });

      it("after exp -> expired", () => {
        const payload: RelayTokenPayload = {
          v: 1,
          exp: startTime + RELAY_TOKEN_TTL_MS,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const result = verifyRelayToken(token, secret, startTime + RELAY_TOKEN_TTL_MS + 1000);

        expect(result).toEqual({ ok: false, reason: "expired" });
      });

      it("at exp - 1 -> valid", () => {
        const exp = startTime + RELAY_TOKEN_TTL_MS;
        const payload: RelayTokenPayload = {
          v: 1,
          exp,
          nonce: "12345678901234567890123456789012",
          configId: "maths-oxbridge",
        };

        const token = signRelayToken(payload, secret);
        const result = verifyRelayToken(token, secret, exp - 1);

        expect(result.ok).toBe(true);
      });
    });
  });
});
