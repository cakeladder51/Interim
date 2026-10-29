import { describe, it, expect, vi } from "vitest";
import { createTtsPlayer, TtsUnavailableError } from "../src/client/voice/tts-player";
import type { Playback } from "../src/client/voice/tts-player";

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

const buf = (n: number): ArrayBuffer => new Uint8Array([n]).buffer;

// Fakes with manually resolved promises. A fake fetch rejects with AbortError when its signal aborts,
// like the real fetch does.
function harness() {
  const fetches: { text: string; signal: AbortSignal; resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }[] = [];
  const plays: { bytes: ArrayBuffer; resolve: () => void; reject: (e: unknown) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const fallbacks: { text: string; resolve: () => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const speaking: boolean[] = [];
  const player = createTtsPlayer({
    fetchAudio: (text: string, signal: AbortSignal) => {
      const d = deferred<ArrayBuffer>();
      signal.addEventListener("abort", () => d.reject(new DOMException("Aborted", "AbortError")));
      fetches.push({ text, signal, resolve: d.resolve, reject: d.reject });
      return d.promise;
    },
    playAudio: (bytes: ArrayBuffer): Playback => {
      const d = deferred<void>();
      const stop = vi.fn();
      plays.push({ bytes, resolve: () => d.resolve(), reject: d.reject, stop });
      return { done: d.promise, stop };
    },
    speakFallback: (text: string): Playback => {
      const d = deferred<void>();
      const stop = vi.fn();
      fallbacks.push({ text, resolve: () => d.resolve(), stop });
      return { done: d.promise, stop };
    },
    onSpeakingChange: (s: boolean) => {
      speaking.push(s);
    },
  });
  return { player, fetches, plays, fallbacks, speaking };
}

describe("voice-tts-player", () => {
  describe("1. Prefetch", () => {
    it("starts three fetchAudio calls immediately", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.player.enqueue("Third.");
      // all three fetches start synchronously inside enqueue, before anything plays
      expect(h.fetches.map((f) => f.text)).toEqual(["First.", "Second.", "Third."]);
      expect(h.plays).toHaveLength(0);
    });

    it("plays items strictly in enqueue order, each after the previous done", async () => {
      const h = harness();
      const b = [buf(1), buf(2), buf(3)];
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.player.enqueue("Third.");
      // later items arrive first: nothing may play out of order
      h.fetches[2].resolve(b[2]);
      h.fetches[1].resolve(b[1]);
      await tick();
      expect(h.plays).toHaveLength(0);
      h.fetches[0].resolve(b[0]);
      await tick();
      expect(h.plays).toHaveLength(1);
      expect(h.plays[0].bytes).toBe(b[0]);
      await tick();
      expect(h.plays).toHaveLength(1); // item 2 waits for item 1's done
      h.plays[0].resolve();
      await tick();
      expect(h.plays).toHaveLength(2);
      expect(h.plays[1].bytes).toBe(b[1]);
      h.plays[1].resolve();
      await tick();
      expect(h.plays).toHaveLength(3);
      expect(h.plays[2].bytes).toBe(b[2]);
      h.plays[2].resolve();
      await tick();
      expect(h.fallbacks).toHaveLength(0);
      expect(h.player.mode()).toBe("provider");
    });
  });

  describe("2. Speaking changes", () => {
    it("calls onSpeakingChange on transitions", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      // speaking starts with the first item, including the wait for its audio
      expect(h.speaking).toEqual([true]);
      expect(h.player.speaking()).toBe(true);
      h.fetches[0].resolve(buf(1));
      h.fetches[1].resolve(buf(2));
      await tick();
      h.plays[0].resolve();
      await tick();
      expect(h.speaking).toEqual([true]);
      expect(h.player.speaking()).toBe(true);
      h.plays[1].resolve();
      await tick();
      expect(h.speaking).toEqual([true, false]);
      expect(h.player.speaking()).toBe(false);
      // a second burst
      h.player.enqueue("Third.");
      expect(h.speaking).toEqual([true, false, true]);
      h.fetches[2].resolve(buf(3));
      await tick();
      h.plays[2].resolve();
      await tick();
      expect(h.speaking).toEqual([true, false, true, false]);
    });
  });

  describe("3. 503 is sticky", () => {
    it("switches to fallback mode", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      expect(h.fetches).toHaveLength(2);
      h.fetches[0].reject(new TtsUnavailableError());
      await tick();
      expect(h.player.mode()).toBe("fallback");
      // item 2 was already fetching: its fetch is aborted
      expect(h.fetches[1].signal.aborted).toBe(true);
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First."]);
      h.fallbacks[0].resolve();
      await tick();
      // item 2 is spoken via the fallback, never via playAudio
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First.", "Second."]);
      expect(h.plays).toHaveLength(0);
      // a later enqueue doesn't fetch
      h.player.enqueue("Third.");
      expect(h.fetches).toHaveLength(2);
      h.fallbacks[1].resolve();
      await tick();
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First.", "Second.", "Third."]);
      h.fallbacks[2].resolve();
      await tick();
      expect(h.speaking).toEqual([true, false]);
      expect(h.player.mode()).toBe("fallback");
    });

    it("TtsUnavailableError has its name", () => {
      const err = new TtsUnavailableError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("TtsUnavailableError");
    });
  });

  describe("4. One failure isn't sticky", () => {
    it("stays in provider mode", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.fetches[0].reject(new Error("tts 500"));
      await tick();
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First."]);
      expect(h.fetches[1].signal.aborted).toBe(false);
      const b2 = buf(2);
      h.fetches[1].resolve(b2);
      h.fallbacks[0].resolve();
      await tick();
      expect(h.plays).toHaveLength(1);
      expect(h.plays[0].bytes).toBe(b2);
      expect(h.player.mode()).toBe("provider");
    });
  });

  describe("5. Two consecutive failures", () => {
    it("switches to fallback mode", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.player.enqueue("Third.");
      // failure 1: fetch error
      h.fetches[0].reject(new Error("tts 500"));
      await tick();
      expect(h.player.mode()).toBe("provider");
      h.fallbacks[0].resolve();
      h.fetches[1].resolve(buf(2));
      await tick();
      expect(h.plays).toHaveLength(1);
      // failure 2: playback done rejects -> item 2 is spoken via the fallback, and the mode becomes sticky
      h.plays[0].reject(new Error("decode failed"));
      await tick();
      expect(h.player.mode()).toBe("fallback");
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First.", "Second."]);
      expect(h.fetches[2].signal.aborted).toBe(true);
      h.fallbacks[1].resolve();
      await tick();
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First.", "Second.", "Third."]);
      expect(h.plays).toHaveLength(1);
    });
  });

  describe("6. Success resets counter", () => {
    it("stays in provider mode with fail, success, fail", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.player.enqueue("Third.");
      h.fetches[0].reject(new Error("fail 1"));
      await tick();
      h.fallbacks[0].resolve();
      h.fetches[1].resolve(buf(2));
      await tick();
      h.plays[0].resolve(); // success
      await tick();
      h.fetches[2].reject(new Error("fail 2"));
      await tick();
      expect(h.player.mode()).toBe("provider");
      expect(h.fallbacks.map((f) => f.text)).toEqual(["First.", "Third."]);
      h.fallbacks[1].resolve();
      await tick();
      expect(h.speaking).toEqual([true, false]);
    });
  });

  describe("7. stop()", () => {
    it("stops playback and aborts pending fetches", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.enqueue("Second.");
      h.player.enqueue("Third.");
      h.fetches[0].resolve(buf(1));
      await tick();
      expect(h.plays).toHaveLength(1);
      h.player.stop();
      expect(h.plays[0].stop).toHaveBeenCalledTimes(1);
      expect(h.fetches[1].signal.aborted).toBe(true);
      expect(h.fetches[2].signal.aborted).toBe(true);
      expect(h.speaking).toEqual([true, false]);
      expect(h.player.speaking()).toBe(false);
      // old promises settling afterwards change nothing
      h.plays[0].resolve();
      await tick();
      expect(h.plays).toHaveLength(1);
      expect(h.fallbacks).toHaveLength(0);
      expect(h.speaking).toEqual([true, false]);
      // aborted fetches are not failures
      expect(h.player.mode()).toBe("provider");
    });

    it("aborts the fetch of the item that is waiting for its audio", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.player.stop();
      expect(h.fetches[0].signal.aborted).toBe(true);
      await tick();
      expect(h.plays).toHaveLength(0);
      expect(h.fallbacks).toHaveLength(0);
      expect(h.speaking).toEqual([true, false]);
      expect(h.player.mode()).toBe("provider");
      // the player still works after stop()
      h.player.enqueue("Again.");
      expect(h.fetches).toHaveLength(2);
      expect(h.speaking).toEqual([true, false, true]);
      h.fetches[1].resolve(buf(5));
      await tick();
      expect(h.plays).toHaveLength(1);
      h.plays[0].resolve();
      await tick();
      expect(h.speaking).toEqual([true, false, true, false]);
    });

    it("stops a fallback playback", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.fetches[0].reject(new TtsUnavailableError());
      await tick();
      expect(h.fallbacks).toHaveLength(1);
      h.player.stop();
      expect(h.fallbacks[0].stop).toHaveBeenCalledTimes(1);
      expect(h.speaking).toEqual([true, false]);
    });

    it("doesn't call onSpeakingChange when idle", () => {
      const h = harness();
      h.player.stop();
      expect(h.speaking).toEqual([]);
    });
  });

  describe("8. Edge cases", () => {
    it("skips empty text", async () => {
      const h = harness();
      h.player.enqueue("   ");
      h.player.enqueue("");
      await tick();
      expect(h.fetches).toHaveLength(0);
      expect(h.plays).toHaveLength(0);
      expect(h.speaking).toEqual([]);
      expect(h.player.speaking()).toBe(false);
    });
  });

  describe("9. Stale results (review 2)", () => {
    it("audio that arrived just before stop() is never played", async () => {
      const h = harness();
      h.player.enqueue("First.");
      h.fetches[0].resolve(buf(1)); // resolved, but its continuation hasn't run yet
      h.player.stop();
      await tick();
      expect(h.plays).toHaveLength(0);
      expect(h.fallbacks).toHaveLength(0);
      expect(h.speaking).toEqual([true, false]);
      expect(h.player.mode()).toBe("provider");
    });
  });
});
