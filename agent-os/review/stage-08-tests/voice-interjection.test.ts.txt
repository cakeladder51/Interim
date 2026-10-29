import { describe, it, expect, vi } from "vitest";
import { createVoiceController } from "../src/client/voice/voice-controller";
import type { MicHandle, VoiceSnapshot } from "../src/client/voice/voice-controller";
import type { RelayHandlers, RelayConnection } from "../src/client/voice/relay-client";
import type { InterviewAction } from "../src/client/interview-model";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConn() {
  return { sendAudio: vi.fn(), end: vi.fn(() => Promise.resolve()), close: vi.fn() };
}

function harness() {
  const mics: { onSamples: (s: Float32Array) => void; resolve: (m: MicHandle) => void; reject: (e: unknown) => void }[] = [];
  const connects: { handlers: RelayHandlers; resolve: (c: RelayConnection) => void; reject: (e: unknown) => void }[] = [];
  const fetches: { text: string; signal: AbortSignal; resolve: (b: ArrayBuffer) => void }[] = [];
  const plays: { resolve: () => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const snapshots: VoiceSnapshot[] = [];
  const turns: string[] = [];
  const startMic = vi.fn((onSamples: (s: Float32Array) => void) => {
    const d = deferred<MicHandle>();
    mics.push({ onSamples, resolve: d.resolve, reject: d.reject });
    return d.promise;
  });
  const connect = vi.fn((handlers: RelayHandlers) => {
    const d = deferred<RelayConnection>();
    connects.push({ handlers, resolve: d.resolve, reject: d.reject });
    return d.promise;
  });
  const c = createVoiceController({
    connect,
    startMic,
    tts: {
      fetchAudio: (text: string, signal: AbortSignal) => {
        const d = deferred<ArrayBuffer>();
        signal.addEventListener("abort", () => d.reject(new DOMException("Aborted", "AbortError")));
        fetches.push({ text, signal, resolve: d.resolve });
        return d.promise;
      },
      playAudio: () => {
        const d = deferred<void>();
        const stop = vi.fn(() => d.resolve());
        plays.push({ resolve: () => d.resolve(), stop });
        return { done: d.promise, stop };
      },
      speakFallback: () => ({ done: Promise.resolve(), stop: () => {} }),
    },
    onTurn: (t: string) => {
      turns.push(t);
    },
    onChange: (s: VoiceSnapshot) => {
      snapshots.push(s);
    },
  });
  return { c, startMic, connect, mics, connects, fetches, plays, snapshots, turns };
}

async function listening(h: ReturnType<typeof harness>) {
  const mic = { sampleRate: 48000, stop: vi.fn() };
  const conn = makeConn();
  h.c.enable();
  h.mics[h.mics.length - 1].resolve(mic);
  await tick();
  h.connects[h.connects.length - 1].resolve(conn);
  await tick();
  expect(h.c.snapshot().status).toBe("listening");
  return { mic, conn, handlers: h.connects[h.connects.length - 1].handlers };
}

async function startSpeech(h: ReturnType<typeof harness>, text: string) {
  h.c.speakNow(text);
  const f = h.fetches[h.fetches.length - 1];
  f.resolve(new Uint8Array([1]).buffer);
  await tick();
  expect(h.c.snapshot().speaking).toBe(true);
}

const W = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
const REALIGN = { type: "bg_move", move: { type: "realign", misconceptionId: "m1" } } as InterviewAction;
const HINT = { type: "bg_move", move: { type: "hint", rung: 0 } } as InterviewAction;
const SILENT = { type: "bg_move", move: { type: "silent" } } as InterviewAction;
const DONE = { type: "done", state: {} } as unknown as InterviewAction;
const REQUEST = { type: "request", request: {}, studentText: null } as unknown as InterviewAction;
const token = (text: string) => ({ type: "token", text }) as InterviewAction;

// Speak a background move's text the way the runner delivers it: tokens, then done; then start playback.
async function speakTokens(h: ReturnType<typeof harness>, text: string) {
  const before = h.fetches.length;
  h.c.handleInterviewAction(token(text));
  h.c.handleInterviewAction(DONE);
  await tick();
  expect(h.fetches.length).toBe(before + 1);
  h.fetches[h.fetches.length - 1].resolve(new Uint8Array([1]).buffer);
  await tick();
  expect(h.c.snapshot().speaking).toBe(true);
}

// A realign interjection that starts while the student's live caption has `n` words.
async function interjectAt(h: ReturnType<typeof harness>, handlers: RelayHandlers, n: number) {
  handlers.onPartial(W(n));
  await tick();
  expect(h.c.snapshot().speaking).toBe(false);
  h.c.handleInterviewAction(REALIGN);
  await speakTokens(h, "Hold on a second.");
}

describe("voice interjection", () => {
  it("1. Relaxed threshold: bg_move{realign} with 10-word partial, 13 words don't stop, 14 does", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await interjectAt(h, handlers, 10);

    handlers.onPartial(W(13));
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);

    handlers.onPartial(W(14));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
    expect(h.plays[h.plays.length - 1].stop).toHaveBeenCalled();
  });

  it("2. New relay turn resets baseline", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await interjectAt(h, handlers, 10);

    handlers.onTurnStart("turn1");
    await tick();

    handlers.onPartial(W(3));
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);

    handlers.onPartial(W(4));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("3. Suppression lifted: bg_move{realign} enqueues speech", async () => {
    const h = harness();
    await listening(h);
    h.c.stopSpeaking();
    // Suppressed: a normal reply's tokens are not spoken.
    h.c.handleInterviewAction(token("Not spoken."));
    h.c.handleInterviewAction(DONE);
    await tick();
    expect(h.fetches).toHaveLength(0);

    h.c.handleInterviewAction(REALIGN);
    h.c.handleInterviewAction(token("Hello."));
    h.c.handleInterviewAction(DONE);
    await tick();
    expect(h.fetches.map((f) => f.text)).toEqual(["Hello."]);
  });

  it("4. bg_move{silent} doesn't stop current speech and doesn't lift suppression", async () => {
    const h = harness();
    await listening(h);
    await startSpeech(h, "Speaking.");

    h.c.handleInterviewAction(SILENT);
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);
    expect(h.plays[0].stop).not.toHaveBeenCalled();

    h.c.stopSpeaking();
    await tick();
    h.c.handleInterviewAction(SILENT);
    h.c.handleInterviewAction(token("Still suppressed."));
    h.c.handleInterviewAction(DONE);
    await tick();
    expect(h.fetches.map((f) => f.text)).toEqual(["Speaking."]);
  });

  it("5. bg_move{hint} uses normal threshold (2 words stops)", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    handlers.onPartial(W(10));
    await tick();
    // A realign first, then a hint: the hint must clear interjection mode, not keep or set a baseline.
    h.c.handleInterviewAction(REALIGN);
    h.c.handleInterviewAction(HINT);
    await speakTokens(h, "Here is a hint.");

    handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("6. Next request clears interjection mode: 2-word partial stops TTS", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await interjectAt(h, handlers, 10);

    h.c.handleInterviewAction(REQUEST);
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);

    await startSpeech(h, "Next question.");
    handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("7. bg_failed resets chunker: token then bg_failed then done speaks nothing", async () => {
    const h = harness();
    await listening(h);

    h.c.handleInterviewAction(token("Hello wor"));
    h.c.handleInterviewAction({ type: "bg_failed" } as InterviewAction);
    h.c.handleInterviewAction(DONE);
    await tick();

    expect(h.fetches).toHaveLength(0);
  });

  it("8. bg_request doesn't stop current speech", async () => {
    const h = harness();
    await listening(h);
    await startSpeech(h, "Speaking.");

    h.c.handleInterviewAction({ type: "bg_request", request: {} } as unknown as InterviewAction);
    await tick();

    expect(h.c.snapshot().speaking).toBe(true);
    expect(h.plays[0].stop).not.toHaveBeenCalled();
  });

  it("9. Stale guard: session 1 onTurnStart ignored when session 2 active", async () => {
    const h = harness();
    const s1 = await listening(h);
    h.c.disable();
    await tick();
    const s2 = await listening(h);
    expect(s2.handlers).not.toBe(s1.handlers);

    await interjectAt(h, s2.handlers, 10);

    s1.handlers.onTurnStart("stale-turn");
    await tick();

    s2.handlers.onPartial(W(13));
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);

    s2.handlers.onPartial(W(14));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("10. bg_move{realign} stops current speech and resets the chunker", async () => {
    const h = harness();
    await listening(h);
    await startSpeech(h, "Speaking.");

    h.c.handleInterviewAction(token("Leftover"));
    h.c.handleInterviewAction(REALIGN);
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
    expect(h.plays[0].stop).toHaveBeenCalled();

    h.c.handleInterviewAction(token("Wait."));
    h.c.handleInterviewAction(DONE);
    await tick();
    expect(h.fetches.map((f) => f.text)).toEqual(["Speaking.", "Wait."]);
  });

  it("11. bg_failed clears interjection mode", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    handlers.onPartial(W(10));
    await tick();
    h.c.handleInterviewAction(REALIGN);
    h.c.handleInterviewAction({ type: "bg_failed" } as InterviewAction);

    await startSpeech(h, "Something else.");
    handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("12. onTurnComplete resets the baseline to 0", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await interjectAt(h, handlers, 10);

    handlers.onTurnComplete("t1", W(10));
    await tick();
    expect(h.turns).toEqual([W(10)]);

    handlers.onPartial(W(3));
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);

    handlers.onPartial(W(4));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("13. Stale guard: session 1 onTurnComplete ignored when session 2 active", async () => {
    const h = harness();
    const s1 = await listening(h);
    h.c.disable();
    await tick();
    const s2 = await listening(h);
    await interjectAt(h, s2.handlers, 10);

    s1.handlers.onTurnComplete("stale", "stale words");
    await tick();
    expect(h.turns).toEqual([]);

    s2.handlers.onPartial(W(13));
    await tick();
    expect(h.c.snapshot().speaking).toBe(true);
  });

  it("14. onTurnStart outside interjection mode keeps the normal threshold", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await startSpeech(h, "Normal reply.");

    handlers.onTurnStart("t1");
    handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("15. barge-in during an interjection ends interjection mode", async () => {
    const h = harness();
    const { handlers } = await listening(h);
    await interjectAt(h, handlers, 10);

    handlers.onPartial(W(14));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);

    await startSpeech(h, "Go on.");
    handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });

  it("16. disable() ends interjection mode", async () => {
    const h = harness();
    const s1 = await listening(h);
    s1.handlers.onPartial(W(10));
    await tick();
    h.c.handleInterviewAction(REALIGN);
    h.c.disable();
    await tick();

    const s2 = await listening(h);
    await startSpeech(h, "Welcome back.");
    s2.handlers.onPartial(W(2));
    await tick();
    expect(h.c.snapshot().speaking).toBe(false);
  });
});
