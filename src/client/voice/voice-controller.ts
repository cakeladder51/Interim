import type { InterviewAction } from "../interview-model";
import { createSentenceChunker } from "./sentence-chunker";
import { createPcmEncoder } from "./pcm-encoder";
import { createTtsPlayer } from "./tts-player";
import type { RelayHandlers, RelayConnection } from "./relay-client";
import { RelayConnectError } from "./relay-client";

export const BARGE_IN_MIN_WORDS = 2;
export const INTERJECTION_BARGE_IN_WORDS = 4;

export const VOICE_MESSAGES = {
  mic: "Microphone unavailable. You can keep typing your answers.",
  relay: "Voice input is unavailable right now. You can keep typing your answers.",
  busy: "Voice input is busy right now. You can keep typing your answers.",
  dropped: "Voice input disconnected. You can keep typing your answers.",
} as const;

export type VoiceStatus =
  | "off"
  | "starting"
  | "listening"
  | "reconnecting"
  | "unavailable";

export interface VoiceSnapshot {
  status: VoiceStatus;
  message: string | null;
  partial: string | null;
  speaking: boolean;
}

export interface MicHandle {
  sampleRate: number;
  stop(): void;
}

export function queueVoiceTurn(pending: string | null, text: string): string {
  return pending === null ? text.trim() : pending + " " + text.trim();
}

export function createVoiceController(deps: {
  connect: (handlers: RelayHandlers) => Promise<RelayConnection>;
  startMic: (onSamples: (samples: Float32Array) => void) => Promise<MicHandle>;
  tts: Omit<
    import("./tts-player").TtsPlayerDeps,
    "onSpeakingChange"
  >;
  onTurn: (text: string) => void;
  onChange: (snapshot: VoiceSnapshot) => void;
}): {
  enable(): void;
  disable(): void;
  dispose(): void;
  snapshot(): VoiceSnapshot;
  handleInterviewAction(action: InterviewAction): void;
  speakNow(text: string): void;
  stopSpeaking(): void;
} {
  // Initial snapshot
  let snap: VoiceSnapshot = {
    status: "off",
    message: null,
    partial: null,
    speaking: false,
  };

  // Generation counter for stale result handling
  let generation = 0;

  // State
  let disposed = false;
  let mic: MicHandle | null = null;
  let encoder: ReturnType<typeof createPcmEncoder> | null = null;
  let connection: RelayConnection | null = null;
  let suppressed = false;
  let interjectBaseline: number | null = null;

  // TTS player
  const tts = createTtsPlayer({
    ...deps.tts,
    onSpeakingChange: (speaking: boolean) => {
      updateSnapshot({ speaking });
    },
  });

  // Sentence chunker
  const chunker = createSentenceChunker();

  function updateSnapshot(partial: Partial<VoiceSnapshot>): void {
    const next: VoiceSnapshot = { ...snap, ...partial };
    // B2.5: only emit on real change
    if (
      next.status === snap.status &&
      next.message === snap.message &&
      next.partial === snap.partial &&
      next.speaking === snap.speaking
    ) {
      return;
    }
    snap = next;
    deps.onChange(snap);
  }

  function enable(): void {
    if (disposed) return;
    if (snap.status !== "off" && snap.status !== "unavailable") return;

    // Bump generation
    generation++;
    const gen = generation;

    // Set starting
    updateSnapshot({ status: "starting", message: null, partial: null });

    // Start mic synchronously (inside click gesture)
    let micPromise: Promise<MicHandle>;
    try {
      micPromise = deps.startMic((samples) => {
        if (disposed) return;
        if (gen !== generation) return;
        // B2.4: audio only while listening and connection exists
        if (snap.status !== "listening") return;
        if (!encoder) return;
        if (!connection) return;

        // Encode samples
        const frames = encoder.push(samples);
        for (const frame of frames) {
          connection.sendAudio(frame);
        }
      });
    } catch {
      updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });
      return;
    }

    // B2.1: Separate mic and relay error paths
    micPromise.then(
      (m) => {
        if (disposed || gen !== generation) {
          m.stop();
          return;
        }

        mic = m;

        try {
          encoder = createPcmEncoder(m.sampleRate);
        } catch {
          m.stop();
          mic = null;
          updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });
          return;
        }

        // Connect to relay - separate chain, not chained onto mic promise
        const handlers: RelayHandlers = {
          onPartial: (text: string) => {
            if (disposed || gen !== generation) return;
            updateSnapshot({ partial: text });

            // Barge-in: check if TTS is speaking
            if (tts.speaking()) {
              const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
              const threshold = interjectBaseline === null ? BARGE_IN_MIN_WORDS : interjectBaseline + INTERJECTION_BARGE_IN_WORDS;
              if (wordCount >= threshold) {
                tts.stop();
                chunker.reset();
                suppressed = true;
                interjectBaseline = null;
              }
            }
          },
          onTurnStart: () => {
            if (disposed || gen !== generation) return;
            if (interjectBaseline !== null) {
              interjectBaseline = 0;
            }
          },
          onTurnComplete: (_turnId: string, text: string) => {
            if (disposed || gen !== generation) return;
            if (interjectBaseline !== null) {
              interjectBaseline = 0;
            }
            updateSnapshot({ partial: null });
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              deps.onTurn(trimmed);
            }
          },
          onClose: (info) => {
            if (disposed || gen !== generation) return;

            if (!info.intentional && (snap.status === "listening" || snap.status === "reconnecting")) {
              // B2.4: set connection to null before reconnecting
              connection = null;
              // Unexpected close - reconnect
              updateSnapshot({ status: "reconnecting", partial: null });

              // Try reconnect once
              deps
                .connect(handlers)
                .then((conn) => {
                  if (disposed || gen !== generation) {
                    conn.close();
                    return;
                  }
                  connection = conn;
                  updateSnapshot({ status: "listening" });
                })
                .catch(() => {
                  if (disposed || gen !== generation) return;
                  mic?.stop();
                  mic = null;
                  encoder = null;
                  updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.dropped });
                });
            }
          },
        };

        deps.connect(handlers).then(
          (conn) => {
            if (disposed || gen !== generation) {
              conn.close();
              return;
            }
            connection = conn;
            updateSnapshot({ status: "listening" });
          },
          (err) => {
            if (disposed || gen !== generation) return;

            // Stop mic if it was started
            if (mic) {
              mic.stop();
              mic = null;
            }
            encoder = null;

            // Determine error message
            let message: string;
            if (err instanceof RelayConnectError) {
              if (err.kind === "busy") {
                message = VOICE_MESSAGES.busy;
              } else {
                message = VOICE_MESSAGES.relay;
              }
            } else {
              message = VOICE_MESSAGES.relay;
            }

            updateSnapshot({ status: "unavailable", message });
          }
        );
      },
      () => {
        // micPromise rejected - mic error path
        if (disposed || gen !== generation) return;
        updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });
      }
    );
  }

  function disable(): void {
    if (disposed) return;

    // Bump generation
    generation++;

    updateSnapshot({ status: "off", message: null, partial: null });

    // Stop mic
    if (mic) {
      mic.stop();
      mic = null;
    }
    encoder = null;

    // End connection
    if (connection) {
      connection.end().catch(() => {});
      connection = null;
    }

    // Stop TTS
    tts.stop();
    interjectBaseline = null;
  }

  function dispose(): void {
    if (disposed) return;
    // B2.3: call disable() first, then set disposed
    disable();
    disposed = true;
    generation++;
  }

  function handleInterviewAction(action: InterviewAction): void {
    if (disposed) return;

    // B2.6: follow the brief literally
    switch (action.type) {
      case "request":
        tts.stop();
        chunker.reset();
        suppressed = false;
        interjectBaseline = null;
        break;

      case "token":
        if (snap.status === "off" || suppressed) return;
        // Enqueue chunks from chunker
        const chunks = chunker.push(action.text);
        for (const chunk of chunks) {
          tts.enqueue(chunk);
        }
        break;

      case "done":
        if (snap.status === "off" || suppressed) {
          chunker.reset();
          return;
        }
        // Flush remaining
        const flushChunk = chunker.flush();
        if (flushChunk) {
          tts.enqueue(flushChunk);
        }
        break;

      case "failed":
        chunker.reset();
        break;

      case "bg_move":
        if (action.move.type === "silent") {
          // do nothing
          break;
        }
        tts.stop();
        chunker.reset();
        suppressed = false;
        if (action.move.type === "realign") {
          // Count words in current partial
          const partialText = snap.partial ?? "";
          interjectBaseline = partialText.trim().split(/\s+/).filter(Boolean).length;
        } else {
          interjectBaseline = null;
        }
        break;

      case "bg_failed":
        chunker.reset();
        interjectBaseline = null;
        break;

      case "bg_request":
        // do nothing, and in particular don't stop the TTS
        break;

      default:
        // Ignore other actions
        break;
    }
  }

  function speakNow(text: string): void {
    if (disposed) return;
    if (snap.status === "off") return;

    tts.stop();
    chunker.reset();
    suppressed = false;

    const chunks = chunker.push(text);
    for (const chunk of chunks) {
      tts.enqueue(chunk);
    }

    const flushChunk = chunker.flush();
    if (flushChunk) {
      tts.enqueue(flushChunk);
    }
  }

  function stopSpeaking(): void {
    if (disposed) return;
    tts.stop();
    chunker.reset();
    suppressed = true;
  }

  function getSnapshot(): VoiceSnapshot {
    return snap;
  }

  return {
    enable,
    disable,
    dispose,
    snapshot: getSnapshot,
    handleInterviewAction,
    speakNow,
    stopSpeaking,
  };
}
