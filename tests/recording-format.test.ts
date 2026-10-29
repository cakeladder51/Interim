// Stage 10 reviewer-supplied tests. Copy byte-identical to tests/recording-format.test.ts; do not edit.
import { describe, it, expect } from "vitest";
import { pickMimeType, extensionFor, fileStamp, formatBytes } from "@/client/recording/recording-format";

describe("recording format helpers", () => {
  it("pickMimeType returns the first supported candidate, in order", () => {
    const seen: string[] = [];
    expect(pickMimeType("audio", (t) => { seen.push(t); return true; })).toBe("audio/webm;codecs=opus");
    expect(seen).toEqual(["audio/webm;codecs=opus"]);
    expect(pickMimeType("audio", (t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType("audio", (t) => t === "audio/webm" || t === "audio/mp4")).toBe("audio/webm");
    expect(pickMimeType("video", (t) => t !== "video/webm;codecs=vp9,opus")).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType("video", (t) => t === "video/mp4")).toBe("video/mp4");
  });

  it("pickMimeType checks every candidate and returns \"\" when none is supported", () => {
    const audio: string[] = [];
    const video: string[] = [];
    expect(pickMimeType("audio", (t) => { audio.push(t); return false; })).toBe("");
    expect(pickMimeType("video", (t) => { video.push(t); return false; })).toBe("");
    expect(audio).toEqual(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
    expect(video).toEqual(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
  });

  it("extensionFor", () => {
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("video/webm")).toBe("webm");
    expect(extensionFor("audio/mp4")).toBe("mp4");
    expect(extensionFor("video/mp4;codecs=avc1,mp4a")).toBe("mp4");
    expect(extensionFor("")).toBe("webm");
    expect(extensionFor("audio/ogg")).toBe("webm");
  });

  it("fileStamp is UTC YYYY-MM-DD-HHMM", () => {
    expect(fileStamp(Date.UTC(2026, 9, 29, 14, 5, 59))).toBe("2026-10-29-1405");
    expect(fileStamp(Date.UTC(2027, 0, 2, 3, 4, 0))).toBe("2027-01-02-0304");
    expect(fileStamp(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12-31-2359");
  });

  it("formatBytes", () => {
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(1499)).toBe("1 KB");
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(999_499)).toBe("999 KB");
    expect(formatBytes(999_500)).toBe("1.0 MB");
    expect(formatBytes(1_234_567)).toBe("1.2 MB");
    expect(formatBytes(12_345_678)).toBe("12.3 MB");
  });
});
