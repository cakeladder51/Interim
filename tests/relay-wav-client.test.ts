import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

describe("relay-wav-client", () => {
  // B8: wav-client reads RELAY_SECRET from env
  it("B8: missing RELAY_SECRET exits 1 with error", async () => {
    const wavClientPath = path.resolve(process.cwd(), "relay/scripts/wav-client.ts");
    const tsxPath = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    
    // Create a minimal valid WAV file for testing
    const wavPath = path.resolve(process.cwd(), "tests/fixtures/test-audio.wav");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(wavPath), { recursive: true });
    
    // Simple 16 kHz mono PCM16 WAV header + minimal audio data
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + 4, 4); // file size - 8
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(4, 40);
    const audioData = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    await fs.writeFile(wavPath, Buffer.concat([header, audioData]));

    const child: ChildProcess = spawn(process.execPath, [tsxPath, wavClientPath, "--url", "ws://127.0.0.1:1/asr", "--wav", wavPath, "--config", "maths-oxbridge"], {
      env: { ...process.env, RELAY_SECRET: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf-8");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("RELAY_SECRET");
    // Should not make any connection (port 1 is never reached)
    expect(stderr).not.toContain("ECONNREFUSED");

    // Cleanup
    await fs.unlink(wavPath).catch(() => {});
  });

  it("B8: short RELAY_SECRET exits 1 with error", async () => {
    const wavClientPath = path.resolve(process.cwd(), "relay/scripts/wav-client.ts");
    const tsxPath = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    
    const wavPath = path.resolve(process.cwd(), "tests/fixtures/test-audio.wav");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(wavPath), { recursive: true });
    
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + 4, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(4, 40);
    const audioData = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    await fs.writeFile(wavPath, Buffer.concat([header, audioData]));

    const child: ChildProcess = spawn(process.execPath, [tsxPath, wavClientPath, "--url", "ws://127.0.0.1:1/asr", "--wav", wavPath, "--config", "maths-oxbridge"], {
      // Use REPLACE_WITH_ACTUAL_SHORT_SECRET instead of "shortsecret" to avoid any confusion
      env: { ...process.env, RELAY_SECRET: "shortsecret" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf-8");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("RELAY_SECRET");
    expect(stderr).toContain("32");

    // Cleanup
    await fs.unlink(wavPath).catch(() => {});
  });
});
