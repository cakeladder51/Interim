import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countWords } from "../src/eval/schema";
import { loadScripts } from "../src/eval/load-scripts";

describe("eval schema", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eval-schema-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("countWords", () => {
    it("counts whitespace-separated tokens", () => {
      expect(countWords("hello world")).toBe(2);
      expect(countWords("  hello   world  ")).toBe(2);
      expect(countWords("one")).toBe(1);
      expect(countWords("")).toBe(0);
      expect(countWords("   ")).toBe(0);
    });
  });

  describe("loadScripts", () => {
    it("loads all 8 scripts with unique ids", () => {
      const scripts = loadScripts("evals/scripts");
      expect(scripts).toHaveLength(8);
      const ids = scripts.map((s) => s.id);
      expect(new Set(ids).size).toBe(8);
    });

    it("throws on non-increasing atMs", () => {
      const script = {
        id: "test-atms",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
          { atMs: 500, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/atMs must be strictly increasing/);
    });

    it("throws on equal atMs values", () => {
      const script = {
        id: "test-equal-atms",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/atMs must be strictly increasing/);
    });

    it("throws on assessCalled without mock", () => {
      const script = {
        id: "test-assesscalled",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "turn_complete", text: "test", source: "voice" as const }, expect: { move: { type: "acknowledge" }, interrupt: false, assessCalled: true }, mock: undefined },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/assessCalled must equal presence of mock/);
    });

    it("throws on mock without assessCalled", () => {
      const script = {
        id: "test-nomock",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "turn_complete", text: "test", source: "voice" as const }, expect: { move: { type: "acknowledge" }, interrupt: false, assessCalled: false }, mock: { status: "stuck", confidence: 0.8, checkpointsHit: [], misconceptionId: null, evidence: "test" } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/assessCalled must equal presence of mock/);
    });

    it("throws on live without assessCalled", () => {
      const script = {
        id: "test-live-noassess",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "turn_complete", text: "test", source: "voice" as const }, expect: { move: { type: "acknowledge" }, interrupt: false, assessCalled: false }, live: { status: ["stuck"] } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/live is only allowed when assessCalled is true/);
    });

    it("throws on live on canvas step", () => {
      const script = {
        id: "test-live-canvas",
        title: "Test",
        description: "Test",
        configId: "cs-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "canvas", image: "data:image/png;base64,abc" }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: true }, mock: { status: "off_track", confidence: 0.8, checkpointsHit: [], misconceptionId: null, evidence: "test" }, live: { status: ["off_track"] } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/live is not allowed on canvas steps/);
    });

    it("throws on partial with wrong word count", () => {
      const script = {
        id: "test-words",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "partial", text: "hello world", words: 5 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/partial words .* doesn't match countWords/);
    });

    it("throws on reason on silent move", () => {
      const script = {
        id: "test-reason",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "partial", text: "hello world", words: 2 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false, reason: "gated" } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/reason is not allowed when move.type is "silent"/);
    });

    it("throws on unknown configId", () => {
      const script = {
        id: "test-config",
        title: "Test",
        description: "Test",
        configId: "unknown-config",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/Unknown config/);
    });

    it("throws on unknown styleId", () => {
      const script = {
        id: "test-style",
        title: "Test",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "unknown-style",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/Unknown style/);
    });

    it("throws on duplicate script ids", () => {
      const script1 = {
        id: "duplicate",
        title: "Test 1",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      const script2 = {
        id: "duplicate",
        title: "Test 2",
        description: "Test",
        configId: "maths-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "silence", ms: 1000 }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "a.json"), JSON.stringify(script1));
      writeFileSync(join(tempDir, "b.json"), JSON.stringify(script2));
      expect(() => loadScripts(tempDir)).toThrow(/Duplicate script id/);
    });

    it("throws on canvas image without proper prefix", () => {
      const script = {
        id: "test-canvas-prefix",
        title: "Test",
        description: "Test",
        configId: "cs-oxbridge",
        styleId: "supportive",
        steps: [
          { atMs: 1000, event: { type: "canvas", image: "invalid-prefix" }, expect: { move: { type: "silent" }, interrupt: false, assessCalled: false } },
        ],
      };
      writeFileSync(join(tempDir, "bad.json"), JSON.stringify(script));
      expect(() => loadScripts(tempDir)).toThrow(/image.*must start with/);
    });
  });
});
