import { describe, it, expect } from "vitest";
import { encodeSSE, parseSSE, type StepStreamEvent } from "../src/contracts/step-protocol";

describe("SSE", () => {
  describe("encode/parse round trip", () => {
    const eventTypes: StepStreamEvent[] = [
      { event: "move", data: { move: { type: "intro" }, interrupt: false } },
      { event: "move", data: { move: { type: "hint", rung: 0 }, interrupt: true } },
      { event: "move", data: { move: { type: "silent" }, interrupt: false } },
      { event: "token", data: { text: "Hello" } },
      {
        event: "done",
        data: {
          state: {
            version: 1,
            configId: "test",
            styleId: "test",
            startedAt: 0,
            phase: "problem",
            problemIdx: 0,
            hintRung: -1,
            checkpointsHit: [],
            lastInterjectAt: null,
            turnWordBaseline: 0,
            probesAsked: 0,
            transcript: [],
          },
          utterance: "Test",
        },
      },
      { event: "error", data: { code: "bad_request", message: "Invalid", retryable: false } },
    ];

    for (const event of eventTypes) {
      it(`round trips ${event.event} event`, async () => {
        const encoded = encodeSSE(event);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(encoded));
            controller.close();
          },
        });

        const events: StepStreamEvent[] = [];
        for await (const e of parseSSE(stream)) {
          events.push(e);
        }

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(event);
      });
    }
  });

  describe("parsing edge cases", () => {
    it("handles events split across chunk boundaries", async () => {
      const event: StepStreamEvent = {
        event: "move",
        data: { move: { type: "intro" }, interrupt: false },
      };
      const encoded = encodeSSE(event);

      // Split at every possible byte offset
      for (let i = 1; i < encoded.length - 1; i++) {
        const part1 = encoded.slice(0, i);
        const part2 = encoded.slice(i);

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(part1));
            controller.enqueue(new TextEncoder().encode(part2));
            controller.close();
          },
        });

        const events: StepStreamEvent[] = [];
        for await (const e of parseSSE(stream)) {
          events.push(e);
        }

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(event);
      }
    });

    it("handles multiple events in one chunk", async () => {
      const events: StepStreamEvent[] = [
        { event: "move", data: { move: { type: "intro" }, interrupt: false } },
        { event: "token", data: { text: "Hello" } },
        { event: "token", data: { text: "world" } },
      ];

      const combined = events.map(encodeSSE).join("");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(combined));
          controller.close();
        },
      });

      const parsed: StepStreamEvent[] = [];
      for await (const e of parseSSE(stream)) {
        parsed.push(e);
      }

      expect(parsed).toEqual(events);
    });

    it("handles CRLF line endings", async () => {
      const event: StepStreamEvent = {
        event: "move",
        data: { move: { type: "intro" }, interrupt: false },
      };

      // Manually encode with CRLF
      const encoded = `event: ${event.event}\r\ndata: ${JSON.stringify(event.data)}\r\n\r\n`;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        },
      });

      const parsed: StepStreamEvent[] = [];
      for await (const e of parseSSE(stream)) {
        parsed.push(e);
      }

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(event);
    });

    it("throws on malformed JSON", async () => {
      const encoded = "event: move\ndata: {not valid json}\n\n";

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        },
      });

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of parseSSE(stream)) {
          // Should throw
        }
      }).rejects.toThrow("invalid JSON");
    });

    it("throws on missing event type", async () => {
      const encoded = "data: {}\n\n";

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        },
      });

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of parseSSE(stream)) {
          // Should throw
        }
      }).rejects.toThrow("missing event type");
    });

    it("throws on missing data", async () => {
      const encoded = "event: move\n\n";

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        },
      });

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of parseSSE(stream)) {
          // Should throw
        }
      }).rejects.toThrow("missing data");
    });

    it("no unhandled rejection when body stream errors", async () => {
      const collectedRejections: unknown[] = [];
      const handler = (reason: unknown) => {
        collectedRejections.push(reason);
      };
      process.on("unhandledRejection", handler);

      try {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.error(Object.assign(new Error("boom"), { name: "AbortError" }));
          },
        });

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of parseSSE(stream)) {
            // Should throw
          }
        }).rejects.toMatchObject({ name: "AbortError" });

        // Wait a bit for any unhandled rejections to be collected
        await new Promise((r) => setTimeout(r, 20));

        expect(collectedRejections).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", handler);
      }
    });
  });
});
