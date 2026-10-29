// Stage 10 review-1 reviewer tests (B1-B4, G1-G5). Copy byte-identical to tests/recording-review.test.ts; do not edit.
import { describe, it, expect, afterEach } from "vitest";
import {
  createRecordingSession,
  NOTICE,
  type RecorderLike,
  type RecordingDeps,
  type RecordingKind,
  type StreamLike,
  type TrackLike,
  type BlobEventLike,
} from "@/client/recording/recording-session";

class FakeTrack implements TrackLike {
  stopped = 0;
  constructor(readonly kind: string) {}
  stop(): void { this.stopped++; }
  addEventListener(): void {}
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
  stopCalls = 0;
  constructor(readonly mimeType: string, private readonly startThrows: boolean) {}
  start(): void {
    if (this.startThrows) throw new Error("NotSupportedError");
    this.state = "recording";
  }
  stop(): void {
    this.stopCalls++;
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => { this.onstop?.(); });
  }
  emit(bytes: number): void { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "TIMEOUT" as const)]);

interface Opts {
  mic?: () => Promise<StreamLike>;
  tab?: () => Promise<StreamLike>;
  mixerThrows?: boolean;
  combineThrows?: boolean;
  startThrows?: RecordingKind;
  mime?: Partial<Record<RecordingKind, string>>;
}
function harness(opts: Opts = {}) {
  const log: string[] = [];
  const micStream = new FakeStream("mic", [new FakeTrack("audio")]);
  const tabStream = new FakeStream("tab", [new FakeTrack("video")]);
  const recorders: Partial<Record<RecordingKind, FakeRecorder>> = {};
  let urls = 0;
  let mixerDisposed = 0;
  const deps: RecordingDeps = {
    getMic: () => { log.push("getMic"); return opts.mic ? opts.mic() : Promise.resolve(micStream); },
    getTab: () => { log.push("getTab"); return opts.tab ? opts.tab() : Promise.resolve(tabStream); },
    createMixer: () => {
      log.push("createMixer");
      if (opts.mixerThrows) throw new Error("no AudioContext");
      return { stream: new FakeStream("mix", [new FakeTrack("audio")]), dispose: () => { mixerDisposed++; } };
    },
    combine: () => {
      log.push("combine");
      if (opts.combineThrows) throw new Error("no MediaStream");
      return new FakeStream("combined", []);
    },
    createRecorder: (_stream, kind) => {
      log.push(`createRecorder(${kind})`);
      const r = new FakeRecorder(opts.mime?.[kind] ?? `${kind}/webm`, opts.startThrows === kind);
      recorders[kind] = r;
      return r;
    },
    createObjectURL: () => { urls++; return `blob:${urls}`; },
    revokeObjectURL: () => {},
    now: () => Date.UTC(2026, 9, 29, 14, 5, 59),
  };
  const session = createRecordingSession(deps);
  const seen: string[] = [];
  session.subscribe(() => {
    const s = session.snapshot();
    seen.push(`${s.phase}/${s.audio}/${s.video}/${s.notices.length}`);
  });
  return {
    log, micStream, tabStream, recorders, session, seen,
    get urls() { return urls; },
    get mixerDisposed() { return mixerDisposed; },
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => { unhandled.push(r); };
afterEach(() => { process.off("unhandledRejection", onUnhandled); unhandled.length = 0; });

describe("recording session review-1: start", () => {
  it("B1: the tab refused while the mic prompt is still open gives no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const h = harness({
      tab: () => Promise.reject(new Error("NotAllowedError")),
      mic: () => sleep(30).then(() => h.micStream),
    });
    await h.session.start({ audio: true, video: true });
    await sleep(10);
    expect(unhandled).toEqual([]);
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "recording", video: "failed", files: [], notices: [NOTICE.tabBlocked] });
  });

  it("B1: the mic refused while the share picker is still open gives no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const h = harness({
      mic: () => Promise.reject(new Error("NotAllowedError")),
      tab: () => sleep(30).then(() => h.tabStream),
    });
    await h.session.start({ audio: true, video: true });
    await sleep(10);
    expect(unhandled).toEqual([]);
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "failed", video: "recording", files: [], notices: [NOTICE.micBlocked] });
  });

  it("B2: S5 and S6 are applied in one change", async () => {
    const h = harness({ mic: () => Promise.reject(new Error("m")), tab: () => Promise.reject(new Error("t")) });
    await h.session.start({ audio: true, video: true });
    expect(h.seen).toEqual(["starting/starting/starting/0", "starting/failed/failed/2", "finished/failed/failed/2"]);
    expect(h.session.snapshot().notices).toEqual([NOTICE.micBlocked, NOTICE.tabBlocked]);
  });

  it("B4: a video recorder whose start() throws fails only video, and finish still resolves", async () => {
    const h = harness({ startThrows: "video" });
    await h.session.start({ audio: true, video: true });
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "recording", video: "failed", files: [], notices: [NOTICE.videoUnsupported] });
    (h.recorders.audio as FakeRecorder).emit(10);
    const files = await timeout(h.session.finish(), 500);
    expect(files).not.toBe("TIMEOUT");
    expect(files).toEqual([{ kind: "audio", url: "blob:1", filename: "interim-2026-10-29-1405-audio.webm", bytes: 10, mimeType: "audio/webm" }]);
    expect(h.session.snapshot()).toMatchObject({ phase: "finished", audio: "stopped", video: "failed", notices: [NOTICE.videoUnsupported] });
  });

  it("B4: the only recorder's start() throwing releases everything and finishes", async () => {
    const h = harness({ startThrows: "audio" });
    await h.session.start({ audio: true, video: false });
    expect(h.session.snapshot()).toEqual({ phase: "finished", audio: "failed", video: "off", files: [], notices: [NOTICE.audioUnsupported] });
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.mixerDisposed).toBe(1);
    expect(await timeout(h.session.finish(), 500)).toEqual([]);
  });

  it("B4: createMixer throwing: start resolves, streams are released, both kinds fail", async () => {
    const h = harness({ mixerThrows: true });
    await expect(timeout(h.session.start({ audio: true, video: true }), 500)).resolves.toBeUndefined();
    expect(h.log).toEqual(["getTab", "getMic", "createMixer"]);
    expect(h.micStream.tracks[0].stopped).toBe(1);
    expect(h.tabStream.tracks[0].stopped).toBe(1);
    expect(h.session.snapshot()).toEqual({
      phase: "finished", audio: "failed", video: "failed", files: [], notices: [NOTICE.audioUnsupported, NOTICE.videoUnsupported],
    });
    expect(await timeout(h.session.finish(), 500)).toEqual([]);
  });

  it("B4: combine throwing fails only video; audio records", async () => {
    const h = harness({ combineThrows: true });
    await expect(h.session.start({ audio: true, video: true })).resolves.toBeUndefined();
    expect(h.log).toEqual(["getTab", "getMic", "createMixer", "createRecorder(audio)", "combine"]);
    expect(h.session.snapshot()).toEqual({ phase: "recording", audio: "recording", video: "failed", files: [], notices: [NOTICE.videoUnsupported] });
  });

  it("G4: start after dispose calls nothing", async () => {
    const h = harness();
    h.session.dispose();
    await h.session.start({ audio: true, video: true });
    expect(h.log).toEqual([]);
    expect(h.session.snapshot().phase).toBe("idle");
  });
});

describe("recording session review-1: finish and dispose", () => {
  it("B3 (N3): the snapshot never changes after dispose, even when recorders stop later", async () => {
    const h = harness();
    await h.session.start({ audio: true, video: true });
    const before = h.session.snapshot();
    h.session.dispose();
    await flush();
    expect(h.recorders.audio?.stopCalls).toBe(1);
    expect(h.session.snapshot()).toBe(before);
  });

  it("G1: finish after start already finished (S7) changes nothing and releases nothing twice", async () => {
    const h = harness({ tab: () => Promise.reject(new Error("t")) });
    await h.session.start({ audio: false, video: true });
    const before = h.session.snapshot();
    const n = h.seen.length;
    expect(await h.session.finish()).toEqual([]);
    expect(h.session.snapshot()).toBe(before);
    expect(h.seen).toHaveLength(n);
    expect(h.micStream.tracks[0].stopped).toBe(1);
  });

  it("G2: an empty audio recording fails audio with its notice; mp4 audio gets .mp4; empty video mimeType falls back to video/webm", async () => {
    const h = harness({ mime: { audio: "audio/mp4", video: "" } });
    await h.session.start({ audio: true, video: true });
    (h.recorders.video as FakeRecorder).emit(7);
    const files = await h.session.finish();
    expect(files).toEqual([{ kind: "video", url: "blob:1", filename: "interim-2026-10-29-1405-video.webm", bytes: 7, mimeType: "video/webm" }]);
    expect(h.session.snapshot()).toMatchObject({ phase: "finished", audio: "failed", video: "stopped", notices: [NOTICE.audioEmpty] });

    const g = harness({ mime: { audio: "audio/mp4" } });
    await g.session.start({ audio: true, video: false });
    (g.recorders.audio as FakeRecorder).emit(3);
    expect((await g.session.finish()).map((f) => f.filename)).toEqual(["interim-2026-10-29-1405-audio.mp4"]);
  });

  it("G3: dispose while finish waits for the recorders resolves [] and builds no file", async () => {
    const h = harness();
    await h.session.start({ audio: true, video: false });
    (h.recorders.audio as FakeRecorder).emit(5);
    const p = h.session.finish();
    h.session.dispose();
    expect(await p).toEqual([]);
    expect(h.urls).toBe(0);
  });

  it("G5 (N4): every method works unbound", async () => {
    const h = harness();
    const { start, finish, dispose, snapshot, subscribe } = h.session;
    let calls = 0;
    const off = subscribe(() => { calls++; });
    await start({ audio: true, video: false });
    expect(calls).toBeGreaterThan(0);
    expect(snapshot().phase).toBe("recording");
    off();
    (h.recorders.audio as FakeRecorder).emit(4);
    expect((await finish()).map((f) => f.bytes)).toEqual([4]);
    dispose();
    expect(snapshot().phase).toBe("finished");
  });
});
