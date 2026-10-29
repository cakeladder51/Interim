"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createVoiceController,
  queueVoiceTurn,
  type VoiceSnapshot,
} from "./voice/voice-controller";
import { connectRelay } from "./voice/relay-client";
import {
  startBrowserMic,
  fetchRelayToken,
  createBrowserSocket,
  fetchTtsAudio,
  playAudioBuffer,
  speakWithSynthesis,
  getAudioContext,
} from "./voice/browser-audio";
import type { InterviewAction } from "./interview-model";

export function useVoice(configId: string): {
  snapshot: VoiceSnapshot;
  pendingTurn: string | null;
  takePendingTurn(): void;
  enable(): void;
  disable(): void;
  stopSpeaking(): void;
  speakNow(text: string): void;
  onInterviewAction(action: InterviewAction): void;
} {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>({
    status: "off",
    message: null,
    partial: null,
    speaking: false,
  });
  const [pendingTurn, setPendingTurn] = useState<string | null>(null);

  const controllerRef = useRef<ReturnType<typeof createVoiceController> | null>(
    null
  );

  useEffect(() => {
    const controller = createVoiceController({
      connect: (handlers) =>
        connectRelay({
          fetchToken: () => fetchRelayToken(configId),
          createSocket: createBrowserSocket,
          handlers,
        }),
      startMic: startBrowserMic,
      tts: {
        fetchAudio: fetchTtsAudio,
        playAudio: playAudioBuffer,
        speakFallback: speakWithSynthesis,
      },
      onTurn: (text) => {
        setPendingTurn((p) => queueVoiceTurn(p, text));
      },
      onChange: setSnapshot,
    });

    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [configId]);

  const takePendingTurn = useCallback(() => {
    setPendingTurn(null);
  }, []);

  const enable = useCallback(() => {
    // Must call getAudioContext synchronously inside click
    getAudioContext();
    controllerRef.current?.enable();
  }, []);

  const disable = useCallback(() => {
    controllerRef.current?.disable();
  }, []);

  const stopSpeaking = useCallback(() => {
    controllerRef.current?.stopSpeaking();
  }, []);

  const speakNow = useCallback((text: string) => {
    controllerRef.current?.speakNow(text);
  }, []);

  const onInterviewAction = useCallback((action: InterviewAction) => {
    controllerRef.current?.handleInterviewAction(action);
  }, []);

  return {
    snapshot,
    pendingTurn,
    takePendingTurn,
    enable,
    disable,
    stopSpeaking,
    speakNow,
    onInterviewAction,
  };
}
