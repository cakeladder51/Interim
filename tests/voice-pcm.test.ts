import { describe, it, expect } from "vitest";
import { createPcmEncoder } from "../src/client/voice/pcm-encoder";

describe("voice-pcm", () => {
  describe("V1: 48kHz, 4800 samples of 0.5", () => {
    it("produces exactly 1 frame with all 16384 values", () => {
      const encoder = createPcmEncoder(48000);
      const samples = new Float32Array(4800).fill(0.5);
      const frames = encoder.push(samples);
      expect(frames).toHaveLength(1);
      const frame = frames[0];
      expect(frame.length).toBe(3200);
      // Check first 4 bytes: 00 40 00 40 (little-endian 16384)
      expect(frame[0]).toBe(0x00);
      expect(frame[1]).toBe(0x40);
      expect(frame[2]).toBe(0x00);
      expect(frame[3]).toBe(0x40);
      // All int16s should be 16384
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      for (let i = 0; i < 1600; i++) {
        expect(view.getInt16(i * 2, true)).toBe(16384);
      }
      // flush returns null
      expect(encoder.flush()).toBeNull();
    });
  });

  describe("V2: custom frame size with specific samples", () => {
    it("produces correct int16s", () => {
      const encoder = createPcmEncoder(48000, 4);
      const samples = new Float32Array([0, 0.25, 0.5, 1, 1, 1, -1, -1, -1, 2, 2, 2]);
      const frames = encoder.push(samples);
      expect(frames).toHaveLength(1);
      const frame = frames[0];
      expect(frame.length).toBe(8); // 4 samples * 2 bytes
      // hex: 00 20 ff 7f 01 80 ff 7f
      expect(frame[0]).toBe(0x00);
      expect(frame[1]).toBe(0x20);
      expect(frame[2]).toBe(0xff);
      expect(frame[3]).toBe(0x7f);
      expect(frame[4]).toBe(0x01);
      expect(frame[5]).toBe(0x80);
      expect(frame[6]).toBe(0xff);
      expect(frame[7]).toBe(0x7f);
    });
  });

  describe("V3: 44100Hz", () => {
    it("produces correct int16s", () => {
      const encoder = createPcmEncoder(44100, 4);
      const samples = new Float32Array([0, 0.5, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5]);
      const frames = encoder.push(samples);
      expect(frames).toHaveLength(1);
      const frame = frames[0];
      expect(frame.length).toBe(8);
      // int16s: [8192, 8192, 16384, -16383] (all but last)
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      expect(view.getInt16(0, true)).toBe(8192);
      expect(view.getInt16(2, true)).toBe(8192);
      expect(view.getInt16(4, true)).toBe(16384);
      expect(view.getInt16(6, true)).toBe(-16383);
    });
  });

  describe("V4: 16kHz, custom frame size", () => {
    it("produces frame and flush remainder", () => {
      const encoder = createPcmEncoder(16000, 3);
      const samples = new Float32Array([0.5, -0.5, 0.25, 1]);
      const frames = encoder.push(samples);
      expect(frames).toHaveLength(1);
      const frame = frames[0];
      expect(frame.length).toBe(6); // 3 samples * 2 bytes
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      expect(view.getInt16(0, true)).toBe(16384);
      expect(view.getInt16(2, true)).toBe(-16383);
      expect(view.getInt16(4, true)).toBe(8192);

      const flushFrame = encoder.flush();
      expect(flushFrame).not.toBeNull();
      expect(flushFrame!.length).toBe(2);
      const flushView = new DataView(flushFrame!.buffer, flushFrame!.byteOffset, flushFrame!.byteLength);
      expect(flushView.getInt16(0, true)).toBe(32767);

      expect(encoder.flush()).toBeNull();
    });
  });

  describe("V5: consistency across chunk sizes", () => {
    it("produces identical output for 48kHz", () => {
      const encoder1 = createPcmEncoder(48000);
      const encoder2 = createPcmEncoder(48000);

      // Generate 10000 pseudo-random samples
      let x = 12345;
      const rnd = () => {
        x = ((x * 1103515245 + 12345) % 2147483648) as number;
        return (x / 2147483648) * 2 - 1;
      };
      const allSamples = Float32Array.from({ length: 10000 }, rnd);

      // Push all at once
      const frames1 = [...encoder1.push(allSamples)];
      const flush1 = encoder1.flush();
      if (flush1) frames1.push(flush1);

      // Push in slices of sizes 1, 2, 3, ..., 7, 1, 2, ...
      let offset = 0;
      let size = 1;
      const frames2: Uint8Array[] = [];
      while (offset < allSamples.length) {
        const chunk = allSamples.slice(offset, offset + size);
        const f = encoder2.push(chunk);
        frames2.push(...f);
        offset += size;
        size = (size % 7) + 1;
      }
      const flush2 = encoder2.flush();
      if (flush2) frames2.push(flush2);

      // Concatenate and compare
      const bytes1 = new Uint8Array(frames1.reduce((acc, f) => acc + f.length, 0));
      let pos = 0;
      for (const f of frames1) {
        bytes1.set(f, pos);
        pos += f.length;
      }

      const bytes2 = new Uint8Array(frames2.reduce((acc, f) => acc + f.length, 0));
      pos = 0;
      for (const f of frames2) {
        bytes2.set(f, pos);
        pos += f.length;
      }

      expect(bytes1.length).toBe(6666);
      expect(bytes1.byteLength).toBe(bytes2.byteLength);
      expect(bytes1).toEqual(bytes2);
    });

    it("produces identical output for 44100Hz", () => {
      const encoder1 = createPcmEncoder(44100);
      const encoder2 = createPcmEncoder(44100);

      let x = 12345;
      const rnd = () => {
        x = ((x * 1103515245 + 12345) % 2147483648) as number;
        return (x / 2147483648) * 2 - 1;
      };
      const allSamples = Float32Array.from({ length: 10000 }, rnd);

      const frames1 = [...encoder1.push(allSamples)];
      const flush1 = encoder1.flush();
      if (flush1) frames1.push(flush1);

      let offset = 0;
      let size = 1;
      const frames2: Uint8Array[] = [];
      while (offset < allSamples.length) {
        const chunk = allSamples.slice(offset, offset + size);
        const f = encoder2.push(chunk);
        frames2.push(...f);
        offset += size;
        size = (size % 7) + 1;
      }
      const flush2 = encoder2.flush();
      if (flush2) frames2.push(flush2);

      const bytes1 = new Uint8Array(frames1.reduce((acc, f) => acc + f.length, 0));
      let pos = 0;
      for (const f of frames1) {
        bytes1.set(f, pos);
        pos += f.length;
      }

      const bytes2 = new Uint8Array(frames2.reduce((acc, f) => acc + f.length, 0));
      pos = 0;
      for (const f of frames2) {
        bytes2.set(f, pos);
        pos += f.length;
      }

      expect(bytes1.length).toBe(7256);
      expect(bytes1).toEqual(bytes2);
    });

    it("produces identical output for 22050Hz", () => {
      const encoder1 = createPcmEncoder(22050);
      const encoder2 = createPcmEncoder(22050);

      let x = 12345;
      const rnd = () => {
        x = ((x * 1103515245 + 12345) % 2147483648) as number;
        return (x / 2147483648) * 2 - 1;
      };
      const allSamples = Float32Array.from({ length: 10000 }, rnd);

      const frames1 = [...encoder1.push(allSamples)];
      const flush1 = encoder1.flush();
      if (flush1) frames1.push(flush1);

      let offset = 0;
      let size = 1;
      const frames2: Uint8Array[] = [];
      while (offset < allSamples.length) {
        const chunk = allSamples.slice(offset, offset + size);
        const f = encoder2.push(chunk);
        frames2.push(...f);
        offset += size;
        size = (size % 7) + 1;
      }
      const flush2 = encoder2.flush();
      if (flush2) frames2.push(flush2);

      const bytes1 = new Uint8Array(frames1.reduce((acc, f) => acc + f.length, 0));
      let pos = 0;
      for (const f of frames1) {
        bytes1.set(f, pos);
        pos += f.length;
      }

      const bytes2 = new Uint8Array(frames2.reduce((acc, f) => acc + f.length, 0));
      pos = 0;
      for (const f of frames2) {
        bytes2.set(f, pos);
        pos += f.length;
      }

      expect(bytes1.length).toBe(14512);
      expect(bytes1).toEqual(bytes2);
    });
  });

  describe("V6: unsupported sample rates", () => {
    it("throws for 8000Hz", () => {
      expect(() => createPcmEncoder(8000)).toThrow("Unsupported input sample rate: 8000");
    });

    it("throws for 15999Hz", () => {
      expect(() => createPcmEncoder(15999)).toThrow("Unsupported input sample rate: 15999");
    });

    it("throws for 44100.5Hz (non-integer)", () => {
      expect(() => createPcmEncoder(44100.5)).toThrow("Unsupported input sample rate: 44100.5");
    });
  });
});
