import { describe, it, expect, vi } from "vitest";
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

describe("meta client", () => {
  describe("chatJSON", () => {
    it("parses valid JSON response", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"value":42}' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      const result = await chatJSON({
        schema,
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      });

      expect(result.data).toEqual({ value: 42 });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("retries once on non-JSON content", async () => {
      let callCount = 0;
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async () => {
              callCount++;
              if (callCount === 1) {
                return {
                  choices: [{ message: { content: "not json" } }],
                };
              }
              return {
                choices: [{ message: { content: '{"value":42}' } }],
              };
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      const result = await chatJSON({
        schema,
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      });

      expect(callCount).toBe(2);
      expect(result.data).toEqual({ value: 42 });
    });

    it("throws invalid_output after retry fails", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "not json" } }],
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await expect(
        chatJSON({
          schema,
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client: mockClient as unknown as OpenAI,
        })
      ).rejects.toThrow(MetaError);

      try {
        await chatJSON({
          schema,
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client: mockClient as unknown as OpenAI,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(MetaError);
        expect((err as MetaError).code).toBe("invalid_output");
        expect((err as MetaError).retryable).toBe(true);
      }
    });

    it("throws on invalid schema in response", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"value":"not a number"}' } }],
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await expect(
        chatJSON({
          schema,
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client: mockClient as unknown as OpenAI,
        })
      ).rejects.toThrow(MetaError);
    });

    it("uses default model when not specified", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"value":42}' } }],
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await chatJSON({
        schema,
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      });

      // The model should be muse-spark-1.3 from mocked env
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: "muse-spark-1.3" }),
        expect.any(Object)
      );
    });

    it("retry: false with retryable failure → only one call", async () => {
      let callCount = 0;
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async () => {
              callCount++;
              throw new MetaError("upstream", "Error", true);
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await expect(
        chatJSON({
          schema,
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client: mockClient as unknown as OpenAI,
          retry: false,
        })
      ).rejects.toThrow(MetaError);

      expect(callCount).toBe(1);
    });

    it("default retry is true (2 calls on retryable failure)", async () => {
      let callCount = 0;
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async () => {
              callCount++;
              throw new MetaError("upstream", "Error", true);
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await expect(
        chatJSON({
          schema,
          schemaName: "Test",
          messages: [{ role: "user", content: "test" }],
          client: mockClient as unknown as OpenAI,
        })
      ).rejects.toThrow(MetaError);

      expect(callCount).toBe(2);
    });
  });

  describe("chatStream", () => {
    it("yields content deltas", async () => {
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: "Hello" } }] };
        yield { choices: [{ delta: { content: " " } }] };
        yield { choices: [{ delta: { content: "world" } }] };
      })();

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(mockStream),
          },
        },
      };

      const tokens: string[] = [];
      for await (const token of chatStream({
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["Hello", " ", "world"]);
    });

    it("ignores empty deltas", async () => {
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: "" } }] };
        yield { choices: [{ delta: { content: "Hello" } }] };
        yield { choices: [{ delta: {} }] };
        yield { choices: [{}] };
        yield { choices: [{ delta: { content: " world" } }] };
      })();

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(mockStream),
          },
        },
      };

      const tokens: string[] = [];
      for await (const token of chatStream({
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["Hello", " world"]);
    });

    it("passes max_tokens when maxTokens is set", async () => {
      let capturedOptions: unknown;
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: "test" } }] };
      })();

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async (opts) => {
              capturedOptions = opts;
              return mockStream;
            }),
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of chatStream({
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
        maxTokens: 60,
      })) {
        break;
      }

      expect(capturedOptions).toMatchObject({ max_tokens: 60 });
    });

    it("does not send max_tokens when unset", async () => {
      let capturedOptions: unknown;
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: "test" } }] };
      })();

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async (opts) => {
              capturedOptions = opts;
              return mockStream;
            }),
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of chatStream({
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      })) {
        break;
      }

      expect(capturedOptions).not.toHaveProperty("max_tokens");
    });

    it("uses default model when not specified", async () => {
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: "test" } }] };
      })();

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(mockStream),
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of chatStream({
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      })) {
        break;
      }

      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: "muse-spark-1.3" }),
        expect.any(Object)
      );
    });
  });

  describe("logging", () => {
    it("logs exactly one model_call on success", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"value":42}' } }],
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await chatJSON({
        schema,
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      });

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0][0]).toContain('"ok":true');

      infoSpy.mockRestore();
    });

    it("logs two model_calls for invalid_output (retry once)", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      let callCount = 0;
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async () => {
              callCount++;
              return callCount === 1
                ? { choices: [{ message: { content: "not json" } }] }
                : { choices: [{ message: { content: '{"value":42}' } }] };
            }),
          },
        },
      };

      const schema = z.object({ value: z.number() });
      await chatJSON({
        schema,
        schemaName: "Test",
        messages: [{ role: "user", content: "test" }],
        client: mockClient as unknown as OpenAI,
      });

      const logCalls = infoSpy.mock.calls.filter((call) =>
        call[0]?.includes?.('"tag":"model_call"')
      );
      // Two attempts: first invalid_output, second success
      expect(logCalls.length).toBe(2);
      expect(logCalls[0][0]).toContain('"ok":false');
      expect(logCalls[0][0]).toContain('"code":"invalid_output"');
      expect(logCalls[1][0]).toContain('"ok":true');

      infoSpy.mockRestore();
    });
  });
});
