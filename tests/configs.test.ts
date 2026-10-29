import { describe, it, expect } from "vitest";
import { listConfigs, getConfig, getStyle, ConfigError } from "../src/config/load";
import type { InterviewConfig, Style } from "@/contracts";

describe("config loader", () => {
  describe("listConfigs", () => {
    it("returns maths-oxbridge then cs-oxbridge", () => {
      const configs = listConfigs();
      expect(configs).toHaveLength(2);
      expect(configs[0].id).toBe("maths-oxbridge");
      expect(configs[1].id).toBe("cs-oxbridge");
    });

    it("each config has supportive and rigorous styles", () => {
      const configs = listConfigs();
      for (const c of configs) {
        expect(c.styles).toHaveLength(2);
        expect(c.styles[0].id).toBe("supportive");
        expect(c.styles[1].id).toBe("rigorous");
      }
    });
  });

  describe("getConfig", () => {
    it("returns a schema-valid config for known id", () => {
      const config = getConfig("maths-oxbridge");
      expect(config.id).toBe("maths-oxbridge");
      expect(config.subject).toBe("Mathematics");
    });

    it("throws ConfigError for unknown id", () => {
      expect(() => getConfig("unknown")).toThrow(ConfigError);
      try {
        getConfig("unknown");
      } catch (e) {
        expect((e as ConfigError).code).toBe("unknown_config");
      }
    });
  });

  describe("getStyle", () => {
    it("returns a style for known styleId", () => {
      const config = getConfig("cs-oxbridge");
      const style = getStyle(config, "supportive");
      expect(style.id).toBe("supportive");
    });

    it("throws ConfigError for unknown style", () => {
      const config = getConfig("maths-oxbridge");
      expect(() => getStyle(config, "unknown")).toThrow(ConfigError);
      try {
        getStyle(config, "unknown");
      } catch (e) {
        expect((e as ConfigError).code).toBe("unknown_style");
      }
    });
  });

  describe("content rules", () => {
    const configs: InterviewConfig[] = [
      getConfig("maths-oxbridge"),
      getConfig("cs-oxbridge"),
    ];

    for (const config of configs) {
      describe(config.id, () => {
        it("has 3 problems", () => {
          expect(config.problems).toHaveLength(3);
        });

        it("each problem has exactly 3 checkpoints", () => {
          for (const p of config.problems) {
            expect(p.checkpoints).toHaveLength(3);
          }
        });

        it("each problem has a hint ladder of 3-4 rungs", () => {
          for (const p of config.problems) {
            expect(p.hintLadder.length).toBeGreaterThanOrEqual(3);
            expect(p.hintLadder.length).toBeLessThanOrEqual(4);
          }
        });

        it("each problem has at least 2 probes", () => {
          for (const p of config.problems) {
            expect(p.probes.length).toBeGreaterThanOrEqual(2);
          }
        });

        it("each problem has at least 2 misconceptions", () => {
          for (const p of config.problems) {
            expect(p.misconceptions.length).toBeGreaterThanOrEqual(2);
          }
        });

        it("rubric criteria ids are exactly approach, rigour, communication, responsiveness", () => {
          const ids = config.rubric.criteria.map((c) => c.id);
          expect(ids).toEqual(["approach", "rigour", "communication", "responsiveness"]);
        });

        it("each rubric criterion has scores 1, 2, 3, 4 in order", () => {
          for (const c of config.rubric.criteria) {
            expect(c.levels.map((l) => l.score)).toEqual([1, 2, 3, 4]);
          }
        });

        it("asrKeywords is non-empty", () => {
          expect(config.asrKeywords.length).toBeGreaterThan(0);
        });

        it("rigorous.minConfidence < supportive.minConfidence", () => {
          const supportive = config.styles.find((s) => s.id === "supportive") as Style;
          const rigorous = config.styles.find((s) => s.id === "rigorous") as Style;
          expect(rigorous.interjection.minConfidence).toBeLessThan(supportive.interjection.minConfidence);
        });

        it("rigorous.cooldownMs < supportive.cooldownMs", () => {
          const supportive = config.styles.find((s) => s.id === "supportive") as Style;
          const rigorous = config.styles.find((s) => s.id === "rigorous") as Style;
          expect(rigorous.interjection.cooldownMs).toBeLessThan(supportive.interjection.cooldownMs);
        });
      });
    }

    describe("spot-check transcription", () => {
      it("maths-oxbridge problem 3 c2 contains e^(−x)(1 − x)", () => {
        const config = getConfig("maths-oxbridge");
        const problem = config.problems[2];
        expect(problem.id).toBe("sketch-x-exp");
        const c2 = problem.checkpoints.find((c) => c.id === "c2");
        expect(c2?.description).toContain("e^(−x)(1 − x)");
      });

      it("cs-oxbridge problem 3 c3 contains 3^k ≥ n", () => {
        const config = getConfig("cs-oxbridge");
        const problem = config.problems[2];
        expect(problem.id).toBe("heavy-coin");
        const c3 = problem.checkpoints.find((c) => c.id === "c3");
        expect(c3?.description).toContain("3^k ≥ n");
      });
    });
  });
});
