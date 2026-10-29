import type { InterviewConfig, Style } from "@/contracts";
import { InterviewConfigSchema } from "@/contracts";
import mathsConfig from "../../configs/maths-oxbridge.json";
import csConfig from "../../configs/cs-oxbridge.json";

// Parse configs at module load time to fail fast
const parsedConfigs: InterviewConfig[] = (() => {
  const maths = InterviewConfigSchema.parse(mathsConfig);
  const cs = InterviewConfigSchema.parse(csConfig);

  // Check for duplicate config ids
  if (maths.id === cs.id) {
    throw new Error(`Duplicate config id: ${maths.id}`);
  }

  return [maths, cs];
})();

export class ConfigError extends Error {
  constructor(
    public code: "unknown_config" | "unknown_style",
    message: string
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * List all available configs in stable order (maths, then cs).
 */
export function listConfigs(): {
  id: string;
  title: string;
  subject: string;
  styles: { id: string; label: string }[];
}[] {
  return parsedConfigs.map((c) => ({
    id: c.id,
    title: c.title,
    subject: c.subject,
    styles: c.styles.map((s) => ({ id: s.id, label: s.label })),
  }));
}

/**
 * Get a full config by id. Throws ConfigError if unknown.
 */
export function getConfig(id: string): InterviewConfig {
  const config = parsedConfigs.find((c) => c.id === id);
  if (!config) {
    throw new ConfigError("unknown_config", `Unknown config: ${id}`);
  }
  return config;
}

/**
 * Get a style from a config by id. Throws ConfigError if unknown.
 */
export function getStyle(config: InterviewConfig, styleId: string): Style {
  const style = config.styles.find((s) => s.id === styleId);
  if (!style) {
    throw new ConfigError("unknown_style", `Unknown style: ${styleId}`);
  }
  return style;
}
