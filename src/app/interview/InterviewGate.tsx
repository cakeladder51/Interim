"use client";

import { useState, useEffect, type FormEvent } from "react";
import type { PublicConfig } from "@/config/public";
import type { RecordingSession } from "@/client/recording/recording-session";
import { createRecordingSession } from "@/client/recording/recording-session";
import { createBrowserRecordingDeps } from "@/client/recording/browser-recording";
import InterviewScreen from "./InterviewScreen";

interface InterviewGateProps {
  config: PublicConfig;
  styleId: string;
}

export default function InterviewGate({
  config,
  styleId,
}: InterviewGateProps) {
  const [stage, setStage] = useState<"consent" | "starting" | "started">(
    "consent"
  );
  const [audio, setAudio] = useState(false);
  const [video, setVideo] = useState(false);
  const [session, setSession] = useState<RecordingSession | null>(null);

  useEffect(() => {
    if (!session) return;
    return () => session.dispose();
  }, [session]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!audio && !video) {
      setStage("started");
      return;
    }
    const s = createRecordingSession(createBrowserRecordingDeps());
    setSession(s);
    setStage("starting");
    void s.start({ audio, video }).then(() => setStage("started"));
  };

  if (stage === "started") {
    return (
      <InterviewScreen config={config} styleId={styleId} recording={session} />
    );
  }

  const styleLabel =
    config.styles.find((s) => s.id === styleId)?.label ?? styleId;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <form
        onSubmit={onSubmit}
        aria-labelledby="consent-title"
        className="w-full max-w-md rounded-lg border p-6"
        style={{ borderColor: "var(--foreground)", borderWidth: 1 }}
      >
        <h1 id="consent-title" className="text-2xl font-bold mb-2">
          Before you start
        </h1>
        <p className="text-sm opacity-70 mb-4">
          {config.subject} · {styleLabel}
        </p>
        <p className="mb-4">
          You can record this interview to watch or listen back later.
          Recordings stay on this device: nothing is uploaded, and you can
          download them when the interview ends.
        </p>
        <fieldset className="mb-6" disabled={stage === "starting"}>
          <legend className="text-sm font-semibold mb-3">
            Record (optional)
          </legend>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={audio}
                onChange={(e) => setAudio(e.target.checked)}
              />
              <span>
                Audio: your voice and the interviewer&apos;s
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={video}
                onChange={(e) => setVideo(e.target.checked)}
              />
              <span>Video of this tab, with the same audio</span>
            </label>
          </div>
        </fieldset>
        <button
          type="submit"
          disabled={stage === "starting"}
          className="w-full py-2 px-4 rounded font-semibold transition-colors"
          style={{
            backgroundColor: "var(--foreground)",
            color: "var(--background)",
          }}
        >
          {stage === "starting" ? "Waiting for permission…" : "Start interview"}
        </button>
        <p className="mt-4 text-sm opacity-60">
          Your browser will ask for permission for anything you tick.
        </p>
      </form>
    </main>
  );
}
