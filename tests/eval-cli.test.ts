import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("eval CLI", () => {
  it("prints hold message and exits 2 without MODEL_API_KEY", () => {
    const repo = process.cwd();
    const tsxPath = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(repo, "scripts", "eval.ts");

    // Remove MODEL_API_KEY from env
    const env = { ...process.env };
    delete env.MODEL_API_KEY;

    const result = spawnSync(
      process.execPath,
      [tsxPath, "--conditions=react-server", scriptPath],
      {
        cwd: repo,
        env,
        encoding: "utf-8",
        timeout: 10000,
      }
    );

    // Check exit code is 2
    expect(result.status).toBe(2);

    // Check exact hold message
    const stdout = result.stdout ?? "";
    expect(stdout).toContain("MODEL_API_KEY is not set. The live eval is on hold until a key is available.");
  });

  it("does not touch network without key", () => {
    // This test ensures the early exit happens before any network calls
    // The script exits synchronously with code 2 before importing network modules
    const repo = process.cwd();
    const tsxPath = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(repo, "scripts", "eval.ts");

    const env = { ...process.env };
    delete env.MODEL_API_KEY;

    // Run with a timeout - if it tries to touch network it would hang
    const result = spawnSync(
      process.execPath,
      [tsxPath, "--conditions=react-server", scriptPath],
      {
        cwd: repo,
        env,
        encoding: "utf-8",
        timeout: 5000, // Should exit immediately with code 2
      }
    );

    // If the script tried to contact network, it would timeout or error
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
  });

  it("package.json scripts.eval contains the required flags", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const evalScript = pkg.scripts.eval;
    expect(evalScript).toContain("--env-file-if-exists=.env.local");
    expect(evalScript).toContain("--conditions=react-server");
  });
});

describe("eval CLI with key (no network)", () => {
  let tempDir: string;
  let scriptsOutDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eval-cli-test-"));
    scriptsOutDir = join(tempDir, "evals", "scripts");
    mkdirSync(scriptsOutDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits 1 with no scripts (pass rate 0 < 0.8)", () => {
    const repo = process.cwd();
    const tsxPath = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(repo, "scripts", "eval.ts");

    const env = {
      ...process.env,
      MODEL_API_KEY: "fake-key-no-network",
      TSX_TSCONFIG_PATH: join(repo, "tsconfig.json"),
    };

    const result = spawnSync(
      process.execPath,
      [tsxPath, "--conditions=react-server", scriptPath],
      {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        timeout: 10000,
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Loaded 0 scripts");

    // Clean up any output files
    cleanupOutputFiles(tempDir, repo);
  });

  it("exits 0 with --min-pass 0", () => {
    const repo = process.cwd();
    const tsxPath = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(repo, "scripts", "eval.ts");

    const env = {
      ...process.env,
      MODEL_API_KEY: "fake-key-no-network",
      TSX_TSCONFIG_PATH: join(repo, "tsconfig.json"),
    };

    const result = spawnSync(
      process.execPath,
      [tsxPath, "--conditions=react-server", scriptPath, "--min-pass", "0"],
      {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        timeout: 10000,
      }
    );

    expect(result.status).toBe(0);

    // Clean up any output files
    cleanupOutputFiles(tempDir, repo);
  });

  it("exits 1 with --min-pass 2 (out of range)", () => {
    const repo = process.cwd();
    const tsxPath = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(repo, "scripts", "eval.ts");

    const env = {
      ...process.env,
      MODEL_API_KEY: "fake-key-no-network",
      TSX_TSCONFIG_PATH: join(repo, "tsconfig.json"),
    };

    const result = spawnSync(
      process.execPath,
      [tsxPath, "--conditions=react-server", scriptPath, "--min-pass", "2"],
      {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        timeout: 10000,
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--min-pass must be a number between 0 and 1");

    // Clean up any output files
    cleanupOutputFiles(tempDir, repo);
  });
});

function cleanupOutputFiles(tempDir: string, repo: string): void {
  // Clean up any eval-*.json files from scripts/out
  const outDir = join(repo, "scripts", "out");
  if (existsSync(outDir)) {
    const files = readdirSync(outDir);
    for (const file of files) {
      if (file.startsWith("eval-") && file.endsWith(".json")) {
        // Check if file was created recently (within last minute)
        // For simplicity, just remove all eval-*.json files
        try {
          unlinkSync(join(outDir, file));
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
