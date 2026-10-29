export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz = 3200 bytes

export function createPcmEncoder(
  inputRate: number,
  frameSamples: number = FRAME_SAMPLES
): {
  push(samples: Float32Array): Uint8Array[];
  flush(): Uint8Array | null;
} {
  // Rate check
  if (!Number.isInteger(inputRate) || inputRate < TARGET_SAMPLE_RATE) {
    throw new Error("Unsupported input sample rate: " + inputRate);
  }

  // State for decimation
  let runningSum = 0;
  let count = 0;
  let inputIndex = 0;
  let outputK = 0;
  const outputSamples: number[] = [];

  function emitFrames(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    while (outputSamples.length >= frameSamples) {
      const frameSamplesSlice = outputSamples.splice(0, frameSamples);
      const frame = new Uint8Array(frameSamples * 2);
      for (let i = 0; i < frameSamples; i++) {
        const sample = frameSamplesSlice[i];
        frame[i * 2] = sample & 0xff;
        frame[i * 2 + 1] = (sample >> 8) & 0xff;
      }
      frames.push(frame);
    }
    return frames;
  }

  function pushChunk(samples: Float32Array): Uint8Array[] {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      runningSum += sample;
      count++;
      inputIndex++;

      // Check if we've completed the current output window
      const windowEnd = Math.floor(((outputK + 1) * inputRate) / TARGET_SAMPLE_RATE);
      if (inputIndex >= windowEnd) {
        // Emit output sample
        const mean = runningSum / count;
        const clamped = Math.max(-1, Math.min(1, mean));
        const intSample = Math.round(clamped * 32767);
        outputSamples.push(intSample);

        // Move to next output window
        outputK++;
        runningSum = 0;
        count = 0;
      }
    }

    return emitFrames();
  }

  function flushFrame(): Uint8Array | null {
    // Discard incomplete input window (running partial sums)
    // Just return any complete output samples we have
    if (outputSamples.length === 0) {
      return null;
    }
    const samples = outputSamples.splice(0);
    const frame = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      frame[i * 2] = samples[i] & 0xff;
      frame[i * 2 + 1] = (samples[i] >> 8) & 0xff;
    }
    return frame;
  }

  return {
    push: pushChunk,
    flush: flushFrame,
  };
}
