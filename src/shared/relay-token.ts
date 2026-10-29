import { createHmac, timingSafeEqual } from "node:crypto";

export const RELAY_TOKEN_TTL_MS = 120_000;

export interface RelayTokenPayload {
  v: 1;
  exp: number;
  nonce: string;
  configId: string;
}

function base64urlEncode(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  // Add padding if needed
  const padLength = (4 - (str.length % 4)) % 4;
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  return Buffer.from(base64, "base64");
}

/**
 * Sign a relay token payload with HMAC-SHA256.
 */
export function signRelayToken(payload: RelayTokenPayload, secret: string): string {
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const sigBuffer = createHmac("sha256", secret).update(payloadPart).digest();
  const sigPart = sigBuffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payloadPart}.${sigPart}`;
}

/**
 * Verify a relay token.
 * Returns { ok: true, payload } on success, or { ok: false, reason } on failure.
 */
export function verifyRelayToken(
  token: string,
  secret: string,
  now: number
):
  | { ok: true; payload: RelayTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "bad_payload" } {
  // Check exactly one dot and both parts non-empty
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  if (token.indexOf(".", dotIndex + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }

  const payloadPart = token.slice(0, dotIndex);
  const sigPart = token.slice(dotIndex + 1);

  if (payloadPart.length === 0 || sigPart.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  // Verify signature
  const expectedSigBuffer = createHmac("sha256", secret).update(payloadPart).digest();
  const expectedSig = expectedSigBuffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const actualSigBuffer = base64urlDecode(sigPart);
  const expectedSigDecoded = base64urlDecode(expectedSig);

  // Compare with timing-safe comparison
  if (actualSigBuffer.length !== expectedSigDecoded.length) {
    return { ok: false, reason: "bad_signature" };
  }

  try {
    if (!timingSafeEqual(actualSigBuffer, expectedSigDecoded)) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  // Parse payload
  let payloadJson: string;
  try {
    payloadJson = base64urlDecode(payloadPart).toString("utf-8");
  } catch {
    return { ok: false, reason: "bad_payload" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "bad_payload" };
  }

  // Validate payload shape
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as Record<string, unknown>).v !== 1 ||
    typeof (payload as Record<string, unknown>).exp !== "number" ||
    !Number.isInteger((payload as Record<string, unknown>).exp) ||
    typeof (payload as Record<string, unknown>).nonce !== "string" ||
    !/^[0-9a-f]{32}$/.test((payload as Record<string, unknown>).nonce as string) ||
    typeof (payload as Record<string, unknown>).configId !== "string" ||
    ((payload as Record<string, unknown>).configId as string).length === 0
  ) {
    return { ok: false, reason: "bad_payload" };
  }

  // Check expiration
  if (now >= (payload as { exp: number }).exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload: payload as RelayTokenPayload };
}
