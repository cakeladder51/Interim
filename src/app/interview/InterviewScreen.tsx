"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useInterview } from "@/client/use-interview";
import { useVoice } from "@/client/use-voice";
import { visibleTranscript, isThinking, canSend } from "@/client/interview-model";
import { createTurnController, type TurnController } from "@/client/turn-controller";
import Scratchpad from "./Scratchpad";
import FeedbackPanel from "./FeedbackPanel";
import RecordingBadge from "./RecordingBadge";
import RecordingDownloads from "./RecordingDownloads";
import type { PublicConfig } from "@/config/public";
import type { RecordingSession } from "@/client/recording/recording-session";

interface InterviewScreenProps {
  config: PublicConfig;
  styleId: string;
  recording?: RecordingSession | null;
}

export default function InterviewScreen({ config, styleId, recording = null }: InterviewScreenProps) {
  const voice = useVoice(config.id);
  // S1: destructure stable callbacks to avoid render loop
  const { pendingTurn, takePendingTurn, disable: disableVoice } = voice;
  const turnRef = useRef<TurnController | null>(null);
  const { view, sendTurn, end, retry, sendBackground } = useInterview(config.id, styleId, {
    onAction: voice.onInterviewAction,
    onBackgroundSettled: (move) => turnRef.current?.settled(move),
  });
  const [input, setInput] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const confirmEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Find style label
  const style = config.styles.find((s) => s.id === styleId);
  const styleLabel = style?.label ?? styleId;

  // Elapsed timer
  useEffect(() => {
    if (view.engine === null) return;

    const startedAt = view.engine.startedAt;
    const tick = () => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [view.engine]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [view.engine?.transcript, view.streamingText, view.pendingStudentText]);

  // Create turn controller effect
  useEffect(() => {
    turnRef.current = createTurnController({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      send: sendBackground,
    });
    return () => {
      turnRef.current?.dispose();
      turnRef.current = null;
    };
  }, [sendBackground]);

  // Idle state
  const idle = view.status === "ready" && view.engine?.phase === "problem" && !voice.snapshot.speaking && pendingTurn === null;
  useEffect(() => {
    turnRef.current?.setIdle(idle);
  }, [idle, sendBackground]);

  // Partials
  useEffect(() => {
    if (voice.snapshot.partial === null) {
      turnRef.current?.turnBoundary();
    } else {
      turnRef.current?.partial(voice.snapshot.partial);
    }
  }, [voice.snapshot.partial, sendBackground]);

  // Voice turns
  useEffect(() => {
    if (pendingTurn !== null && canSend(view, pendingTurn) && !voice.snapshot.speaking) {
      sendTurn(pendingTurn, "voice");
      takePendingTurn();
    }
  }, [pendingTurn, takePendingTurn, view, sendTurn, voice.snapshot.speaking]);

  // End voice when interview ends
  useEffect(() => {
    if (view.status === "ended") {
      disableVoice();
    }
  }, [view.status, disableVoice]);

  // Handle send
  const handleSend = useCallback(() => {
    if (canSend(view, input)) {
      sendTurn(input);
      turnRef.current?.turnBoundary();
      setInput("");
    }
  }, [view, input, sendTurn]);

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // End button logic
  const handleEndClick = () => {
    if (confirmEnd) {
      end();
    } else {
      setConfirmEnd(true);
      confirmEndTimeoutRef.current = setTimeout(() => {
        setConfirmEnd(false);
      }, 5000);
    }
  };

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (confirmEndTimeoutRef.current) {
        clearTimeout(confirmEndTimeoutRef.current);
      }
    };
  }, []);

  // Handle voice button
  const handleVoiceClick = useCallback(() => {
    if (voice.snapshot.status === "off" || voice.snapshot.status === "unavailable") {
      voice.enable();
      // Speak the last interviewer message if ready
      if (view.status === "ready" && view.engine) {
        const transcript = view.engine.transcript;
        const lastEntry = transcript[transcript.length - 1];
        if (lastEntry && lastEntry.speaker === "interviewer") {
          voice.speakNow(lastEntry.text);
        }
      }
    } else {
      voice.disable();
    }
  }, [voice, view]);

  // Problem info
  const problemIdx = view.engine?.problemIdx ?? 0;
  const problem = config.problems[problemIdx];
  const isEnded = view.status === "ended";

  // Voice button label
  const voiceButtonLabel =
    voice.snapshot.status === "off" || voice.snapshot.status === "unavailable"
      ? "Start voice"
      : "Stop voice";

  // Voice status text
  const voiceStatusText =
    voice.snapshot.status === "starting"
      ? "Connecting…"
      : voice.snapshot.status === "listening"
        ? "Listening"
        : voice.snapshot.status === "reconnecting"
          ? "Reconnecting…"
          : null;

  // Format elapsed
  const elapsedMinutes = Math.floor(elapsed / 60);
  const elapsedSeconds = elapsed % 60;
  const elapsedStr = `${elapsedMinutes.toString().padStart(2, "0")}:${elapsedSeconds.toString().padStart(2, "0")}`;
  const maxMinutes = config.timing.maxMinutes;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b px-4 py-3 flex items-center justify-between" style={{ borderColor: "var(--foreground)", borderWidth: "0 0 1px 0" }}>
        <div className="flex items-center gap-4">
          <h1 className="font-bold">Interim</h1>
          <span className="text-sm opacity-60">{config.subject} · {styleLabel}</span>
        </div>
        <div className="flex items-center gap-4">
          {recording && <RecordingBadge session={recording} />}
          {view.engine && (
            <span className="text-sm" style={{ fontFamily: "var(--font-mono)" }}>
              {elapsedStr} / {maxMinutes}:00
            </span>
          )}
          {!isEnded && view.engine && view.status !== "sending" && (
            <button
              onClick={handleEndClick}
              className={`px-3 py-1 rounded text-sm ${
                confirmEnd ? "bg-red-500 text-white" : ""
              }`}
              style={confirmEnd ? undefined : { backgroundColor: "var(--foreground)", color: "var(--background)" }}
            >
              {confirmEnd ? "Confirm end" : "End interview"}
            </button>
          )}
        </div>
      </header>

      {/* Model badge */}
      {view.modelLabel === "fake" && (
        <div className="bg-yellow-100 text-yellow-900 text-xs px-4 py-1 text-center">
          Offline demo model
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Transcript panel */}
        <div
          className="flex-1 md:w-1/2 overflow-y-auto p-4"
          ref={transcriptRef}
          role="log"
          aria-live="polite"
        >
          {visibleTranscript(view).map((entry) => (
            <div key={entry.key} className="mb-4">
              <div className="text-xs font-semibold mb-1 opacity-60">
                {entry.speaker === "interviewer" ? "Interviewer" : "You"}
                {entry.kind === "interjection" && (
                  <span className="ml-2 px-1 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">
                    Interrupted
                  </span>
                )}
              </div>
              <div
                className={`rounded-lg p-3 ${
                  entry.kind === "pending" ? "opacity-50" : ""
                } ${
                  entry.kind === "streaming"
                    ? "border"
                    : ""
                }`}
                style={{
                  backgroundColor:
                    entry.speaker === "interviewer"
                      ? "rgba(128, 128, 128, 0.1)"
                      : "rgba(0, 122, 255, 0.1)",
                  borderColor: entry.kind === "streaming" ? "var(--foreground)" : undefined,
                }}
              >
                {entry.text}
                {entry.kind === "streaming" && (
                  <span className="inline-block w-1 h-4 ml-1 animate-pulse bg-current" />
                )}
              </div>
            </div>
          ))}

          {isThinking(view) && (
            <div className="mb-4">
              <div className="text-xs font-semibold mb-1 opacity-60">Interviewer</div>
              <div className="opacity-60">
                Interviewer is thinking…
                {view.slow && (
                  <span className="block mt-1 text-sm">Still thinking. This is taking longer than usual.</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Problem panel */}
        <div className="md:w-1/2 border-t md:border-t-0 md:border-l p-4" style={{ borderColor: "var(--foreground)" }}>
          <h2 className="text-sm font-semibold mb-2 opacity-60">
            Problem {problemIdx + 1} of {config.problems.length}: {problem?.title ?? "Loading..."}
          </h2>
          <p className="mb-4">{problem?.statement}</p>
          {problem?.canvasHint && (
            <p className="text-sm italic opacity-60 mb-4">{problem.canvasHint}</p>
          )}
          <Scratchpad
            onChange={(g) => turnRef.current?.canvasChanged(g)}
            onActivity={() => turnRef.current?.activity()}
            disabled={isEnded}
          />
        </div>
      </div>

      {/* Error banner */}
      {view.error && (
        <div className="border-t px-4 py-3" style={{ borderColor: "var(--foreground)", backgroundColor: "rgba(255, 0, 0, 0.1)" }}>
          <div className="flex items-center justify-between max-w-md mx-auto">
            <span className="text-sm">{view.error.message}</span>
            {view.error.retryable && (
              <button
                onClick={retry}
                className="px-3 py-1 rounded text-sm font-semibold"
                style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {/* Answer bar */}
      {isEnded ? (
        <div className="border-t p-6 flex flex-col items-center gap-4 overflow-y-auto max-h-[70vh]" style={{ borderColor: "var(--foreground)" }}>
          <p className="text-lg mb-2">Interview complete.</p>
          {view.engine && <FeedbackPanel state={view.engine} />}
          {recording && <RecordingDownloads session={recording} />}
          <Link
            href="/"
            className="py-2 px-4 rounded font-semibold"
            style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
          >
            Start another interview
          </Link>
        </div>
      ) : (
        <>
          {view.engine?.phase === "wrap_up" && (
            <p className="border-t px-4 py-2 text-sm opacity-60" style={{ borderColor: "var(--foreground)" }}>
              The interview is wrapping up. Add any final remarks, or press End interview.
            </p>
          )}
          <div className="border-t p-4" style={{ borderColor: "var(--foreground)" }}>
            {/* Speaking indicator */}
            {voice.snapshot.speaking && (
              <div className="mb-2 flex items-center justify-between max-w-md mx-auto text-sm">
                <span>Interviewer speaking</span>
                <button
                  onClick={() => voice.stopSpeaking()}
                  className="px-2 py-1 rounded text-xs"
                  style={{ backgroundColor: "rgba(128, 128, 128, 0.2)" }}
                >
                  Stop speaking
                </button>
              </div>
            )}

            {/* Voice message */}
            {voice.snapshot.message && (
              <div className="mb-2 text-sm max-w-md mx-auto" role="status">
                {voice.snapshot.message}
              </div>
            )}

            {/* Caption */}
            {voice.snapshot.partial !== null && (
              <div className="mb-2 text-sm max-w-md mx-auto opacity-60" aria-live="polite">
                You (speaking): {voice.snapshot.partial}
              </div>
            )}

            <div className="max-w-md mx-auto flex gap-2">
              {/* Voice button */}
              <button
                onClick={handleVoiceClick}
                className="px-3 rounded-lg text-sm font-semibold"
                style={{
                  backgroundColor:
                    voice.snapshot.status === "listening" ||
                    voice.snapshot.status === "starting" ||
                    voice.snapshot.status === "reconnecting"
                      ? "rgba(128, 128, 128, 0.3)"
                      : "var(--foreground)",
                  color: "var(--background)",
                }}
              >
                {voiceButtonLabel}
              </button>

              {/* Voice status */}
              {voiceStatusText && (
                <span className="flex items-center text-sm opacity-60">
                  {voiceStatusText}
                </span>
              )}

              <label className="sr-only" htmlFor="answer-input">
                Your answer
              </label>
              <textarea
                id="answer-input"
                className="flex-1 resize-none rounded-lg px-3 py-2 text-base"
                placeholder="Type your answer…"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  turnRef.current?.activity();
                }}
                onKeyDown={handleKeyDown}
                maxLength={4000}
                disabled={view.status !== "ready" && view.status !== "sending"}
                rows={1}
                style={{
                  backgroundColor: "rgba(128, 128, 128, 0.1)",
                  border: "1px solid var(--foreground)",
                }}
              />
              <button
                onClick={handleSend}
                disabled={!canSend(view, input)}
                className="px-4 rounded-lg font-semibold"
                style={{
                  backgroundColor: canSend(view, input) ? "var(--foreground)" : "rgba(128, 128, 128, 0.3)",
                  color: "var(--background)",
                  opacity: canSend(view, input) ? 1 : 0.5,
                }}
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
