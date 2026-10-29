import "server-only";

import { z } from "zod";

// Preprocess to convert empty strings to undefined so defaults work
const nonEmptyString = z.preprocess(
  (val) => (val === "" ? undefined : val),
  z.string().min(1, "MODEL_API_KEY is required")
);

const optionalString = z.preprocess(
  (val) => (val === "" ? undefined : val),
  z.string().optional()
);

const ServerEnvSchema = z.object({
  MODEL_API_KEY: nonEmptyString,
  META_MODEL: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().default("muse-spark-1.3")
  ),
  OPENAI_API_KEY: optionalString,
  RELAY_URL: optionalString,
  RELAY_SECRET: optionalString,
});

type ServerEnv = z.output<typeof ServerEnvSchema>;

let cachedEnv: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cachedEnv !== null) {
    return cachedEnv;
  }

  const result = ServerEnvSchema.safeParse(process.env);

  if (!result.success) {
    const invalidFields = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Missing/invalid env: ${invalidFields}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}
