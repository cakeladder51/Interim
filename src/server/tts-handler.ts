import "server-only";

export const TTS_URL = "https://api.openai.com/v1/audio/speech";
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TTS_VOICE = "alloy";
export const TTS_MAX_CHARS = 1000;
export const TTS_TIMEOUT_MS = 10_000;

export function createTtsHandler(deps: {
  getEnv: () => Record<string, string | undefined>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  let warned = false;

  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };

    // Check for API key
    const key = deps.getEnv()["OPENAI_API_KEY"];
    if (!key || key === "") {
      if (!warned) {
        console.warn("Interim: OPENAI_API_KEY is not set; /api/tts is unavailable.");
        warned = true;
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "tts_unavailable",
            message: "Voice output is not available right now.",
          },
        }),
        {
          status: 503,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    }

    // Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "Invalid TTS request." },
        }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    }

    // Validate body
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).text !== "string"
    ) {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "Invalid TTS request." },
        }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    }

    const text = (body as { text: string }).text;
    const trimmed = text.trim();

    if (trimmed === "" || trimmed.length > TTS_MAX_CHARS) {
      return new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "Invalid TTS request." },
        }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    }

    // Call upstream - H1: use AbortSignal.timeout
    try {
      const upstream = await deps.fetch(TTS_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: trimmed,
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });

      if (!upstream.ok) {
        console.warn(
          JSON.stringify({
            tag: "tts_error",
            status: upstream.status,
            chars: trimmed.length,
          })
        );
        return new Response(
          JSON.stringify({
            error: { code: "tts_failed", message: "Voice output failed." },
          }),
          {
            status: 502,
            headers: { ...headers, "Content-Type": "application/json" },
          }
        );
      }

      return new Response(upstream.body, {
        status: 200,
        headers: { ...headers, "Content-Type": "audio/mpeg" },
      });
    } catch {
      console.warn(
        JSON.stringify({
          tag: "tts_error",
          status: 0,
          chars: trimmed.length,
        })
      );
      return new Response(
        JSON.stringify({
          error: { code: "tts_failed", message: "Voice output failed." },
        }),
        {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    }
  };
}
