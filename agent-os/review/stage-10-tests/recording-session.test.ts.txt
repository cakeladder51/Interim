// Stage 10 reviewer-supplied tests. Copy byte-identical to tests/recording-session.test.ts; do not edit.
import { describe, it, expect } from "vitest";
import {
  createRecordingSession,
  NOTICE,
  RECORDER_TIMESLICE_MS,
  type RecorderLike,
  type RecordingDeps,
  type RecordingKind,
  type StreamLike,
  type TrackLike,
  type BlobEventLike,
} from "@/client/recording/recording-session";

class FakeTrack implements TrackLike {
  stopped = 0;
  private ended: (() => void)[] = [];
  constructor(readonly kind: string) {}
  stop(): void { this.stopped++; }
  addEventListener(_type: "ended", listener: () => void): void { this.ended.push(listener); }
  fireEnded(): void { for (const l of this.ended) l(); }
}
class FakeStream implements StreamLike {
  constructor(readonly name: string, readonly tracks: FakeTrack[]) {}
  getTracks(): TrackLike[] { return this.tracks; }
}
class FakeRecorder implements RecorderLike {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: BlobEventLike) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  startedWith: number | null = null;
  stopCalls = 0;
  finalBytes = 0;
  constructor(readonly stream: StreamLike, readonly kind: RecordingKind, readonly mimeType: string) {}
  start(timesliceMs: number): void { this.state = "recording"; this.startedWith = timesliceMs; }
  stop(): void {
    this.stopCalls++;
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      if (this.finalBytes > 0) this.emit(this.finalBytes);
      this.onstop?.();
    });
  }
  emit(bytes: number): void { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const NOW = Date.UTC(2026, 9, 29, 14, 5, 59);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(opts: { mime?: Partial<Record<RecordingKind, string>>; throwOn?: RecordingKind; micThrowsSync?: boolean; finalBytes?: number } = {}) {
  const log: string[] = [];
  const mic = deferred<StreamLike>();
  const tab = deferred<StreamLike>();
  const micStream = new FakeStream("mic", [new FakeTrack("audio")]);
  const tabStream = new FakeStream("tab", [new FakeTrack("video")]);
  const mixStream = new FakeStream("mix", [new FakeTrack("audio")]);
  const combined = new FakeStream("combined", []);
  const recorders: Partial<Record<RecordingKind, FakeRecorder>> = {};
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  let mixerDisposed = 0;
  let mixerInput: StreamLike | null | undefined;
  const deps: RecordingDeps = {
    getMic: () => {
      log.push("getMic");
      if (opts.micThrowsSync) throw new Error("no mediaDevices");
      return mic.promise;
    },
    getTab: () => { log.push("getTab"); return tab.promise; },
    createMixer: (m) => {
      log.push(`createMixer(${m === null ? "null" : (m as FakeStream).name})`);
      mixerInput = m;
      return { stream: mixStream, dispose: () => { mixerDisposed++; } };
    },
    combine: (t, a) => { log.push(`combine(${(t as FakeStream).name},${(a as FakeStream).name})`); return combined; },
    createRecorder: (stream, kind) => {
      log.push(`createRecorder(${kind},${(stream as FakeStream).name})`);
      if (opts.throwOn === kind) throw new Error("unsupported");
      const r = new FakeRecorder(stream, kind, opts.mime?.[kind] ?? (kind === "audio" ? "audio/webm;codecs=opus" : "video/webm;codecs=vp9,opus"));
      r.finalBytes = opts.finalBytes ?? 0;
      recorders[kind] = r;
      return r;
    },
    createObjectURL: (blob) => { blobs.push(blob); return `blob:${blobs.length}`; },
    revokeObjectURL: (url) => { revoked.push(url); },
    now: () => NOW,
  };
  const session = createRecordingSession(deps);
  let emits = 0;
  session.subscribe(() => { emits++; });
  return {
    log, mic, tab, micStream, tabStream, mixStream, combined, recorders, blobs, revoked, session,
    get emits() { return emits; },
    get mixerDisposed() { return mixerDisposed; },
    get mixerInput() { return mixerInput; },
    grantAll() { mic.resolve(micStream); tab.resolve(tabStream); },
  };
}

describe("recording session: start", () => {
  it("S1: nothing chosen calls nothing and stays idle", async () => {
    const h = harness();
    await h.session.start({ audio: false, video: false });
    expect(h.log).toEqual([]);
    expect(h.session.snapshot()).toEqual({ phase: "idle", audio: "off", video: "off", files: [], notices: [] });
    expect(await h.session.finish()).toEqual([]);
    expect(h.session.snapshot().phase).toBe("finished");
  });

  it("S2: both permission requests are made synchronously, tab first, before any await", () => {
    const h = harness();
    void h.session.start({ audio: true, video: true });
    expect(h.log).toEqual(["getTab", "getMic"]);
    expect(h.session.snapshot()).toEqual({ phase: "starting", audio: "starting", video: "starting", files: [], notices: [] });
  });

  it("S2: audio and video granted: one mixer from the mic, audio on the mix, video on tab + mix", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    h.grantAll();
    await p;
    expect(h.log).toEqual(["getTab", "getMic", "createMixer(mic)", "createRecorder(audio,mix)", "combine(tab,mix)", "createRecorder(video,combined)"]);
    expect(h.recorders.audio?.startedWith).toBe(1000);
    expect(h.recorders.video?.startedWith).toBe(1000);
    expect(RECORDER_TIMESLICE_MS).toBe(1000);
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "recording", video: "recording", files: [], notices: [] });
  });

  it("audio only: no tab request", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: false });
    h.mic.resolve(h.micStream);
    await p;
    expect(h.log).toEqual(["getMic", "createMixer(mic)", "createRecorder(audio,mix)"]);
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "recording", video: "off", files: [], notices: [] });
  });

  it("video only: the mic is still requested for the mixed audio", async () => {
    const h = harness();
    const p = h.session.start({ audio: false, video: true });
    h.grantAll();
    await p;
    expect(h.log).toEqual(["getTab", "getMic", "createMixer(mic)", "combine(tab,mix)", "createRecorder(video,combined)"]);
    expect(h.recorders.audio).toBeUndefined();
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "off", video: "recording", files: [], notices: [] });
  });

  it("S5: mic blocked with audio + video: audio fails, video records the interviewer-only mix", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    h.mic.reject(new Error("NotAllowedError"));
    h.tab.resolve(h.tabStream);
    await p;
    expect(h.log).toEqual(["getTab", "getMic", "createMixer(null)", "combine(tab,mix)", "createRecorder(video,combined)"]);
    expect(h.mixerInput).toBeNull();
    expect(h.session.snapshot()).toEqual({
      phase: "recording", audio: "failed", video: "recording", files: [],
      notices: ["Microphone access was blocked, so your audio isn't being recorded."],
    });
  });

  it("S5/S7: audio only with the mic blocked: nothing records and the session finishes", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: false });
    h.mic.reject(new Error("NotAllowedError"));
    await p;
    expect(h.log).toEqual(["getMic"]);
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "failed", video: "off", files: [], notices: [NOTICE.micBlocked] });
    expect(await h.session.finish()).toEqual([]);
  });

  it("S6: tab blocked with audio + video: video fails, audio records", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    h.tab.reject(new Error("NotAllowedError"));
    h.mic.resolve(h.micStream);
    await p;
    expect(h.log).toEqual(["getTab", "getMic", "createMixer(mic)", "createRecorder(audio,mix)"]);
    expect(h.session.snapshot()).toEqual({
      phase: "recording", audio: "recording", video: "failed", files: [],
      notices: ["Screen sharing was cancelled or blocked, so video isn't being recorded."],
    });
  });

  it("S7: video only with the tab blocked: the granted mic is released and nothing records", async () => {
    const h = harness();
    const p = h.session.start({ audio: false, video: true });
    h.tab.reject(new Error("NotAllowedError"));
    h.mic.resolve(h.micStream);
    await p;
    expect(h.log).toEqual(["getTab", "getMic"]);
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "off", video: "failed", files: [], notices: [NOTICE.tabBlocked] });
  });

  it("S3: a getMic that throws synchronously counts as blocked; start never rejects", async () => {
    const h = harness({ micThrowsSync: true });
    await expect(h.session.start({ audio: true, video: false })).resolves.toBeUndefined();
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "failed", video: "off", files: [], notices: [NOTICE.micBlocked] });
  });

  it("S8: a recorder that can't be created fails only its kind", async () => {
    const h = harness({ throwOn: "video" });
    const p = h.session.start({ audio: true, video: true });
    h.grantAll();
    await p;
    expect(h.session.snapshot()).toEqual({
      phase: "recording", audio: "recording", video: "failed", files: [], notices: ["This browser can't record video."],
    });
  });

  it("S8: if no recorder can be created, streams are released and the session finishes", async () => {
    const h = harness({ throwOn: "audio" });
    const p = h.session.start({ audio: true, video: false });
    h.mic.resolve(h.micStream);
    await p;
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.mixerDisposed).toBe(1);
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "failed", video: "off", files: [], notices: [NOTICE.audioUnsupported] });
  });

  it("start is accepted once; later calls are ignored", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: false });
    void h.session.start({ audio: true, video: true });
    h.mic.resolve(h.micStream);
    await p;
    expect(h.log.filter((l) => l === "getMic")).toHaveLength(1);
    expect(h.log).not.toContain("getTab");
  });
});

describe("recording session: finish", () => {
  async function recording(opts: Parameters<typeof harness>[0] = {}) {
    const h = harness(opts);
    const p = h.session.start({ audio: true, video: true });
    h.grantAll();
    await p;
    return h;
  }

  it("F1-F6: stops recorders, waits for their last data, releases streams, and builds the files", async () => {
    const h = await recording({ mime: { video: "video/mp4;codecs=avc1,mp4a" } });
    const audio = h.recorders.audio as FakeRecorder;
    const video = h.recorders.video as FakeRecorder;
    audio.emit(3000);
    audio.emit(0);
    audio.emit(2000);
    audio.finalBytes = 500;
    video.emit(1_200_000);
    const p = h.session.finish();
    expect(h.session.snapshot().phase).toBe("finishing");
    expect(audio.stopCalls).toBe(1);
    expect(video.stopCalls).toBe(1);
    const files = await p;
    expect(files).toEqual([
      { kind: "audio", url: "blob:1", filename: "interim-2026-10-29-1405-audio.webm", bytes: 5500, mimeType: "audio/webm;codecs=opus" },
      { kind: "video", url: "blob:2", filename: "interim-2026-10-29-1405-video.mp4", bytes: 1_200_000, mimeType: "video/mp4;codecs=avc1,mp4a" },
    ]);
    expect(h.blobs.map((b) => [b.size, b.type])).toEqual([[5500, "audio/webm;codecs=opus"], [1_200_000, "video/mp4;codecs=avc1,mp4a"]]);
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.tabStream.tracks[0].stopped).toBe(1);
    expect(h.mixerDisposed).toBe(1);
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "stopped", video: "stopped", files, notices: [] });
  });

  it("F5: a recording with no data gives no file and a notice; an empty mimeType falls back to webm", async () => {
    const h = await recording({ mime: { audio: "" } });
    (h.recorders.audio as FakeRecorder).emit(10);
    const files = await h.session.finish();
    expect(files).toEqual([{ kind: "audio", url: "blob:1", filename: "interim-2026-10-29-1405-audio.webm", bytes: 10, mimeType: "audio/webm" }]);
    expect(h.blobs).toHaveLength(1);
    expect(h.session.snapshot()).toEqual({
      phase: "finished", audio: "stopped", video: "failed", files, notices: ["The video recording was empty."],
    });
  });

  it("F1: finish is idempotent", async () => {
    const h = await recording();
    (h.recorders.audio as FakeRecorder).emit(10);
    const a = h.session.finish();
    const b = h.session.finish();
    expect(b).toBe(a);
    await a;
    expect(h.recorders.audio?.stopCalls).toBe(1);
    expect(h.blobs).toHaveLength(1);
  });

  it("F2: finish during starting waits for start, then finishes", async () => {
    const h = harness({ finalBytes: 42 });
    void h.session.start({ audio: true, video: false });
    const p = h.session.finish();
    expect(h.session.snapshot().phase).toBe("starting");
    h.mic.resolve(h.micStream);
    const files = await p;
    expect(files.map((f) => [f.kind, f.bytes])).toEqual([["audio", 42]]);
  });

  it("finish before start: nothing to record; a later start is ignored", async () => {
    const h = harness();
    expect(await h.session.finish()).toEqual([]);
    expect(h.session.snapshot().phase).toBe("finished");
    await h.session.start({ audio: true, video: true });
    expect(h.log).toEqual([]);
  });

  it("S9: Stop sharing ends only the video recording; finish keeps what it recorded", async () => {
    const h = await recording();
    const video = h.recorders.video as FakeRecorder;
    video.emit(700);
    h.tabStream.tracks[0].fireEnded();
    await flush();
    expect(video.stopCalls).toBe(1);
    expect(h.session.snapshot()).toMatchObject({ phase: "recording", audio: "recording", video: "stopped" });
    (h.recorders.audio as FakeRecorder).emit(5);
    const files = await h.session.finish();
    expect(video.stopCalls).toBe(1);
    expect(files.map((f) => [f.kind, f.bytes])).toEqual([["audio", 5], ["video", 700]]);
  });

  it("a recorder error stops that recorder", async () => {
    const h = await recording();
    const audio = h.recorders.audio as FakeRecorder;
    audio.onerror?.();
    await flush();
    expect(audio.stopCalls).toBe(1);
    expect(h.session.snapshot().audio).toBe("stopped");
  });
});

describe("recording session: dispose and subscribe", () => {
  it("D2: dispose while waiting for permission releases late streams and creates nothing", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    const before = h.emits;
    h.session.dispose();
    h.grantAll();
    await p;
    expect(h.log).toEqual(["getTab", "getMic"]);
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.tabStream.tracks[0].stopped).toBe(1);
    expect(h.emits).toBe(before);
  });

  it("D1: dispose while recording stops recorders and streams, and never emits again", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    h.grantAll();
    await p;
    const before = h.emits;
    h.session.dispose();
    h.session.dispose();
    await flush();
    expect(h.recorders.audio?.stopCalls).toBe(1);
    expect(h.recorders.video?.stopCalls).toBe(1);
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.tabStream.tracks[0].stopped).toBe(1);
    expect(h.mixerDisposed).toBe(1);
    expect(h.emits).toBe(before);
    expect(await h.session.finish()).toEqual([]);
  });

  it("D1: dispose after finish revokes every file URL", async () => {
    const h = harness();
    const p = h.session.start({ audio: true, video: true });
    h.grantAll();
    await p;
    (h.recorders.audio as FakeRecorder).emit(1);
    (h.recorders.video as FakeRecorder).emit(1);
    await h.session.finish();
    h.session.dispose();
    expect(h.revoked).toEqual(["blob:1", "blob:2"]);
  });

  it("snapshot keeps its identity between changes; unsubscribe stops notifications", async () => {
    const h = harness();
    const a = h.session.snapshot();
    expect(h.session.snapshot()).toBe(a);
    let calls = 0;
    const off = h.session.subscribe(() => { calls++; });
    void h.session.start({ audio: true, video: false });
    expect(calls).toBeGreaterThan(0);
    const b = h.session.snapshot();
    expect(b).not.toBe(a);
    expect(h.session.snapshot()).toBe(b);
    off();
    const seen = calls;
    h.mic.resolve(h.micStream);
    await flush();
    expect(calls).toBe(seen);
    expect(h.session.snapshot().phase).toBe("recording");
  });
});
