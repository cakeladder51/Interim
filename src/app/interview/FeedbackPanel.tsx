"use client";

import { useState, useEffect, useRef } from "react";
import type { EngineState } from "@/contracts";
import {
  fetchFeedback,
  formatAt,
  createFeedbackRunner,
  type FeedbackSnapshot,
} from "@/client/feedback-client";

interface FeedbackPanelProps {
  state: EngineState;
}

export default function FeedbackPanel({ state }: FeedbackPanelProps) {
  const [snap, setSnap] = useState<FeedbackSnapshot>({ status: "loading" });
  const runnerRef = useRef<ReturnType<typeof createFeedbackRunner> | null>(null);

  useEffect(() => {
    const runner = createFeedbackRunner({
      fetchFeedback: (s, signal) => fetchFeedback(s, { signal }),
      onChange: setSnap,
    });
    runnerRef.current = runner;
    runner.start(state);
    return () => {
      runner.abort();
      runnerRef.current = null;
    };
  }, [state]);

  return (
    <section aria-label="Feedback" className="w-full max-w-2xl text-left">
      {snap.status === "loading" && (
        <p className="text-sm opacity-60" role="status">
          Preparing your feedback…
        </p>
      )}

      {snap.status === "ready" && (
        <>
          <h2 className="text-lg font-semibold mb-2">Your feedback</h2>
          <p className="mb-4">{snap.view.summary}</p>

          <h3 className="font-semibold mb-1">Scores</h3>
          <ul className="mb-4">
            {snap.view.criteria.map((c) => (
              <li key={c.id} className="mb-2">
                <span className="font-semibold">{c.name}</span>: {c.score}/{c.maxScore}
                <p className="text-sm italic opacity-70">{c.descriptor}</p>
                <p className="text-sm">{c.justification}</p>
              </li>
            ))}
          </ul>

          {snap.view.strengths.length > 0 && (
            <>
              <h3 className="font-semibold mb-1">Strengths</h3>
              <ul className="mb-4 list-disc pl-5">
                {snap.view.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}

          {snap.view.improvements.length > 0 && (
            <>
              <h3 className="font-semibold mb-1">Things to work on</h3>
              <ul className="mb-4 list-disc pl-5">
                {snap.view.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}

          {snap.view.keyMoments.length > 0 && (
            <>
              <h3 className="font-semibold mb-1">Key moments</h3>
              <ul className="mb-4 list-disc pl-5">
                {snap.view.keyMoments.map((m, i) => (
                  <li key={i}>
                    <span className="font-mono">{formatAt(m.at)}</span> &ldquo;{m.quote}&rdquo;: {m.note}
                  </li>
                ))}
              </ul>
            </>
          )}

          {snap.view.modelLabel === "fake" && (
            <p className="text-xs opacity-50">
              Offline practice report (no AI model was used).
            </p>
          )}
        </>
      )}

      {snap.status === "failed" && (
        <>
          <p className="mb-2">{snap.message}</p>
          {snap.retryable && (
            <button
              onClick={() => runnerRef.current?.retry()}
              className="px-3 py-1 rounded text-sm font-semibold"
              style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
            >
              Try again
            </button>
          )}
          <h3 className="font-semibold mt-4 mb-1">Your transcript</h3>
          <ol>
            {state.transcript.map((e) => (
              <li key={e.id} className="mb-1">
                <span className="font-semibold">
                  {e.speaker === "student" ? "You" : "Interviewer"}
                </span>{" "}
                <span className="font-mono text-xs opacity-60">{formatAt(e.at)}</span>:{" "}
                {e.text}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
