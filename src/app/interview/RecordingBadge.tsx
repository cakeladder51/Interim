"use client";

import { useSyncExternalStore } from "react";
import type { RecordingSession } from "@/client/recording/recording-session";

interface RecordingBadgeProps {
  session: RecordingSession;
}

export default function RecordingBadge({ session }: RecordingBadgeProps) {
  const snap = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot
  );

  let label: string | null = null;
  if (snap.audio === "recording" && snap.video === "recording") {
    label = "Recording audio and video";
  } else if (snap.audio === "recording") {
    label = "Recording audio";
  } else if (snap.video === "recording") {
    label = "Recording video";
  }

  if (label === null && snap.notices.length === 0) {
    return null;
  }

  return (
    <span className="flex items-center gap-2 text-sm" role="status">
      {label && (
        <span className="font-semibold" style={{ color: "#dc2626" }}>
          ● {label}
        </span>
      )}
      {snap.notices.length > 0 && (
        <span className="text-xs opacity-70">{snap.notices.join(" ")}</span>
      )}
    </span>
  );
}
