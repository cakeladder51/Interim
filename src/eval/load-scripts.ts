import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptSchema, type Script } from "./schema";
import { getConfig, getStyle, ConfigError } from "@/config/load";

/**
 * Load all scripts from a directory.
 * Reads every *.json file, sorted by filename, and parses each.
 * Throws on first invalid file, duplicate ids, or unresolvable config/style.
 */
export function loadScripts(dir?: string): Script[] {
  const scriptsDir = dir ?? join(process.cwd(), "evals", "scripts");
  
  let files: string[];
  try {
    files = readdirSync(scriptsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (err) {
    throw new Error(`Failed to read scripts directory: ${scriptsDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const scripts: Script[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const filePath = join(scriptsDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read script file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Invalid JSON in script file ${file}`);
    }

    const result = ScriptSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(
        `Invalid script in ${file}: ${issue?.path.join(".")} ${issue?.message ?? "validation failed"}`
      );
    }

    const script = result.data;

    // Check for duplicate ids
    if (seenIds.has(script.id)) {
      throw new Error(`Duplicate script id: ${script.id} (in ${file})`);
    }
    seenIds.add(script.id);

    // Validate config/style exist
    try {
      const config = getConfig(script.configId);
      getStyle(config, script.styleId);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Error(`Script ${file}: ${err.message}`);
      }
      throw err;
    }
    scripts.push(script);
  }

  return scripts;
}
