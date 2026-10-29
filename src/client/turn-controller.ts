import type { Move } from "@/contracts";
import type { BackgroundEvent } from "./interview-model";

export const PARTIAL_MIN_NEW_WORDS = 8;
export const PARTIAL_MAX_WAIT_MS = 3000;
export const SILENCE_FIRST_MS = 20_000;
export const SILENCE_REPEAT_MS = 10_000;
export const SILENCE_MAX_PROMPTS = 2;
export const CANVAS_IDLE_MS = 4000;
export const CANVAS_MAX_CHARS = 1_500_000;

/**
 * 32-bit FNV-1a hash over UTF-16 code units.
 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function words(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

export function createTurnController(deps: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  send: (event: BackgroundEvent) => boolean;
}): {
  setIdle(idle: boolean): void;
  activity(): void;
  partial(text: string): void;
  turnBoundary(): void;
  canvasChanged(getImage: () => string | null): void;
  settled(move: Move | null): void;
  dispose(): void;
} {
  // Common state
  let disposed = false;
  let idle = false;
  let busy = false;
  let lastKind: "partial" | "silence" | "canvas" | null = null;

  // Partial state
  let latest: string | null = null;
  let latestWords = 0;
  let sentWords = 0;
  let firstUnsentAt: number | null = null;
  let partialTimer: unknown = null;

  // Silence state
  let since: number | null = null;
  let silenceTimer: unknown = null;
  let prompts = 0;

  // Canvas state
  let getImage: (() => string | null) | null = null;
  let canvasTimer: unknown = null;
  let canvasDue = false;
  let lastHash: string | null = null;

  // T1: armSilence
  function armSilence(delay: number): void {
    deps.clearTimer(silenceTimer);
    silenceTimer = null;
    if (prompts >= SILENCE_MAX_PROMPTS) {
      return;
    }
    silenceTimer = deps.setTimer(onSilence, delay);
  }

  // T2: onSilence
  function onSilence(): void {
    silenceTimer = null;
    if (disposed || !idle || since === null) return;
    if (busy) {
      armSilence(SILENCE_REPEAT_MS);
      return;
    }
    const ms = Math.max(1, Math.round(deps.now() - since));
    if (deps.send({ type: "silence", ms })) {
      busy = true;
      lastKind = "silence";
    } else {
      armSilence(SILENCE_REPEAT_MS);
    }
  }

  // T3: flush
  function flush(): void {
    if (disposed || !idle || busy) return;

    // (a) Partial
    if (latest !== null && latestWords > sentWords) {
      const minNewReached = latestWords - sentWords >= PARTIAL_MIN_NEW_WORDS;
      const waitExpired = firstUnsentAt !== null && deps.now() - firstUnsentAt >= PARTIAL_MAX_WAIT_MS;
      if (minNewReached || waitExpired) {
        if (deps.send({ type: "partial", text: latest })) {
          busy = true;
          lastKind = "partial";
          sentWords = latestWords;
          firstUnsentAt = null;
          deps.clearTimer(partialTimer);
          partialTimer = null;
        }
        return;
      }
    }

    // (b) Canvas
    if (canvasDue && getImage !== null) {
      canvasDue = false;
      const image = getImage();
      if (image === null || image.length > CANVAS_MAX_CHARS) {
        return;
      }
      const h = hashString(image);
      if (h === lastHash) {
        return;
      }
      if (deps.send({ type: "canvas", image })) {
        busy = true;
        lastKind = "canvas";
        lastHash = h;
      } else {
        canvasDue = true;
      }
    }

    // (c) Silence is never sent from flush; only T2 sends it
  }

  // T4: setIdle
  function setIdle(v: boolean): void {
    if (disposed) return;
    if (v && !idle) {
      idle = true;
      since = deps.now();
      armSilence(SILENCE_FIRST_MS);
    } else if (!v && idle) {
      idle = false;
      deps.clearTimer(silenceTimer);
      silenceTimer = null;
      since = null;
    }
    if (idle) {
      flush();
    }
  }

  // T5: activity
  function activity(): void {
    if (disposed) return;
    prompts = 0;
    if (idle) {
      since = deps.now();
      armSilence(SILENCE_FIRST_MS);
    }
  }

  // T6: partial
  function handlePartial(text: string): void {
    if (disposed) return;
    const w = words(text);
    if (w < sentWords) {
      sentWords = 0;
    }
    latest = text;
    latestWords = w;
    activity();
    if (w > sentWords && firstUnsentAt === null) {
      firstUnsentAt = deps.now();
      deps.clearTimer(partialTimer);
      partialTimer = deps.setTimer(() => {
        partialTimer = null;
        flush();
      }, PARTIAL_MAX_WAIT_MS);
    }
    flush();
  }

  // T7: turnBoundary
  function turnBoundary(): void {
    if (disposed) return;
    latest = null;
    latestWords = 0;
    sentWords = 0;
    firstUnsentAt = null;
    deps.clearTimer(partialTimer);
    partialTimer = null;
    activity();
  }

  // T8: canvasChanged
  function canvasChanged(g: () => string | null): void {
    if (disposed) return;
    getImage = g;
    canvasDue = false;
    deps.clearTimer(canvasTimer);
    canvasTimer = deps.setTimer(() => {
      canvasTimer = null;
      canvasDue = true;
      flush();
    }, CANVAS_IDLE_MS);
    activity();
  }

  // T9: settled
  function settled(move: Move | null): void {
    if (disposed) return;
    if (!busy) return;
    busy = false;
    const spoke = move !== null && move.type !== "silent";
    if (lastKind === "silence" && spoke) {
      prompts++;
    }
    lastKind = null;
    if (idle) {
      if (spoke) {
        since = deps.now();
        armSilence(SILENCE_FIRST_MS);
      } else if (silenceTimer === null && since !== null) {
        armSilence(SILENCE_REPEAT_MS);
      }
      flush();
    }
  }

  // T10: dispose
  function dispose(): void {
    disposed = true;
    idle = false;
    deps.clearTimer(partialTimer);
    deps.clearTimer(silenceTimer);
    deps.clearTimer(canvasTimer);
    partialTimer = null;
    silenceTimer = null;
    canvasTimer = null;
  }

  return {
    setIdle,
    activity,
    partial: handlePartial,
    turnBoundary,
    canvasChanged,
    settled,
    dispose,
  };
}

export type TurnController = ReturnType<typeof createTurnController>;
