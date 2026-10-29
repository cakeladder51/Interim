import type { RecordingDeps, StreamLike } from "./recording-session";
import { pickMimeType } from "./recording-format";
import { getAudioContext, setPlaybackTap } from "@/client/voice/browser-audio";

export function createBrowserRecordingDeps(): RecordingDeps {
  return {
    getMic: async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("getUserMedia unsupported");
      }
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      }) as unknown as StreamLike;
    },

    getTab: async () => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("getDisplayMedia unsupported");
      }
      const options = {
        video: true,
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
      };
      return navigator.mediaDevices.getDisplayMedia(
        options as DisplayMediaStreamOptions
      ) as unknown as StreamLike;
    },

    createMixer: (mic) => {
      const ctx = getAudioContext();
      const dest = ctx.createMediaStreamDestination();
      const source = mic
        ? ctx.createMediaStreamSource(mic as unknown as MediaStream)
        : null;
      source?.connect(dest); // never connect the mic to ctx.destination (echo)
      setPlaybackTap(dest); // TTS playback now also feeds the mix
      return {
        stream: dest.stream as unknown as StreamLike,
        dispose: () => {
          setPlaybackTap(null);
          source?.disconnect();
        },
      };
    },

    combine: (tab, audio) => {
      const tabStream = tab as unknown as MediaStream;
      const audioStream = audio as unknown as MediaStream;
      return new MediaStream([
        ...tabStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]) as unknown as StreamLike;
    },

    createRecorder: (stream, kind) => {
      if (typeof MediaRecorder === "undefined") {
        throw new Error("MediaRecorder unsupported");
      }
      const mimeType = pickMimeType(kind, (t) => MediaRecorder.isTypeSupported(t));
      return new MediaRecorder(
        stream as unknown as MediaStream,
        mimeType ? { mimeType } : undefined
      ) as unknown as {
        readonly mimeType: string;
        readonly state: "inactive" | "recording" | "paused";
        ondataavailable: ((e: { data: Blob }) => void) | null;
        onstop: (() => void) | null;
        onerror: (() => void) | null;
        start(timesliceMs: number): void;
        stop(): void;
      };
    },

    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => Date.now(),
  };
}
