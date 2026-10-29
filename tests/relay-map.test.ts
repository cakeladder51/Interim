import { describe, it, expect } from "vitest";
import { mapUpstreamEvent, isUpstreamReady } from "../relay/src/map-upstream";

describe("relay-map", () => {
  describe("isUpstreamReady", () => {
    it("returns true for { sessionId: 'x' }", () => {
      expect(isUpstreamReady({ sessionId: "sess-1" })).toBe(true);
    });

    it("returns false for { sessionId: 'x', type: 'error' }", () => {
      expect(isUpstreamReady({ sessionId: "sess-1", type: "error" })).toBe(false);
    });

    it("returns false for {}", () => {
      expect(isUpstreamReady({})).toBe(false);
    });

    it("returns false for { type: 'speechStart' }", () => {
      expect(isUpstreamReady({ type: "speechStart" })).toBe(false);
    });

    it("returns false when sessionId is not a string", () => {
      expect(isUpstreamReady({ sessionId: 123 })).toBe(false);
    });
  });

  describe("mapUpstreamEvent", () => {
    describe("speechStart", () => {
      it("with string turnId -> send turn_start", () => {
        const result = mapUpstreamEvent({ type: "speechStart", turnId: "turn-1" });
        expect(result).toEqual({
          kind: "send",
          message: { type: "turn_start", turnId: "turn-1" },
        });
      });

      it("without turnId -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechStart" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("with non-string turnId -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechStart", turnId: 123 });
        expect(result).toEqual({ kind: "ignore" });
      });
    });

    describe("transcript partial (final !== true)", () => {
      it("with string transcript -> send partial", () => {
        const result = mapUpstreamEvent({ type: "transcript", transcript: "Hello", final: false });
        expect(result).toEqual({
          kind: "send",
          message: { type: "partial", text: "Hello" },
        });
      });

      it("without final field -> send partial", () => {
        const result = mapUpstreamEvent({ type: "transcript", transcript: "Hello" });
        expect(result).toEqual({
          kind: "send",
          message: { type: "partial", text: "Hello" },
        });
      });

      it("with non-string transcript -> ignore", () => {
        const result = mapUpstreamEvent({ type: "transcript", transcript: 123, final: false });
        expect(result).toEqual({ kind: "ignore" });
      });
    });

    describe("transcript final", () => {
      it("with final === true -> ignore", () => {
        const result = mapUpstreamEvent({ type: "transcript", transcript: "Hello world", final: true });
        expect(result).toEqual({ kind: "ignore" });
      });
    });

    describe("speechComplete", () => {
      it("with string turnId and transcript -> send turn_complete", () => {
        const result = mapUpstreamEvent({
          type: "speechComplete",
          turnId: "turn-1",
          transcript: "Hello world",
        });
        expect(result).toEqual({
          kind: "send",
          message: { type: "turn_complete", turnId: "turn-1", text: "Hello world" },
        });
      });

      it("without turnId -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechComplete", transcript: "Hello" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("without transcript -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechComplete", turnId: "turn-1" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("with non-string turnId -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechComplete", turnId: 123, transcript: "Hello" });
        expect(result).toEqual({ kind: "ignore" });
      });
    });

    describe("error", () => {
      it("never includes upstream message text", () => {
        const result = mapUpstreamEvent({
          type: "error",
          message: "internal upstream error details",
        });
        expect(result).toEqual({
          kind: "fatal",
          message: "Transcription service error",
        });
      });

      it("without message -> still fatal with generic message", () => {
        const result = mapUpstreamEvent({ type: "error" });
        expect(result).toEqual({
          kind: "fatal",
          message: "Transcription service error",
        });
      });
    });

    describe("ignored types", () => {
      it("speechEnd -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechEnd", turnId: "turn-1" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("audioProgress -> ignore", () => {
        const result = mapUpstreamEvent({ type: "audioProgress", ms: 100 });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("speaker -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speaker", id: "spk-1" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("unknown type -> ignore", () => {
        const result = mapUpstreamEvent({ type: "unknownType", data: "something" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("missing type -> ignore", () => {
        const result = mapUpstreamEvent({ data: "something" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("non-string type -> ignore", () => {
        const result = mapUpstreamEvent({ type: 123 });
        expect(result).toEqual({ kind: "ignore" });
      });
    });

    describe("known type missing required fields", () => {
      it("speechStart with missing turnId -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechStart" });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("transcript with missing transcript -> ignore", () => {
        const result = mapUpstreamEvent({ type: "transcript", final: false });
        expect(result).toEqual({ kind: "ignore" });
      });

      it("speechComplete with missing fields -> ignore", () => {
        const result = mapUpstreamEvent({ type: "speechComplete" });
        expect(result).toEqual({ kind: "ignore" });
      });
    });
  });
});
