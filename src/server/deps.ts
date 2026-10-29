import "server-only";

import type { StepDeps } from "./step-handler";
import { assess } from "./assess";
import { speak } from "./speak";
import { fakeAssess, fakeSpeak } from "./fake-model";

let warnedFakeModel = false;

/**
 * Select step dependencies based on environment.
 * Returns fake model deps when INTERIM_FAKE_MODEL=1 and NODE_ENV !== "production".
 */
export function selectDeps(
  env: Record<string, string | undefined> = process.env
): StepDeps {
  const useFake =
    env.INTERIM_FAKE_MODEL === "1" && env.NODE_ENV !== "production";

  if (useFake) {
    if (!warnedFakeModel) {
      console.warn("Interim: using the offline fake model (INTERIM_FAKE_MODEL=1).");
      warnedFakeModel = true;
    }
    return {
      assess: fakeAssess,
      speak: fakeSpeak,
      now: () => Date.now(),
      modelLabel: "fake",
    };
  }

  return {
    assess,
    speak,
    now: () => Date.now(),
  };
}
