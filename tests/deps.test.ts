import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selectDeps } from "../src/server/deps";
import { fakeAssess, fakeSpeak } from "../src/server/fake-model";
import { assess } from "../src/server/assess";
import { speak } from "../src/server/speak";

describe("selectDeps", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('INTERIM_FAKE_MODEL="1" and NODE_ENV="development" → modelLabel="fake", assess === fakeAssess', () => {
    const deps = selectDeps({
      INTERIM_FAKE_MODEL: "1",
      NODE_ENV: "development",
    });

    expect(deps.modelLabel).toBe("fake");
    expect(deps.assess).toBe(fakeAssess);
    expect(deps.speak).toBe(fakeSpeak);
    // Note: warn may have been called by previous tests due to module-level flag
  });

  it('INTERIM_FAKE_MODEL="1" and NODE_ENV="production" → real deps, no modelLabel', () => {
    const deps = selectDeps({
      INTERIM_FAKE_MODEL: "1",
      NODE_ENV: "production",
    });

    expect(deps.modelLabel).toBeUndefined();
    expect(deps.assess).toBe(assess);
    expect(deps.speak).toBe(speak);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("empty env → real deps, no modelLabel", () => {
    const deps = selectDeps({});

    expect(deps.modelLabel).toBeUndefined();
    expect(deps.assess).toBe(assess);
    expect(deps.speak).toBe(speak);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('INTERIM_FAKE_MODEL="true" → real deps (only "1" enables it)', () => {
    const deps = selectDeps({
      INTERIM_FAKE_MODEL: "true",
      NODE_ENV: "development",
    });

    expect(deps.modelLabel).toBeUndefined();
    expect(deps.assess).toBe(assess);
    expect(deps.speak).toBe(speak);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("INTERIM_FAKE_MODEL undefined → real deps", () => {
    const deps = selectDeps({
      NODE_ENV: "development",
    });

    expect(deps.modelLabel).toBeUndefined();
    expect(deps.assess).toBe(assess);
    expect(deps.speak).toBe(speak);
  });
});
