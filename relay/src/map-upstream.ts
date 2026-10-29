import type { RelayServerMessage } from "@/contracts";

export type UpstreamEvent = Record<string, unknown>;

/**
 * Check if a message is the upstream ready acknowledgement (has sessionId, no type).
 */
export function isUpstreamReady(msg: UpstreamEvent): msg is { sessionId: string } {
  return (
    typeof msg.sessionId === "string" &&
    !("type" in msg)
  );
}

/**
 * Map an upstream event to a client message or action.
 */
export function mapUpstreamEvent(
  msg: UpstreamEvent
):
  | { kind: "send"; message: RelayServerMessage }
  | { kind: "fatal"; message: string }
  | { kind: "ignore" } {
  const type = msg.type;

  // Handle known types
  if (typeof type !== "string") {
    return { kind: "ignore" };
  }

  switch (type) {
    case "speechStart": {
      const turnId = msg.turnId;
      if (typeof turnId === "string") {
        return { kind: "send", message: { type: "turn_start", turnId } };
      }
      return { kind: "ignore" };
    }

    case "transcript": {
      const transcript = msg.transcript;
      const final = msg.final;
      if (typeof transcript !== "string") {
        return { kind: "ignore" };
      }
      // Final transcripts are ignored (ENDPOINTING mode uses speechComplete for turns)
      if (final === true) {
        return { kind: "ignore" };
      }
      // Non-final transcript: send as partial
      return { kind: "send", message: { type: "partial", text: transcript } };
    }

    case "speechComplete": {
      const turnId = msg.turnId;
      const transcript = msg.transcript;
      if (typeof turnId === "string" && typeof transcript === "string") {
        return { kind: "send", message: { type: "turn_complete", turnId, text: transcript } };
      }
      return { kind: "ignore" };
    }

    case "error": {
      // Never forward upstream error text to the browser
      return { kind: "fatal", message: "Transcription service error" };
    }

    case "speechEnd":
    case "audioProgress":
    case "speaker":
    default:
      // Ignore all other types (including unknown ones)
      return { kind: "ignore" };
  }
}
