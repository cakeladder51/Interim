/**
 * Result of parsing a WAV file.
 */
export interface ParsedWav {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  audioData: Buffer;
}

/**
 * Error thrown when WAV parsing fails.
 */
export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

/**
 * Parse a WAV file and extract PCM audio data.
 * Only supports 16 kHz mono PCM16 format.
 */
export function parseWav(data: Buffer): ParsedWav {
  // Minimum size: 44 bytes header
  if (data.length < 44) {
    throw new WavError("WAV file too short (minimum 44 bytes header)");
  }

  // Check RIFF header
  const riff = data.slice(0, 4).toString("ascii");
  if (riff !== "RIFF") {
    throw new WavError('Invalid WAV: missing RIFF header');
  }

  // Check WAVE format
  const wave = data.slice(8, 12).toString("ascii");
  if (wave !== "WAVE") {
    throw new WavError('Invalid WAV: missing WAVE format');
  }

  // Find fmt chunk
  let offset = 12;
  let fmtChunk: Buffer | null = null;
  let dataChunkOffset: number | null = null;
  let dataChunkSize: number | null = null;

  while (offset < data.length) {
    if (offset + 8 > data.length) break;

    const chunkId = data.slice(offset, offset + 4).toString("ascii");
    const chunkSize = data.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      fmtChunk = data.slice(offset + 8, offset + 8 + chunkSize);
    } else if (chunkId === "data") {
      dataChunkOffset = offset + 8;
      dataChunkSize = chunkSize;
    }

    offset += 8 + chunkSize;

    // Pad to even boundary
    if (chunkSize % 2 === 1) offset += 1;
  }

  if (!fmtChunk) {
    throw new WavError('Invalid WAV: missing "fmt " chunk');
  }
  if (dataChunkOffset === null || dataChunkSize === null) {
    throw new WavError('Invalid WAV: missing "data" chunk');
  }

  // Parse fmt chunk
  const audioFormat = fmtChunk.readUInt16LE(0);
  const numChannels = fmtChunk.readUInt16LE(2);
  const sampleRate = fmtChunk.readUInt32LE(4);
  const bitsPerSample = fmtChunk.readUInt16LE(14);

  // Validate format
  if (audioFormat !== 1) {
    throw new WavError("WAV must be PCM format (audio format 1)");
  }
  if (numChannels !== 1) {
    throw new WavError(`WAV must be mono, got ${numChannels} channels`);
  }
  if (sampleRate !== 16000) {
    throw new WavError(`WAV must be 16 kHz, got ${sampleRate} Hz`);
  }
  if (bitsPerSample !== 16) {
    throw new WavError(`WAV must be 16-bit, got ${bitsPerSample}-bit`);
  }

  const audioData = data.slice(dataChunkOffset, dataChunkOffset + dataChunkSize);

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    audioData,
  };
}
