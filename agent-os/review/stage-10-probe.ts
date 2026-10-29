// Stage 10 round-1 reproductions against the builder's recording-session.ts.
// Run: npx tsx agent-os/review/stage-10-probe.ts
import {
  createRecordingSession,
  type RecorderLike,
  type RecordingDeps,
  type StreamLike,
  type TrackLike,
  type BlobEventLike,
} from "../../src/client/recording/recording-session";

const unhandled: string[] = [];
process.on("unhandledRejection", (r) => { unhandled.push(String(r)); });

function track(kind: string): TrackLike & { stopped: number } {
  return { kind, stopped: 0, stop() { this.stopped++; }, addEventListener() {} };
}
function stream(...t: TrackLike[]): StreamLike { return { getTracks: () => t }; }
class Rec implements RecorderLike {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: BlobEventLike) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly mimeType: string, private startThrows = false) {}
  start(): void { if (this.startThrows) throw new Error("NotSupportedError"); this.state = "recording"; }
  stop(): void { if (this.state === "inactive") return; this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
}
function deps(over: Partial<RecordingDeps>): RecordingDeps {
  return {
    getMic: () => Promise.resolve(stream(track("audio"))),
    getTab: () => Promise.resolve(stream(track("video"))),
    createMixer: () => ({ stream: stream(track("audio")), dispose() {} }),
    combine: () => stream(),
    createRecorder: (_s, k) => new Rec(k === "audio" ? "audio/webm" : "video/webm"),
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
    now: () => 0,
    ...over,
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // P1: tab refused while the mic prompt is still open.
  {
    const s = createRecordingSession(deps({
      getTab: () => Promise.reject(new Error("tab NotAllowedError")),
      getMic: () => new Promise((r) => setTimeout(() => r(stream(track("audio"))), 50)),
    }));
    await s.start({ audio: true, video: true });
    await sleep(20);
    console.log(`P1 unhandled rejections: ${unhandled.length} ${JSON.stringify(unhandled)}`);
  }
  // P2: S5 + S6 together -> how many emits for the blocked step?
  {
    const s = createRecordingSession(deps({
      getTab: () => Promise.reject(new Error("t")),
      getMic: () => Promise.reject(new Error("m")),
    }));
    const seen: string[] = [];
    s.subscribe(() => { const x = s.snapshot(); seen.push(`${x.phase}/${x.audio}/${x.video}/${x.notices.length}`); });
    await s.start({ audio: true, video: true });
    await sleep(5);
    console.log(`P2 emits: ${JSON.stringify(seen)}`);
  }
  // P3: snapshot after dispose while recording.
  {
    const s = createRecordingSession(deps({}));
    await s.start({ audio: true, video: false });
    const before = s.snapshot();
    s.dispose();
    await sleep(5);
    console.log(`P3 snapshot unchanged after dispose: ${s.snapshot() === before} (audio=${s.snapshot().audio})`);
  }
  // P4: recorder.start() throws -> does finish() resolve?
  {
    const s = createRecordingSession(deps({ createRecorder: () => new Rec("audio/webm", true) }));
    await s.start({ audio: true, video: false });
    const snap = s.snapshot();
    const r = await Promise.race([s.finish().then(() => "resolved"), sleep(200).then(() => "HUNG")]);
    console.log(`P4 after start: ${snap.phase}/${snap.audio}; finish: ${r}`);
  }
  // P4b: audio + video, only the video recorder's start() throws -> does finish() resolve?
  {
    const s = createRecordingSession(deps({ createRecorder: (_s, k) => new Rec(`${k}/webm`, k === "video") }));
    await s.start({ audio: true, video: true });
    const snap = s.snapshot();
    const r = await Promise.race([s.finish().then(() => "resolved"), sleep(200).then(() => "HUNG")]);
    console.log(`P4b after start: ${snap.phase}/${snap.audio}/${snap.video}; finish: ${r}; phase now ${s.snapshot().phase}`);
  }
  // P5: createMixer throws -> does start reject?
  {
    const s = createRecordingSession(deps({ createMixer: () => { throw new Error("no AudioContext"); } }));
    const r = await s.start({ audio: true, video: false }).then(() => "resolved", (e: unknown) => `REJECTED ${String(e)}`);
    console.log(`P5 start: ${r}; phase=${s.snapshot().phase}`);
  }
  await sleep(20);
  console.log(`total unhandled: ${unhandled.length}`);
}
void main();
