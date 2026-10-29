import { describe, it, expect } from "vitest";
import { getPublicConfig } from "../src/config/public";
import { getConfig } from "../src/config/load";
import { ConfigError } from "../src/config/load";

describe("getPublicConfig", () => {
  it("returns exactly the documented keys for maths-oxbridge", () => {
    const result = getPublicConfig("maths-oxbridge");

    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "id",
      "problems",
      "styles",
      "subject",
      "timing",
      "title",
    ]);

    // Check styles
    expect(result.styles).toBeInstanceOf(Array);
    expect(result.styles.length).toBeGreaterThan(0);
    for (const style of result.styles) {
      const styleKeys = Object.keys(style).sort();
      expect(styleKeys).toEqual(["id", "label"]);
    }

    // Check problems
    expect(result.problems).toBeInstanceOf(Array);
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) {
      const problemKeys = Object.keys(problem).sort();
      // Should have id, title, statement, and optionally canvasHint
      expect(problemKeys).toContain("id");
      expect(problemKeys).toContain("title");
      expect(problemKeys).toContain("statement");
      // No extra keys beyond the allowed ones
      const allowedProblemKeys = ["canvasHint", "id", "statement", "title"];
      for (const key of problemKeys) {
        expect(allowedProblemKeys).toContain(key);
      }
    }

    // Check timing
    const timingKeys = Object.keys(result.timing).sort();
    expect(timingKeys).toEqual(["maxMinutes"]);
  });

  it("returns exactly the documented keys for cs-oxbridge", () => {
    const result = getPublicConfig("cs-oxbridge");

    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "id",
      "problems",
      "styles",
      "subject",
      "timing",
      "title",
    ]);
  });

  it("does not contain solution sketch, hints, probes, checkpoint descriptions, misconception signal/realign in JSON output", () => {
    const configs = ["maths-oxbridge", "cs-oxbridge"];

    for (const configId of configs) {
      const result = getPublicConfig(configId);
      const json = JSON.stringify(result);

      const fullConfig = getConfig(configId);

      // Check for solution sketch
      for (const problem of fullConfig.problems) {
        if (problem.solutionSketch) {
          expect(
            json,
            `config ${configId} should not contain solutionSketch`
          ).not.toContain(problem.solutionSketch);
        }

        // Check for checkpoint descriptions
        for (const checkpoint of problem.checkpoints) {
          expect(
            json,
            `config ${configId} should not contain checkpoint description`
          ).not.toContain(checkpoint.description);
        }

        // Check for hints
        for (const hint of problem.hintLadder) {
          expect(
            json,
            `config ${configId} should not contain hint: ${hint.slice(0, 30)}`
          ).not.toContain(hint);
        }

        // Check for probes
        for (const probe of problem.probes) {
          expect(
            json,
            `config ${configId} should not contain probe`
          ).not.toContain(probe);
        }

        // Check for misconception signals and realign text
        for (const misconception of problem.misconceptions) {
          expect(
            json,
            `config ${configId} should not contain misconception signal`
          ).not.toContain(misconception.signal);
          expect(
            json,
            `config ${configId} should not contain misconception realign`
          ).not.toContain(misconception.realign);
        }
      }
    }
  });

  it("canvasHint appears only for problems that have one", () => {
    const mathsConfig = getPublicConfig("maths-oxbridge");

    // maths-oxbridge has canvasHint on first problem
    const problem0 = mathsConfig.problems[0];
    expect(problem0.canvasHint).toBeDefined();

    // Find problems without canvasHint in full config
    const fullConfig = getConfig("maths-oxbridge");
    for (let i = 0; i < fullConfig.problems.length; i++) {
      const fullProblem = fullConfig.problems[i];
      const publicProblem = mathsConfig.problems[i];
      if (fullProblem.canvasHint === undefined) {
        expect(publicProblem.canvasHint).toBeUndefined();
      } else {
        expect(publicProblem.canvasHint).toBe(fullProblem.canvasHint);
      }
    }

    // cs-oxbridge problem without canvasHint
    const csConfig = getPublicConfig("cs-oxbridge");
    for (const problem of csConfig.problems) {
      if (problem.canvasHint === undefined) {
        // Key should not be present
        expect("canvasHint" in problem).toBe(false);
      }
    }
  });

  it("throws ConfigError for unknown id", () => {
    expect(() => getPublicConfig("unknown")).toThrow(ConfigError);
  });
});
