import { TtsUnavailableError } from "./tts-player";
import type { Playback } from "./tts-player";
import type { MicHandle } from "./voice-controller";
import type { WebSocketLike } from "./relay-client";

let sharedContext: AudioContext | null = null;
let workletLoaded = false;
let playbackTap: AudioNode | null = null;

/** Stage 10 recording: TTS playback is also routed into this node while it's set. */
export function setPlaybackTap(node: AudioNode | null): void {
  playbackTap = node;
}

export function getAudioContext(): AudioContext {
  if (sharedContext === null) {
    sharedContext = new AudioContext();
  }
  if (sharedContext.state === "suspended") {
    void sharedContext.resume();
  }
  return sharedContext;
}

export async function startBrowserMic(
  onSamples: (samples: Float32Array) => void
): Promise<MicHandle> {
  const ctx = getAudioContext();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // A1: wrap everything after getUserMedia in try/catch to stop tracks on failure
  try {
    // Load worklet only once
    if (!workletLoaded) {
      await ctx.audioWorklet.addModule("/audio/capture-worklet.js");
      workletLoaded = true;
    }

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;

    workletNode.port.onmessage = (event) => {
      onSamples(event.data as Float32Array);
    };

    source.connect(workletNode);
    workletNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    return {
      sampleRate: ctx.sampleRate,
      stop() {
        workletNode.port.onmessage = null;
        source.disconnect();
        workletNode.disconnect();
        gainNode.disconnect();
        for (const track of stream.getTracks()) {
          track.stop();
        }
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    throw err;
  }
}

export async function fetchRelayToken(
  configId: string
): Promise<{ token: string; url: string }> {
  const res = await fetch("/api/relay-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configId }),
  });

  if (!res.ok) {
    throw new Error("Failed to fetch relay token");
  }

  const data = (await res.json()) as { token: string; url: string };
  return data;
}

export function createBrowserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return ws as WebSocketLike;
}

export async function fetchTtsAudio(
  text: string,
  signal: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (res.status === 503) {
    throw new TtsUnavailableError();
  }

  if (!res.ok) {
    throw new Error("tts " + res.status);
  }

  return res.arrayBuffer();
}

export function playAudioBuffer(bytes: ArrayBuffer): Playback {
  let resolveDone: () => void;
  let rejectDone: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let source: AudioBufferSourceNode | null = null;
  let stopped = false;

  getAudioContext()
    .decodeAudioData(bytes.slice(0))
    .then((buffer) => {
      if (stopped) return;

      source = getAudioContext().createBufferSource();
      source.buffer = buffer;
      source.connect(getAudioContext().destination);
      if (playbackTap) source.connect(playbackTap);

      source.onended = () => {
        resolveDone();
      };

      source.start(0);
    })
    .catch((err) => {
      rejectDone(err instanceof Error ? err : new Error("Audio decode error"));
    });

  return {
    done,
    stop() {
      stopped = true;
      if (source) {
        try {
          source.stop();
        } catch {
          // Ignore already stopped
        }
      }
      resolveDone();
    },
  };
}

export function speakWithSynthesis(text: string): Playback {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    return {
      done: Promise.resolve(),
      stop() {},
    };
  }

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";

  utterance.onend = () => {
    resolveDone();
  };

  utterance.onerror = () => {
    resolveDone();
  };

  window.speechSynthesis.speak(utterance);

  return {
    done,
    stop() {
      window.speechSynthesis.cancel();
      resolveDone();
    },
  };
}
