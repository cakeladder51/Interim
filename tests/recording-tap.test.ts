// Stage 10 reviewer-supplied tests. Copy byte-identical to tests/recording-tap.test.ts; do not edit.
import { describe, it, expect, vi, afterEach } from "vitest";

class FakeNode {
  constructor(readonly name: string) {}
}
class FakeSource extends FakeNode {
  connected: FakeNode[] = [];
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(node: FakeNode): void { this.connected.push(node); }
  start(): void {}
  stop(): void {}
}
const sources: FakeSource[] = [];
class FakeAudioContext {
  state = "running";
  destination = new FakeNode("destination");
  resume(): Promise<void> { return Promise.resolve(); }
  decodeAudioData(): Promise<unknown> { return Promise.resolve({}); }
  createBufferSource(): FakeSource { const s = new FakeSource("source"); sources.push(s); return s; }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  sources.length = 0;
});

async function load() {
  vi.resetModules();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return import("@/client/voice/browser-audio");
}

describe("browser-audio playback tap (Stage 10)", () => {
  it("without a tap, TTS audio goes to the speakers only", async () => {
    const audio = await load();
    audio.playAudioBuffer(new ArrayBuffer(8));
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].connected.map((n) => n.name)).toEqual(["destination"]);
  });

  it("with a tap, TTS audio goes to the speakers and then the tap; clearing it stops the copy", async () => {
    const audio = await load();
    const tap = new FakeNode("tap");
    audio.setPlaybackTap(tap as unknown as AudioNode);
    audio.playAudioBuffer(new ArrayBuffer(8));
    await flush();
    expect(sources[0].connected.map((n) => n.name)).toEqual(["destination", "tap"]);
    audio.setPlaybackTap(null);
    audio.playAudioBuffer(new ArrayBuffer(8));
    await flush();
    expect(sources[1].connected.map((n) => n.name)).toEqual(["destination"]);
  });
});
