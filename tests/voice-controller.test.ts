import { describe, it, expect, vi } from "vitest";
import {
  createVoiceController,
  VOICE_MESSAGES,
  BARGE_IN_MIN_WORDS,
  queueVoiceTurn,
} from "../src/client/voice/voice-controller";
import type { MicHandle, VoiceSnapshot } from "../src/client/voice/voice-controller";
import { RelayConnectError } from "../src/client/voice/relay-client";
import type { RelayHandlers, RelayConnection } from "../src/client/voice/relay-client";
import type { InterviewAction } from "../src/client/interview-model";

// Drains every pending microtask (no timers are used in this file).
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

const request = { type: "request", request: {}, studentText: null } as unknown as InterviewAction;
const token = (text: string) => ({ type: "token", text }) as InterviewAction;
const done = { type: "done", state: {} } as unknown as InterviewAction;
const failed = { type: "failed", message: "x", retryable: true } as InterviewAction;

function makeConn() {
  return { sendAudio: vi.fn(), end: vi.fn(() => Promise.resolve()), close: vi.fn() };
}

// Fake connect / startMic / TTS deps with manually resolved promises.
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

// enable() → mic (48 kHz) → connect → listening
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

// Speaks one sentence and waits until its audio is playing.
async function startSpeech(h: ReturnType<typeof harness>, text: string) {
  h.c.speakNow(text);
  const f = h.fetches[h.fetches.length - 1];
  f.resolve(new Uint8Array([1]).buffer);
  await tick();
  expect(h.c.snapshot().speaking).toBe(true);
  return h.plays[h.plays.length - 1];
}

describe("voice-controller", () => {
  describe("0. Constants", () => {
    it("messages and barge-in threshold are exact", () => {
      expect(VOICE_MESSAGES).toEqual({
        mic: "Microphone unavailable. You can keep typing your answers.",
        relay: "Voice input is unavailable right now. You can keep typing your answers.",
        busy: "Voice input is busy right now. You can keep typing your answers.",
        dropped: "Voice input disconnected. You can keep typing your answers.",
      });
      expect(BARGE_IN_MIN_WORDS).toBe(2);
    });
  });

  describe("1. Happy path", () => {
    it("transitions through starting to listening", async () => {
      const h = harness();
      expect(h.c.snapshot()).toEqual({ status: "off", message: null, partial: null, speaking: false });
      h.c.enable();
      // startMic runs synchronously inside enable (the click gesture)
      expect(h.startMic).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("starting");
      h.mics[0].resolve({ sampleRate: 48000, stop: vi.fn() });
      await tick();
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("starting");
      h.connects[0].resolve(makeConn());
      await tick();
      expect(h.c.snapshot()).toEqual({ status: "listening", message: null, partial: null, speaking: false });
      expect(h.snapshots.map((s) => s.status)).toEqual(["starting", "listening"]);
    });

    it("enable() is a no-op while starting or listening", async () => {
      const h = harness();
      h.c.enable();
      h.c.enable();
      expect(h.startMic).toHaveBeenCalledTimes(1);
      await listening(h).catch(() => {}); // resolves the pending mic + connect
      h.c.enable();
      expect(h.startMic).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. Audio", () => {
    it("sends encoded audio after listening", async () => {
      const h = harness();
      const { conn, mic } = await listening(h);
      void mic;
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5));
      expect(conn.sendAudio).toHaveBeenCalledTimes(1);
      const frame = conn.sendAudio.mock.calls[0][0] as Uint8Array;
      expect(frame.length).toBe(3200);
      expect(Array.from(frame.subarray(0, 4))).toEqual([0x00, 0x40, 0x00, 0x40]);
      expect(frame.every((b, i) => b === (i % 2 === 0 ? 0x00 : 0x40))).toBe(true);
    });

    it("does not send audio before listening", async () => {
      const h = harness();
      h.c.enable();
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5)); // before the mic resolves
      h.mics[0].resolve({ sampleRate: 48000, stop: vi.fn() });
      await tick();
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5)); // mic ready, relay still connecting
      const conn = makeConn();
      h.connects[0].resolve(conn);
      await tick();
      expect(conn.sendAudio).not.toHaveBeenCalled();
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5));
      expect(conn.sendAudio).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Mic failure", () => {
    it("sets unavailable with mic message", async () => {
      const h = harness();
      h.c.enable();
      h.mics[0].reject(new Error("NotAllowedError"));
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "unavailable", message: VOICE_MESSAGES.mic });
      expect(h.connect).not.toHaveBeenCalled();
      // enabling again clears the message and retries the mic
      h.c.enable();
      expect(h.c.snapshot()).toMatchObject({ status: "starting", message: null });
      expect(h.startMic).toHaveBeenCalledTimes(2);
    });

    it("handles unsupported sample rate", async () => {
      const h = harness();
      const mic = { sampleRate: 8000, stop: vi.fn() };
      h.c.enable();
      h.mics[0].resolve(mic);
      await tick();
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "unavailable", message: VOICE_MESSAGES.mic });
      expect(mic.stop).toHaveBeenCalledTimes(1);
      expect(h.connect).not.toHaveBeenCalled();
    });
  });

  describe("4. Relay failure", () => {
    it("sets unavailable with busy message", async () => {
      const h = harness();
      const mic = { sampleRate: 48000, stop: vi.fn() };
      h.c.enable();
      h.mics[0].resolve(mic);
      await tick();
      h.connects[0].reject(new RelayConnectError("busy", 1013));
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "unavailable", message: VOICE_MESSAGES.busy });
      expect(mic.stop).toHaveBeenCalledTimes(1);
    });

    it("sets unavailable with relay message for other errors", async () => {
      const h = harness();
      const mic = { sampleRate: 48000, stop: vi.fn() };
      h.c.enable();
      h.mics[0].resolve(mic);
      await tick();
      h.connects[0].reject(new RelayConnectError("unavailable", null));
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "unavailable", message: VOICE_MESSAGES.relay });
      expect(mic.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("5. Partials and turns", () => {
    it("sets partial and calls onTurn", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      handlers.onPartial("I think");
      expect(h.c.snapshot().partial).toBe("I think");
      handlers.onTurnComplete("t1", "  I think it is two ");
      expect(h.turns).toEqual(["I think it is two"]);
      expect(h.c.snapshot().partial).toBeNull();
    });

    it("does not call onTurn for empty/whitespace", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      handlers.onPartial("um");
      handlers.onTurnComplete("t1", "   ");
      handlers.onTurnComplete("t2", "");
      expect(h.turns).toEqual([]);
      expect(h.c.snapshot().partial).toBeNull();
    });
  });

  describe("6. Barge-in", () => {
    it("stops TTS on enough words", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      const play = await startSpeech(h, "Hello there.");
      handlers.onPartial("wait");
      expect(play.stop).not.toHaveBeenCalled();
      expect(h.c.snapshot().speaking).toBe(true);
      handlers.onPartial("wait no");
      expect(play.stop).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().speaking).toBe(false);
      // suppressed until the next request
      h.c.handleInterviewAction(token("More words. And"));
      h.c.handleInterviewAction(token(" more."));
      h.c.handleInterviewAction(done);
      expect(h.fetches.map((f) => f.text)).toEqual(["Hello there."]);
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Next one. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["Hello there.", "Next one."]);
    });

    it("partials while the interviewer is silent don't suppress speech", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      handlers.onPartial("I think it is two");
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Good. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["Good."]);
    });
  });

  describe("7. Reconnect", () => {
    it("reconnects on unexpected close", async () => {
      const h = harness();
      const { mic, conn, handlers } = await listening(h);
      handlers.onPartial("I th");
      handlers.onClose({ code: 4502, intentional: false });
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "reconnecting", partial: null });
      expect(h.connect).toHaveBeenCalledTimes(2);
      // audio is dropped while reconnecting
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5));
      expect(conn.sendAudio).not.toHaveBeenCalled();
      const conn2 = makeConn();
      h.connects[1].resolve(conn2);
      await tick();
      expect(h.c.snapshot().status).toBe("listening");
      expect(mic.stop).not.toHaveBeenCalled();
      h.mics[0].onSamples(new Float32Array(4800).fill(0.5));
      expect(conn2.sendAudio).toHaveBeenCalledTimes(1);
      expect(conn.sendAudio).not.toHaveBeenCalled();
      // a later unexpected close gets its own single attempt
      h.connects[1].handlers.onClose({ code: 4502, intentional: false });
      await tick();
      expect(h.connect).toHaveBeenCalledTimes(3);
      expect(h.c.snapshot().status).toBe("reconnecting");
    });

    it("stops mic on failed reconnect", async () => {
      const h = harness();
      const { mic, handlers } = await listening(h);
      handlers.onClose({ code: 4502, intentional: false });
      await tick();
      h.connects[1].reject(new RelayConnectError("unavailable", null));
      await tick();
      expect(h.c.snapshot()).toMatchObject({ status: "unavailable", message: VOICE_MESSAGES.dropped });
      expect(mic.stop).toHaveBeenCalledTimes(1);
      expect(h.connect).toHaveBeenCalledTimes(2);
    });

    it("doesn't reconnect on intentional close", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      handlers.onClose({ code: 1000, intentional: true });
      await tick();
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).not.toBe("reconnecting");
    });

    it("doesn't reconnect after disable", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      h.c.disable();
      handlers.onClose({ code: 4502, intentional: false });
      await tick();
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("off");
    });
  });

  describe("8. disable()", () => {
    it("stops everything", async () => {
      const h = harness();
      const { mic, conn, handlers } = await listening(h);
      const play = await startSpeech(h, "Hello there.");
      handlers.onPartial("I");
      h.c.disable();
      expect(h.c.snapshot()).toEqual({ status: "off", message: null, partial: null, speaking: false });
      expect(mic.stop).toHaveBeenCalledTimes(1);
      expect(conn.end).toHaveBeenCalledTimes(1);
      expect(play.stop).toHaveBeenCalledTimes(1);
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Later words. "));
      h.c.handleInterviewAction(done);
      expect(h.fetches).toHaveLength(1);
    });

    it("disable() while already off emits no snapshot", () => {
      // onChange fires only on a real change; otherwise InterviewScreen's "ended → disable()" effect re-renders forever
      const h = harness();
      h.c.disable();
      h.c.disable();
      expect(h.snapshots).toEqual([]);
      expect(h.c.snapshot()).toEqual({ status: "off", message: null, partial: null, speaking: false });
    });

    it("catches a rejected end()", async () => {
      const h = harness();
      const { conn } = await listening(h);
      conn.end.mockImplementation(() => Promise.reject(new Error("socket gone")));
      h.c.disable();
      await tick();
      expect(conn.end).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("off");
    });
  });

  describe("9. Generation guard", () => {
    it("stops late-starting mic", async () => {
      const h = harness();
      const mic = { sampleRate: 48000, stop: vi.fn() };
      h.c.enable();
      h.c.disable();
      h.mics[0].resolve(mic);
      await tick();
      expect(mic.stop).toHaveBeenCalledTimes(1);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.c.snapshot().status).toBe("off");
    });

    it("closes late-resolving connection", async () => {
      const h = harness();
      const mic = { sampleRate: 48000, stop: vi.fn() };
      h.c.enable();
      h.mics[0].resolve(mic);
      await tick();
      h.c.disable();
      expect(mic.stop).toHaveBeenCalledTimes(1);
      const conn = makeConn();
      h.connects[0].resolve(conn);
      await tick();
      expect(conn.close).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("off");
    });

    it("enable, disable, enable: only the second attempt proceeds", async () => {
      const h = harness();
      const mic1 = { sampleRate: 48000, stop: vi.fn() };
      const mic2 = { sampleRate: 48000, stop: vi.fn() };
      h.c.enable();
      h.c.disable();
      h.c.enable();
      expect(h.startMic).toHaveBeenCalledTimes(2);
      h.mics[0].resolve(mic1);
      h.mics[1].resolve(mic2);
      await tick();
      expect(mic1.stop).toHaveBeenCalledTimes(1);
      expect(mic2.stop).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledTimes(1);
      h.connects[0].resolve(makeConn());
      await tick();
      expect(h.c.snapshot().status).toBe("listening");
    });

    it("ignores every call after dispose", async () => {
      const h = harness();
      const { mic, conn } = await listening(h);
      h.c.dispose();
      expect(mic.stop).toHaveBeenCalledTimes(1);
      expect(conn.end).toHaveBeenCalledTimes(1);
      h.c.enable();
      h.c.speakNow("Hello.");
      expect(h.startMic).toHaveBeenCalledTimes(1);
      expect(h.fetches).toHaveLength(0);
      expect(h.c.snapshot().status).toBe("off");
    });
  });

  describe("10. Speech from actions", () => {
    it("enqueues chunks from token/done actions", async () => {
      const h = harness();
      await listening(h);
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Good. Now"));
      h.c.handleInterviewAction(token(" tell me"));
      h.c.handleInterviewAction(token(" why."));
      h.c.handleInterviewAction(done);
      expect(h.fetches.map((f) => f.text)).toEqual(["Good.", "Now tell me why."]);
    });

    it("ignores actions when off", async () => {
      const h = harness();
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Good. Now"));
      h.c.handleInterviewAction(token(" tell me why."));
      h.c.handleInterviewAction(done);
      h.c.speakNow("Hello there.");
      await tick();
      expect(h.fetches).toHaveLength(0);
      expect(h.startMic).not.toHaveBeenCalled();
    });

    it("speakNow enqueues immediate text", async () => {
      const h = harness();
      await listening(h);
      h.c.speakNow("First. Second");
      expect(h.fetches.map((f) => f.text)).toEqual(["First.", "Second"]);
    });

    it("stopSpeaking suppresses speech until the next request", async () => {
      const h = harness();
      await listening(h);
      const play = await startSpeech(h, "One.");
      h.c.stopSpeaking();
      expect(play.stop).toHaveBeenCalledTimes(1);
      h.c.handleInterviewAction(token("Two. "));
      h.c.handleInterviewAction(done);
      expect(h.fetches.map((f) => f.text)).toEqual(["One."]);
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Three. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["One.", "Three."]);
    });

    it("request stops current speech; failed resets the chunker", async () => {
      const h = harness();
      await listening(h);
      const play = await startSpeech(h, "One.");
      h.c.handleInterviewAction(request);
      expect(play.stop).toHaveBeenCalledTimes(1);
      h.c.handleInterviewAction(token("Half a sen"));
      h.c.handleInterviewAction(failed);
      h.c.handleInterviewAction(token("tence. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["One.", "tence."]);
    });

    it("speaks while unavailable (typing mode keeps interviewer speech)", async () => {
      const h = harness();
      h.c.enable();
      h.mics[0].reject(new Error("denied"));
      await tick();
      expect(h.c.snapshot().status).toBe("unavailable");
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Still here. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["Still here."]);
    });
  });

  describe("11. queueVoiceTurn", () => {
    it("queues turns correctly", () => {
      expect(queueVoiceTurn(null, " a ")).toBe("a");
      expect(queueVoiceTurn("a", "b ")).toBe("a b");
    });
  });

  describe("12. Stale events and suppression edges (review 2)", () => {
    it("events from a disabled session are ignored", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      h.c.disable();
      const before = h.snapshots.length;
      handlers.onPartial("late words here");
      handlers.onTurnComplete("t9", "late turn");
      expect(h.turns).toEqual([]);
      expect(h.c.snapshot().partial).toBeNull();
      expect(h.snapshots).toHaveLength(before);
    });

    it("a close from an earlier session doesn't reconnect the new one", async () => {
      const h = harness();
      const first = await listening(h);
      h.c.disable();
      await listening(h);
      first.handlers.onClose({ code: 4502, intentional: false });
      await tick();
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.c.snapshot().status).toBe("listening");
    });

    it("a reconnect that resolves after disable is closed", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      handlers.onClose({ code: 4502, intentional: false });
      await tick();
      h.c.disable();
      const conn2 = makeConn();
      h.connects[1].resolve(conn2);
      await tick();
      expect(conn2.close).toHaveBeenCalledTimes(1);
      expect(h.c.snapshot().status).toBe("off");
    });

    it("a partial while the interviewer is silent doesn't suppress the reply being streamed", async () => {
      const h = harness();
      const { handlers } = await listening(h);
      h.c.handleInterviewAction(request);
      handlers.onPartial("I think it is two");
      h.c.handleInterviewAction(token("Good. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["Good."]);
    });

    it("done after disable doesn't speak the leftover text", async () => {
      const h = harness();
      await listening(h);
      h.c.handleInterviewAction(request);
      h.c.handleInterviewAction(token("Good. Now tell"));
      expect(h.fetches.map((f) => f.text)).toEqual(["Good."]);
      h.c.disable();
      h.c.handleInterviewAction(done);
      await tick();
      expect(h.fetches.map((f) => f.text)).toEqual(["Good."]);
    });

    it("speakNow lifts a stopSpeaking suppression", async () => {
      const h = harness();
      await listening(h);
      h.c.stopSpeaking();
      h.c.speakNow("Again.");
      h.c.handleInterviewAction(token("More. "));
      expect(h.fetches.map((f) => f.text)).toEqual(["Again.", "More."]);
    });
  });
});
