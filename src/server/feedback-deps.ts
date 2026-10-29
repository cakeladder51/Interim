import "server-only";

import type { FeedbackDeps } from "./feedback-handler";
import { generateReport } from "./feedback";
import { fakeGenerate } from "./fake-feedback";

/**
 * Select feedback dependencies based on environment.
 * Returns fake model deps when INTERIM_FAKE_MODEL=1 and NODE_ENV !== "production".
 */
export function selectFeedbackDeps(
  env: Record<string, string | undefined> = process.env
): FeedbackDeps {
  const useFake = env.INTERIM_FAKE_MODEL === "1" && env.NODE_ENV !== "production";

  if (useFake) {
    return {
      generate: fakeGenerate,
      modelLabel: "fake",
    };
  }

  return {
    generate: generateReport,
  };
}
