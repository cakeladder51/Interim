import { parseWav } from "../src/wav";
import { signRelayToken, RELAY_TOKEN_TTL_MS } from "../../src/shared/relay-token";
import WebSocket from "ws";

interface Args {
  url: string;
  wav: string;
  configId: string;
}

function parseArgs(): Args | null {
  const args = process.argv.slice(2);
  const result: Partial<Args> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && i + 1 < args.length) {
      result.url = args[i + 1];
      i++;
    } else if (args[i] === "--wav" && i + 1 < args.length) {
      result.wav = args[i + 1];
      i++;
    } else if (args[i] === "--config" && i + 1 < args.length) {
      result.configId = args[i + 1];
      i++;
    }
  }

  if (!result.url || !result.wav || !result.configId) {
    console.error("Usage: tsx relay/scripts/wav-client.ts --url ws://localhost:8080/asr --wav <file.wav> --config <configId>");
    return null;
  }

  return result as Args;
}

async function main() {
  const args = parseArgs();
  if (!args) process.exit(1);

  // B8: Read RELAY_SECRET from environment
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    console.error("RELAY_SECRET is missing from environment");
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error("RELAY_SECRET is too short (must be at least 32 characters)");
    process.exit(1);
  }

  // Read WAV file
  const fs = await import("node:fs/promises");
  let wavData: Buffer;
  try {
    wavData = await fs.readFile(args.wav);
  } catch (err) {
    console.error(`Failed to read WAV file: ${err}`);
    process.exit(1);
  }

  // Parse WAV
  let parsed: ReturnType<typeof parseWav>;
  try {
    parsed = parseWav(wavData);
  } catch (err) {
    console.error(`Invalid WAV file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`WAV: ${parsed.sampleRate} Hz, ${parsed.numChannels} ch, ${parsed.bitsPerSample}-bit, ${parsed.audioData.length} bytes`);

  // Create token
  const now = Date.now();
  const token = signRelayToken(
    {
      v: 1,
      exp: now + RELAY_TOKEN_TTL_MS,
      nonce: Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join(""),
      configId: args.configId,
    },
    secret
  );

  // Connect to relay
  const ws = new WebSocket(args.url);

  ws.on("open", () => {
    console.log("Connected, sending auth...");
    ws.send(JSON.stringify({ type: "auth", token }));
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, JSON.stringify(msg));
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    console.log(`Connection closed: ${code} ${reason.toString()}`);
    process.exit(0);
  });

  // Wait for ready, then send audio
  let ready = false;

  const checkReady = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ready-check" }), (err) => {
          if (!err) {
            // Ready message received
            clearInterval(checkReady);
          }
        });
      } catch {
        // Ignore
      }
    }
  }, 100);

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ready" && !ready) {
      ready = true;
      clearInterval(checkReady);
      sendAudio();
    }
  });

  async function sendAudio() {
    const audioData = parsed.audioData;
    const frameSize = 3200; // 100 ms at 16 kHz PCM16
    const frameDelay = 100; // 100 ms real-time pacing

    console.log(`Sending ${audioData.length} bytes of audio...`);

    for (let offset = 0; offset < audioData.length; offset += frameSize) {
      const frame = audioData.subarray(offset, Math.min(offset + frameSize, audioData.length));
      ws.send(frame);
      await new Promise((resolve) => setTimeout(resolve, frameDelay));
    }

    console.log("Audio sent, sending end...");
    ws.send(JSON.stringify({ type: "end" }));
  }
}

main().catch(console.error);
