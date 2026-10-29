export class TtsUnavailableError extends Error {
  constructor() {
    super("TTS unavailable");
    this.name = "TtsUnavailableError";
  }
}

export interface Playback {
  done: Promise<void>;
  stop(): void;
}

export interface TtsPlayerDeps {
  fetchAudio(text: string, signal: AbortSignal): Promise<ArrayBuffer>;
  playAudio(bytes: ArrayBuffer): Playback;
  speakFallback(text: string): Playback;
  onSpeakingChange(speaking: boolean): void;
}

interface Item {
  text: string;
  ctrl: AbortController | null;
  audio: Promise<ArrayBuffer> | null;
}

export function createTtsPlayer(deps: TtsPlayerDeps): {
  enqueue(text: string): void;
  stop(): void;
  speaking(): boolean;
  mode(): "provider" | "fallback";
} {
  let queue: Item[] = [];
  let current: Item | null = null;
  let playback: Playback | null = null;
  let running = false;
  let speakingFlag = false;
  let fallback = false;
  let failures = 0;
  let gen = 0;

  function setSpeaking(v: boolean): void {
    if (v !== speakingFlag) {
      speakingFlag = v;
      deps.onSpeakingChange(v);
    }
  }

  function sticky(): void {
    fallback = true;
    for (const item of queue) {
      if (item.ctrl) {
        item.ctrl.abort();
        item.ctrl = null;
        item.audio = null;
      }
    }
  }

  function fail(err: unknown): void {
    if (err instanceof TtsUnavailableError) {
      sticky();
    } else {
      if (++failures >= 2) {
        sticky();
      }
    }
  }

  async function speakWithFallback(item: Item): Promise<void> {
    playback = deps.speakFallback(item.text);
    try {
      await playback.done;
    } catch {
      // ignore
    }
  }

  async function playItem(item: Item, g: number): Promise<void> {
    if (item.audio === null) {
      await speakWithFallback(item);
      return;
    }

    try {
      const bytes = await item.audio;
      if (g !== gen) return;
      playback = deps.playAudio(bytes);
      try {
        await playback.done;
        if (g === gen) {
          failures = 0;
        }
      } catch (err) {
        if (g !== gen) return;
        fail(err);
        await speakWithFallback(item);
      }
    } catch (err) {
      if (g !== gen) return;
      fail(err);
      await speakWithFallback(item);
    }
  }

  async function run(g: number): Promise<void> {
    running = true;
    setSpeaking(true);
    while (g === gen && queue.length > 0) {
      current = queue.shift()!;
      await playItem(current, g);
    }
    if (g === gen) {
      current = null;
      running = false;
      setSpeaking(false);
    }
  }

  function enqueue(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;

    const item: Item = { text: trimmed, ctrl: null, audio: null };
    if (!fallback) {
      item.ctrl = new AbortController();
      item.audio = deps.fetchAudio(trimmed, item.ctrl.signal);
      item.audio.catch(() => {}); // prevent unhandled rejection
    }

    queue.push(item);
    if (!running) {
      void run(gen);
    }
  }

  function stop(): void {
    gen++;
    if (current?.ctrl) {
      current.ctrl.abort();
    }
    for (const item of queue) {
      item.ctrl?.abort();
    }
    queue = [];
    current = null;
    playback?.stop();
    playback = null;
    running = false;
    setSpeaking(false);
  }

  function speaking(): boolean {
    return speakingFlag;
  }

  function mode(): "provider" | "fallback" {
    return fallback ? "fallback" : "provider";
  }

  return {
    enqueue,
    stop,
    speaking,
    mode,
  };
}
