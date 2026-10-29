import { describe, it, expect, vi } from "vitest";
import {
  createTtsHandler,
  TTS_URL,
  TTS_MODEL,
  TTS_VOICE,
  TTS_MAX_CHARS,
  TTS_TIMEOUT_MS,
} from "../src/server/tts-handler";

describe("tts-route", () => {
  describe("503: no key", () => {
    it("returns 503 with no-store when key missing", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({}),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const response = await handler(request);

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const body = await response.json();
      expect(body).toEqual({
        error: {
          code: "tts_unavailable",
          message: "Voice output is not available right now.",
        },
      });
    });

    it("returns 503 for empty key", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(503);
    });

    it("warns once across two requests", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const handler = createTtsHandler({
        getEnv: () => ({}),
        fetch: vi.fn(),
      });

      const request1 = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "First" }),
      });

      const request2 = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Second" }),
      });

      await handler(request1);
      await handler(request2);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Interim: OPENAI_API_KEY is not set; /api/tts is unavailable."
      );

      warnSpy.mockRestore();
    });

    it("never calls fetch", async () => {
      const fetchSpy = vi.fn();

      const handler = createTtsHandler({
        getEnv: () => ({}),
        fetch: fetchSpy,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      await handler(request);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("400: bad request", () => {
    it("rejects invalid JSON", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toEqual({
        error: { code: "bad_request", message: "Invalid TTS request." },
      });
    });

    it("rejects missing text", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("rejects non-string text", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: 5 }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("rejects empty text", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("rejects text over 1000 chars", async () => {
      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: vi.fn(),
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(1001) }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });

    it("accepts text of exactly 1000 chars", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      });

      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: fetchMock,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(1000) }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
    });
  });

  describe("200: success", () => {
    it("returns audio with correct headers", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      });

      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: fetchMock,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "  Hello there.  " }),
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const body = await response.arrayBuffer();
      expect(new Uint8Array(body)).toEqual(new Uint8Array([1, 2, 3]));

      // Check upstream call
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0].length).toBe(2);

      const callArgs = calls[0] as unknown as [string, RequestInit];
      const url = callArgs[0];
      const init = callArgs[1];

      expect(url).toBe(TTS_URL);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test");
      expect(headers["Content-Type"]).toBe("application/json");

      const bodyObj = JSON.parse(init.body as string);
      expect(bodyObj.model).toBe(TTS_MODEL);
      expect(bodyObj.voice).toBe(TTS_VOICE);
      expect(bodyObj.input).toBe("Hello there.");
      expect(bodyObj.response_format).toBe("mp3");

      // Check signal exists
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("502: upstream failure", () => {
    it("returns 502 for upstream status 500", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const fetchMock = vi.fn(async () => {
        return new Response("Internal error", { status: 500 });
      });

      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: fetchMock,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const response = await handler(request);

      expect(response.status).toBe(502);

      const body = await response.json();
      expect(body).toEqual({
        error: { code: "tts_failed", message: "Voice output failed." },
      });

      // Check log
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logCall = warnSpy.mock.calls[0][0];
      const logObj = JSON.parse(logCall);
      expect(logObj.tag).toBe("tts_error");
      expect(logObj.status).toBe(500);
      expect(logObj.chars).toBe(5);

      warnSpy.mockRestore();
    });

    it("returns 502 for fetch throwing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const fetchMock = vi.fn(async () => {
        throw new Error("Network error");
      });

      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: fetchMock,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const response = await handler(request);

      expect(response.status).toBe(502);

      const body = await response.json();
      expect(body).toEqual({
        error: { code: "tts_failed", message: "Voice output failed." },
      });

      // Check log
      const logCall = warnSpy.mock.calls[0][0];
      const logObj = JSON.parse(logCall);
      expect(logObj.status).toBe(0);

      warnSpy.mockRestore();
    });
  });

  describe("No secrets in logs", () => {
    it("doesn't log the key or text", async () => {
      const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const logErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const fetchMock = vi.fn(async () => {
        return new Response("Error", { status: 500 });
      });

      const handler = createTtsHandler({
        getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
        fetch: fetchMock,
      });

      const request = new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Secret text" }),
      });

      await handler(request);

      // Check no console output contains the key or text
      for (const call of logSpy.mock.calls) {
        const str = typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
        expect(str).not.toContain("sk-test");
        expect(str).not.toContain("Secret text");
      }

      for (const call of logInfoSpy.mock.calls) {
        const str = typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
        expect(str).not.toContain("sk-test");
        expect(str).not.toContain("Secret text");
      }

      for (const call of logErrorSpy.mock.calls) {
        const str = typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
        expect(str).not.toContain("sk-test");
        expect(str).not.toContain("Secret text");
      }

      logSpy.mockRestore();
      logInfoSpy.mockRestore();
      logErrorSpy.mockRestore();
    });
  });

  // G2: Reviewer additions (stage-07-review)
  describe("Reviewer additions (stage-07-review)", () => {
    const okFetch = () =>
      vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => new Response(new Uint8Array([1, 2, 3])));
    const req = (body: unknown) =>
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("constants are exact", () => {
      expect(TTS_URL).toBe("https://api.openai.com/v1/audio/speech");
      expect(TTS_MODEL).toBe("gpt-4o-mini-tts");
      expect(TTS_VOICE).toBe("alloy");
      expect(TTS_MAX_CHARS).toBe(1000);
      expect(TTS_TIMEOUT_MS).toBe(10_000);
    });

    it("upstream call uses the literal URL, model and voice", async () => {
      const f = okFetch();
      const res = await createTtsHandler({ getEnv: () => ({ OPENAI_API_KEY: "sk-test" }), fetch: f })(req({ text: " Hi. " }));
      expect(res.status).toBe(200);
      const [url, init] = f.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/audio/speech");
      expect(JSON.parse(String(init.body))).toEqual({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: "Hi.",
        response_format: "mp3",
      });
    });

    it("uses AbortSignal.timeout(10000) as the upstream signal", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      try {
        const f = okFetch();
        await createTtsHandler({ getEnv: () => ({ OPENAI_API_KEY: "sk-test" }), fetch: f })(req({ text: "Hi." }));
        expect(spy).toHaveBeenCalledWith(10_000);
        expect(f.mock.calls[0][1].signal).toBe(spy.mock.results[0].value);
      } finally {
        spy.mockRestore();
      }
    });

    it("never logs the key or the text on any failure path", async () => {
      const spies = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
      ];
      try {
        const text = "My secret answer text";
        const env = () => ({ OPENAI_API_KEY: "sk-test" });
        await createTtsHandler({ getEnv: env, fetch: async () => new Response("x", { status: 500 }) })(req({ text }));
        await createTtsHandler({
          getEnv: env,
          fetch: async () => {
            throw new Error("network down for sk-test: " + text);
          },
        })(req({ text }));
        await createTtsHandler({ getEnv: () => ({}), fetch: okFetch() })(req({ text }));
        const logged = spies.flatMap((s) =>
          s.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
        );
        // positive control: two tts_error lines + the missing-key warning
        expect(logged.length).toBeGreaterThanOrEqual(3);
        for (const l of logged) {
          expect(l).not.toContain("sk-test");
          expect(l).not.toContain(text);
        }
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });
});
