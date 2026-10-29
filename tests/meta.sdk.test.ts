import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import OpenAI from "openai";
import { chatJSON, chatStream, MetaError } from "../src/lib/meta";
import { z } from "zod";

// Mock the env module
vi.mock("../src/lib/env", () => ({
  getServerEnv: vi.fn(() => ({
    MODEL_API_KEY: "test-key",
    META_MODEL: "muse-spark-1.3",
  })),
}));

let server: Server;
let port: number;
let requestCount = 0;
let testMode = "";

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const body: Uint8Array[] = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      requestCount++;
      const path = req.url ?? "/";
      
      if (path === "/v1/chat/completions") {
        const mode = testMode || req.headers["x-test-mode"] as string || "";
        
        if (mode === "hang" || mode === "hang-always") {
          // Never respond - just hang
          return;
        }
        
        if (mode === "hang-once") {
          // Hang on first request, succeed on second
          if (requestCount === 1) {
            return;
          }
        }
        
        if (mode === "stall-stream") {
          // Send headers then stall
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.flushHeaders();
          // Never send more data
          return;
        }
        
        if (mode === "partial-then-stall") {
          // Send headers and two chunks, then stall
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.flushHeaders();
          res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
          // Never send more data or end
          return;
        }
        
        if (mode === "stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          const chunks = [
            'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
            'data: [DONE]\n\n',
          ];
          let i = 0;
          const send = () => {
            if (i < chunks.length) {
              res.write(chunks[i]);
              i++;
              setTimeout(send, 5);
            } else {
              res.end();
            }
          };
          send();
          return;
        }
        
        if (mode === "429" || mode === "429-always") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }
        
        if (mode === "400") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Bad request" } }));
          return;
        }
        
        // Default: return valid JSON response
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"value":42}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  });
  
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function createClient(mode: string): OpenAI {
  testMode = mode;
  requestCount = 0;
  return new OpenAI({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${port}/v1`,
    maxRetries: 0,
  });
}

describe("meta client SDK-level tests", () => {
  describe("chatJSON", () => {
    it("server that never responds with short timeout → code:timeout, 2 requests (retry)", async () => {
      const client = createClient("hang");

      try {
        await chatJSON({
          schema: z.object({ value: z.number() }),
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          timeoutMs: 100,
          client,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("timeout");
      }
      
      // Server should see 2 requests (one retry)
      expect(requestCount).toBe(2);
    });

    it("first request hangs, second succeeds → resolves, 2 requests", async () => {
      const client = createClient("hang-once");

      const result = await chatJSON({
        schema: z.object({ value: z.number() }),
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        timeoutMs: 100,
        client,
      });

      expect(result.data).toEqual({ value: 42 });
      expect(requestCount).toBe(2);
    });

    it("server returns 429 twice → rate_limited, 2 requests", async () => {
      const client = createClient("429-always");

      try {
        await chatJSON({
          schema: z.object({ value: z.number() }),
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("rate_limited");
      }
      
      // Server should see 2 requests
      expect(requestCount).toBe(2);
    });

    it("server returns 400 → upstream retryable:false, 1 request", async () => {
      const client = createClient("400");

      try {
        await chatJSON({
          schema: z.object({ value: z.number() }),
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("upstream");
        expect((err as MetaError).retryable).toBe(false);
        expect((err as MetaError).status).toBe(400);
      }
      
      // Server should see exactly 1 request (no retry)
      expect(requestCount).toBe(1);
    });
  });

  describe("chatStream", () => {
    it("server sends SSE headers then stalls → code:timeout", async () => {
      const client = createClient("stall-stream");

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of chatStream({
          messages: [{ role: "user", content: "test" }],
          firstTokenTimeoutMs: 100,
          client,
        })) {
          // Should not yield anything
        }
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("timeout");
      }
    });

    it("server never responds → code:timeout", async () => {
      const client = createClient("hang");

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of chatStream({
          messages: [{ role: "user", content: "test" }],
          firstTokenTimeoutMs: 100,
          client,
        })) {
          // Should not yield anything
        }
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("timeout");
      }
    });

    it("server sends 2 chunks then stalls → yields partial tokens then throws timeout", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = createClient("partial-then-stall");

      const tokens: string[] = [];
      try {
        for await (const token of chatStream({
          messages: [{ role: "user", content: "test" }],
          firstTokenTimeoutMs: 1000,
          totalTimeoutMs: 300,
          client,
        })) {
          tokens.push(token);
        }
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("timeout");
      }

      // Should have collected the two chunks before stalling
      expect(tokens).toEqual(["Hello ", "world"]);

      // Exactly 1 model_call line logged, ok:false
      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0][0]).toContain('"ok":false');
      expect(logCalls[0][0]).toContain('"code":"timeout"');

      infoSpy.mockRestore();
    });

    it("server streams 3 SSE chunks → yields 3 deltas", async () => {
      const client = createClient("stream");

      const tokens: string[] = [];
      for await (const token of chatStream({
        messages: [{ role: "user", content: "test" }],
        client,
      })) {
        tokens.push(token);
      }
      
      expect(tokens).toEqual(["Hello ", "world", "!"]);
    });
  });

  describe("logging", () => {
    it("chatJSON timeout (hang mode) → exactly 2 lines, both ok:false", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = createClient("hang-always");

      try {
        await chatJSON({
          schema: z.object({ value: z.number() }),
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          timeoutMs: 50,
          client,
        });
      } catch {
        // Expected
      }

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(2);
      expect(logCalls[0][0]).toContain('"ok":false');
      expect(logCalls[0][0]).toContain('"code":"timeout"');
      expect(logCalls[1][0]).toContain('"ok":false');
      expect(logCalls[1][0]).toContain('"code":"timeout"');

      infoSpy.mockRestore();
    });

    it("chatStream stall-after-headers → exactly 1 line, ok:false", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = createClient("stall-stream");

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of chatStream({
          messages: [{ role: "user", content: "test" }],
          firstTokenTimeoutMs: 50,
          client,
        })) {
          // Should not yield
        }
      } catch {
        // Expected
      }

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0][0]).toContain('"ok":false');
      expect(logCalls[0][0]).toContain('"code":"timeout"');

      infoSpy.mockRestore();
    });

    it("chatStream never-responds → exactly 1 line, ok:false", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = createClient("hang");

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of chatStream({
          messages: [{ role: "user", content: "test" }],
          firstTokenTimeoutMs: 50,
          client,
        })) {
          // Should not yield
        }
      } catch {
        // Expected
      }

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0][0]).toContain('"ok":false');
      expect(logCalls[0][0]).toContain('"code":"timeout"');

      infoSpy.mockRestore();
    });

    it("chatStream success → exactly 1 line, ok:true", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = createClient("stream");

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of chatStream({
        messages: [{ role: "user", content: "test" }],
        client,
      })) {
        // Just consume
      }

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0][0]).toContain('"ok":true');

      infoSpy.mockRestore();
    });
  });
});
