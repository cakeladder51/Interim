import type { RelayOptions } from "./server";

export interface LoadRelayEnvResult {
  ok: true;
  opts: RelayOptions;
}

export interface LoadRelayEnvError {
  ok: false;
  errors: string[];
}

/**
 * Load relay configuration from environment variables.
 * Error messages never contain the actual values.
 */
export function loadRelayEnv(env: Record<string, string | undefined>): LoadRelayEnvResult | LoadRelayEnvError {
  const errors: string[] = [];

  // Required: RELAY_SECRET (>= 32 chars)
  const secret = env.RELAY_SECRET;
  if (!secret) {
    errors.push("RELAY_SECRET is missing");
  } else if (secret.length < 32) {
    errors.push("RELAY_SECRET is too short (must be at least 32 characters)");
  }

  // Required: MODEL_API_KEY (non-empty)
  const apiKey = env.MODEL_API_KEY;
  if (!apiKey) {
    errors.push("MODEL_API_KEY is missing");
  }

  // B9: Validate PORT (before returning if required vars missing)
  let port = 8080;
  if (env.PORT !== undefined && env.PORT !== "") {
    // B6: Require strict integer format (no "12abc" or "1.5")
    if (!/^\d+$/.test(env.PORT)) {
      errors.push("PORT must be an integer between 0 and 65535");
    } else {
      const parsedPort = parseInt(env.PORT, 10);
      if (parsedPort < 0 || parsedPort > 65535) {
        errors.push("PORT must be an integer between 0 and 65535");
      } else {
        port = parsedPort;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const upstreamUrl = env.ASR_UPSTREAM_URL ?? "wss://api.meta.ai/v1/asr/realtime";

  // Parse allowed origins (comma-separated, trimmed)
  let allowedOrigins: string[] | null = null;
  if (env.RELAY_ALLOWED_ORIGINS) {
    const trimmed = env.RELAY_ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (trimmed.length > 0) {
      allowedOrigins = trimmed;
    }
  }

  // Parse max sessions
  let maxSessions = 50;
  if (env.RELAY_MAX_SESSIONS) {
    // B6: Require strict integer format (no "5abc" or "1.5")
    if (/^\d+$/.test(env.RELAY_MAX_SESSIONS)) {
      const parsed = parseInt(env.RELAY_MAX_SESSIONS, 10);
      if (parsed > 0) {
        maxSessions = parsed;
      }
    }
    // Otherwise fallback to default 50
  }

  return {
    ok: true,
    opts: {
      port,
      secret: secret!,
      apiKey: apiKey!,
      upstreamUrl,
      allowedOrigins,
      maxSessions,
      authTimeoutMs: 5000,
      upstreamReadyTimeoutMs: 10000,
      maxSessionMs: 1_800_000, // 30 min
      preReadyBufferBytes: 64000, // 2s of 16kHz PCM16
    },
  };
}
