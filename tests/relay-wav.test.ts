import { describe, it, expect } from "vitest";
import { parseWav, WavError } from "../relay/src/wav";

function createWavHeader(
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
  dataSize: number
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // audio format (PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

describe("relay-wav", () => {
  it("parses a valid 16 kHz mono PCM16 WAV", () => {
    const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const header = createWavHeader(16000, 1, 16, audioData.length);
    const wav = Buffer.concat([header, audioData]);

    const result = parseWav(wav);

    expect(result.sampleRate).toBe(16000);
    expect(result.numChannels).toBe(1);
    expect(result.bitsPerSample).toBe(16);
    expect(result.audioData).toEqual(audioData);
  });

  describe("rejections", () => {
    it("rejects stereo", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
      const header = createWavHeader(16000, 2, 16, audioData.length);
      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("mono");
      }
    });

    it("rejects 44.1 kHz", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const header = createWavHeader(44100, 1, 16, audioData.length);
      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("16 kHz");
      }
    });

    it("rejects 8-bit", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const header = createWavHeader(16000, 1, 8, audioData.length);
      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("16-bit");
      }
    });

    it("rejects missing RIFF header", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const header = createWavHeader(16000, 1, 16, audioData.length);
      header.write("XXXX", 0); // Wrong header
      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("RIFF");
      }
    });

    it("rejects missing WAVE format", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const header = createWavHeader(16000, 1, 16, audioData.length);
      header.write("XXXX", 8); // Wrong format
      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("WAVE");
      }
    });

    it("rejects file too short", () => {
      expect(() => parseWav(Buffer.from([0x01, 0x02, 0x03]))).toThrow(WavError);
      try {
        parseWav(Buffer.from([0x01, 0x02, 0x03]));
      } catch (err) {
        expect((err as WavError).message).toContain("too short");
      }
    });

    it("rejects missing fmt chunk", () => {
      // RIFF header with WAVE but no fmt chunk before data
      const wav = Buffer.alloc(100);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(92, 4); // file size - 8
      wav.write("WAVE", 8);
      // No fmt chunk, just data at position 12
      wav.write("data", 12);
      wav.writeUInt32LE(8, 16); // data size
      wav.writeUInt32LE(0x01020304, 20); // some audio data

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("fmt");
      }
    });

    it("rejects missing data chunk", () => {
      // Valid RIFF/WAVE header with fmt chunk but no data chunk
      const wav = Buffer.alloc(50);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(42, 4);
      wav.write("WAVE", 8);

      // fmt chunk
      wav.write("fmt ", 12);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);

      // No data chunk (file ends)

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("data");
      }
    });

    it("rejects non-PCM format (audio format != 1)", () => {
      const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const header = Buffer.alloc(44);

      header.write("RIFF", 0);
      header.writeUInt32LE(40, 4);
      header.write("WAVE", 8);

      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(3, 20); // IEEE float instead of PCM (1)
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(16000, 24);
      header.writeUInt32LE(32000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);

      header.write("data", 36);
      header.writeUInt32LE(4, 40);

      const wav = Buffer.concat([header, audioData]);

      expect(() => parseWav(wav)).toThrow(WavError);
      try {
        parseWav(wav);
      } catch (err) {
        expect((err as WavError).message).toContain("PCM");
      }
    });
  });
});
