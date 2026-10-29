"use client";

import { useSyncExternalStore, useEffect } from "react";
import type { RecordingSession } from "@/client/recording/recording-session";
import { formatBytes } from "@/client/recording/recording-format";

interface RecordingDownloadsProps {
  session: RecordingSession;
}

export default function RecordingDownloads({
  session,
}: RecordingDownloadsProps) {
  const snap = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot
  );

  useEffect(() => {
    void session.finish();
  }, [session]);

  if (snap.phase !== "finished") {
    return (
      <p className="text-sm opacity-60" role="status">
        Saving your recording…
      </p>
    );
  }

  return (
    <section aria-label="Recording" className="w-full max-w-2xl text-left">
      <h2 className="text-lg font-semibold mb-2">Your recording</h2>
      {snap.files.length === 0 ? (
        <p className="text-sm mb-2">No recording was saved.</p>
      ) : (
        <ul className="mb-2 list-disc pl-5">
          {snap.files.map((f) => (
            <li key={f.kind}>
              <a
                href={f.url}
                download={f.filename}
                className="underline"
              >
                Download {f.kind} ({formatBytes(f.bytes)})
              </a>
            </li>
          ))}
        </ul>
      )}
      {snap.notices.map((n) => (
        <p key={n} className="text-sm opacity-70">
          {n}
        </p>
      ))}
      <p className="text-xs opacity-50">
        Recordings stay on this device and were never uploaded. Download them
        before you leave this page.
      </p>
    </section>
  );
}
