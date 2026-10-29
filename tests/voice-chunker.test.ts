import { describe, it, expect } from "vitest";
import { createSentenceChunker } from "../src/client/voice/sentence-chunker";

describe("voice-chunker", () => {
  describe("C1: simple sentence split", () => {
    it("splits on period and flush", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("Hello there. How");
      expect(r1).toEqual(["Hello there."]);
      const r2 = chunker.push(" are you? I");
      expect(r2).toEqual(["How are you?"]);
      const flush = chunker.flush();
      expect(flush).toBe("I");
    });
  });

  describe("C2: decimal number not split", () => {
    it("keeps 3.5 together", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("Is it 3.5");
      expect(r1).toEqual([]);
      const r2 = chunker.push("? Yes");
      expect(r2).toEqual(["Is it 3.5?"]);
      const flush = chunker.flush();
      expect(flush).toBe("Yes");
    });
  });

  describe("C3: quote with period", () => {
    it("splits on quote with period", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push('He said "stop." Then');
      expect(r1).toEqual(['He said "stop."']);
      const flush = chunker.flush();
      expect(flush).toBe("Then");
    });
  });

  describe("C4: newline split", () => {
    it("splits on newline", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("First line\nSecond");
      expect(r1).toEqual(["First line"]);
      const flush = chunker.flush();
      expect(flush).toBe("Second");
    });
  });

  describe("C5: long text with fallback split", () => {
    it("splits at MAX_CHUNK_CHARS with word boundary", () => {
      const chunker = createSentenceChunker();
      const text = "word ".repeat(50); // 250 chars
      const r1 = chunker.push(text);
      expect(r1).toHaveLength(1);
      expect(r1[0].length).toBe(199);
      // Check it's 40 words (first 40 "word" + 39 spaces + trailing space trimmed)
      const words = r1[0].split(/\s+/).filter(Boolean);
      expect(words.length).toBe(40);
      const flush = chunker.flush();
      expect(flush).toBe("word word word word word word word word word word");
    });
  });

  describe("C6: multiple punctuation marks", () => {
    it("splits on each punctuation", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("A. B! C? D");
      expect(r1).toEqual(["A.", "B!", "C?"]);
      const flush = chunker.flush();
      expect(flush).toBe("D");
    });
  });

  describe("C7: ellipsis", () => {
    it("splits on ellipsis followed by space", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("Wait... what");
      expect(r1).toEqual(["Wait..."]);
      const flush = chunker.flush();
      expect(flush).toBe("what");
    });
  });

  describe("C8: whitespace only", () => {
    it("returns empty and null flush", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("   ");
      expect(r1).toEqual([]);
      const flush = chunker.flush();
      expect(flush).toBeNull();
    });
  });

  describe("C9: reset", () => {
    it("clears buffer on reset", () => {
      const chunker = createSentenceChunker();
      chunker.push("Dropped text");
      chunker.reset();
      const r = chunker.push("Kept. ");
      expect(r).toEqual(["Kept."]);
      const flush = chunker.flush();
      expect(flush).toBeNull();
    });
  });

  describe("C10: very long word split", () => {
    it("splits at MAX_CHUNK_CHARS when no space found", () => {
      const chunker = createSentenceChunker();
      const text = "x".repeat(450);
      const r1 = chunker.push(text);
      expect(r1).toHaveLength(2);
      expect(r1[0].length).toBe(200);
      expect(r1[1].length).toBe(200);
      const flush = chunker.flush();
      expect(flush!.length).toBe(50);
    });
  });

  describe("C11: multiple newlines", () => {
    it("splits on first newline, keeps rest in buffer", () => {
      const chunker = createSentenceChunker();
      const r1 = chunker.push("Good.\n\nNext question: why?");
      expect(r1).toEqual(["Good."]);
      const flush = chunker.flush();
      expect(flush).toBe("Next question: why?");
    });
  });

  describe("C12: leading newlines after a sentence", () => {
    it("never emits an empty chunk", () => {
      const c = createSentenceChunker();
      expect(c.push("Good. ")).toEqual(["Good."]);
      expect(c.push("\n\nNext. ")).toEqual(["Next."]);
      expect(c.flush()).toBeNull();
    });
  });

  describe("C13: flush clears the buffer", () => {
    it("a second flush returns null", () => {
      const c = createSentenceChunker();
      expect(c.push("Half")).toEqual([]);
      expect(c.flush()).toBe("Half");
      expect(c.flush()).toBeNull();
      expect(c.push("More. ")).toEqual(["More."]);
      expect(c.flush()).toBeNull();
    });
  });
});
