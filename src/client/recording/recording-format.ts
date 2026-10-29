export type RecordingKind = "audio" | "video";

export function pickMimeType(kind: RecordingKind, isTypeSupported: (type: string) => boolean): string {
  const candidates: string[] =
    kind === "audio"
      ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

export function extensionFor(mimeType: string): "webm" | "mp4" {
  if (mimeType.startsWith("audio/mp4") || mimeType.startsWith("video/mp4")) {
    return "mp4";
  }
  return "webm";
}

export function fileStamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 999_500) {
    return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
