import "server-only";

import { z } from "zod";
import {
  signRelayToken,
  RELAY_TOKEN_TTL_MS,
  type RelayTokenPayload,
} from "@/shared/relay-token";
import { getConfig, ConfigError } from "@/config/load";

const RequestBodySchema = z.object({
  configId: z.string().min(1),
});

type RequestBody = z.infer<typeof RequestBodySchema>;

export interface RelayTokenResponse {
  token: string;
  url: string;
  expiresAt: number;
}

/**
 * Create a handler for the /api/relay-token route.
 */
export function createRelayTokenHandler(deps: {
  getEnv: () => Record<string, string | undefined>;
  now: () => number;
  randomHex: (bytes: number) => string;
}): (request: Request) => Promise<Response> {
  let relayUnavailableWarned = false;

  return async (request: Request) => {
    const env = deps.getEnv();
    const secret = env.RELAY_SECRET;
    const url = env.RELAY_URL;

    const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };

    // Check relay availability
    if (!secret || secret.length < 32 || !url) {
      if (!relayUnavailableWarned) {
        console.warn("Relay unavailable: RELAY_SECRET missing or too short, or RELAY_URL missing");
        relayUnavailableWarned = true;
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "relay_unavailable",
            message: "Voice input is not available right now.",
          },
        }),
        { status: 503, headers }
      );
    }

    // Parse body
    let body: RequestBody;
    try {
      const json = await request.json();
      const parsed = RequestBodySchema.safeParse(json);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({
            error: {
              code: "bad_request",
              message: parsed.error.issues[0]?.message ?? "Invalid request body",
            },
          }),
          { status: 400, headers }
        );
      }
      body = parsed.data;
    } catch {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "Invalid JSON body" },
        }),
        { status: 400, headers }
      );
    }

    // Resolve config
    try {
      getConfig(body.configId);
    } catch (err) {
      if (err instanceof ConfigError) {
        return new Response(
          JSON.stringify({
            error: { code: "bad_request", message: err.message },
          }),
          { status: 400, headers }
        );
      }
      throw err;
    }

    // Create and sign token
    const now = deps.now();
    const expiresAt = now + RELAY_TOKEN_TTL_MS;
    const nonce = deps.randomHex(16);

    const payload: RelayTokenPayload = {
      v: 1,
      exp: expiresAt,
      nonce,
      configId: body.configId,
    };

    const token = signRelayToken(payload, secret);

    return new Response(
      JSON.stringify({
        token,
        url,
        expiresAt,
      } as RelayTokenResponse),
      { status: 200, headers }
    );
  };
}
