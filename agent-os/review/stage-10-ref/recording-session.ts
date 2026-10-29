// Reviewer reference for Stage 10 (never hand to the builder).
import { extensionFor, fileStamp, type RecordingKind } from "./recording-format";

export type { RecordingKind };
export interface RecordingChoice { audio: boolean; video: boolean }
export interface TrackLike { readonly kind: string; stop(): void; addEventListener(type: "ended", listener: () => void): void }
export interface StreamLike { getTracks(): TrackLike[] }
export interface BlobEventLike { data: Blob }
export interface RecorderLike {
  readonly mimeType: string;
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((e: BlobEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs: number): void;
  stop(): void;
}
export interface Mixer { stream: StreamLike; dispose(): void }
export interface RecordingDeps {
  getMic(): Promise<StreamLike>;
  getTab(): Promise<StreamLike>;
  createMixer(mic: StreamLike | null): Mixer;
  combine(tab: StreamLike, audio: StreamLike): StreamLike;
  createRecorder(stream: StreamLike, kind: RecordingKind): RecorderLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
}
export type KindStatus = "off" | "starting" | "recording" | "stopped" | "failed";
export interface RecordingFile { kind: RecordingKind; url: string; filename: string; bytes: number; mimeType: string }
export interface RecordingSnapshot {
  phase: "idle" | "starting" | "recording" | "finishing" | "finished";
  audio: KindStatus;
  video: KindStatus;
  files: RecordingFile[];
  notices: string[];
}
export interface RecordingSession {
  start(choice: RecordingChoice): Promise<void>;
  finish(): Promise<RecordingFile[]>;
  dispose(): void;
  snapshot(): RecordingSnapshot;
  subscribe(listener: () => void): () => void;
}

export const RECORDER_TIMESLICE_MS = 1000;
export const NOTICE = {
  micBlocked: "Microphone access was blocked, so your audio isn't being recorded.",
  tabBlocked: "Screen sharing was cancelled or blocked, so video isn't being recorded.",
  audioUnsupported: "This browser can't record audio.",
  videoUnsupported: "This browser can't record video.",
  audioEmpty: "The audio recording was empty.",
  videoEmpty: "The video recording was empty.",
} as const;

const DEFAULT_TYPE: Record<RecordingKind, string> = { audio: "audio/webm", video: "video/webm" };

interface Rec { recorder: RecorderLike; chunks: Blob[]; stopped: Promise<void> }

function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return fn(); } catch (err) { return Promise.reject(err); }
}

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  let snap: RecordingSnapshot = { phase: "idle", audio: "off", video: "off", files: [], notices: [] };
  const listeners = new Set<() => void>();
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let startDone = false;
  let finishPromise: Promise<RecordingFile[]> | null = null;
  let mic: StreamLike | null = null;
  let tab: StreamLike | null = null;
  let mixer: Mixer | null = null;
  const recs: Partial<Record<RecordingKind, Rec>> = {};

  function set(patch: Partial<RecordingSnapshot>): void {
    if (disposed) return;
    snap = { ...snap, ...patch };
    for (const l of [...listeners]) l();
  }
  const stopTracks = (s: StreamLike | null) => { if (s) for (const t of s.getTracks()) t.stop(); };

  const unsupported = (kind: RecordingKind) =>
    set({ [kind]: "failed", notices: [...snap.notices, kind === "audio" ? NOTICE.audioUnsupported : NOTICE.videoUnsupported] });

  // review-1 B4: getStream (combine) or recorder.start() throwing counts as "can't create the recorder".
  function startRecorder(kind: RecordingKind, getStream: () => StreamLike): void {
    let recorder: RecorderLike;
    try { recorder = deps.createRecorder(getStream(), kind); } catch { unsupported(kind); return; }
    const chunks: Blob[] = [];
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((r) => { resolveStopped = r; });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => { set({ [kind]: "stopped" }); resolveStopped(); };
    recorder.onerror = () => { if (recorder.state !== "inactive") recorder.stop(); };
    try { recorder.start(RECORDER_TIMESLICE_MS); } catch { unsupported(kind); return; }
    recs[kind] = { recorder, chunks, stopped };
    set({ [kind]: "recording" });
  }

  async function doStart(choice: RecordingChoice): Promise<void> {
    set({ phase: "starting", audio: choice.audio ? "starting" : "off", video: choice.video ? "starting" : "off" });
    const tabP = choice.video ? call(deps.getTab) : null;
    const micP = call(deps.getMic);
    const [tabR, micR] = await Promise.allSettled([tabP ?? Promise.resolve(null), micP]);
    const gotTab = tabR.status === "fulfilled" ? tabR.value : null;
    const gotMic = micR.status === "fulfilled" ? micR.value : null;
    if (disposed) { stopTracks(gotTab); stopTracks(gotMic); return; }
    tab = gotTab;
    mic = gotMic;
    const notices = [...snap.notices];
    if (choice.audio && !mic) notices.push(NOTICE.micBlocked);
    if (choice.video && !tab) notices.push(NOTICE.tabBlocked);
    set({
      audio: choice.audio && !mic ? "failed" : snap.audio,
      video: choice.video && !tab ? "failed" : snap.video,
      notices,
    });
    const wantAudio = choice.audio && mic !== null;
    const wantVideo = choice.video && tab !== null;
    if (wantAudio || wantVideo) {
      let m: Mixer | null = null;
      try { m = deps.createMixer(mic); } catch {
        // review-1 B4: as if createRecorder had thrown for each kind that would have started.
        if (wantAudio) unsupported("audio");
        if (wantVideo) unsupported("video");
      }
      mixer = m;
      if (m && wantAudio) startRecorder("audio", () => m.stream);
      if (m && wantVideo && tab) {
        const t = tab;
        startRecorder("video", () => deps.combine(t, m.stream));
        const rec = recs.video;
        if (rec) {
          for (const t of tab.getTracks()) {
            if (t.kind === "video") t.addEventListener("ended", () => { if (rec.recorder.state !== "inactive") rec.recorder.stop(); });
          }
        }
      }
    }
    if (!recs.audio && !recs.video) {
      stopTracks(tab); stopTracks(mic); mixer?.dispose();
      tab = null; mic = null; mixer = null;
      set({ phase: "finished", files: [] });
      return;
    }
    set({ phase: "recording" });
  }

  async function doFinish(): Promise<RecordingFile[]> {
    if (startPromise && !startDone) await startPromise;
    if (disposed) return [];
    if (snap.phase === "finished") return snap.files;
    set({ phase: "finishing" });
    for (const r of Object.values(recs)) if (r && r.recorder.state !== "inactive") r.recorder.stop();
    await Promise.all(Object.values(recs).map((r) => r?.stopped));
    stopTracks(mic); stopTracks(tab); mixer?.dispose();
    if (disposed) return [];
    const files: RecordingFile[] = [];
    const notices = [...snap.notices];
    const patch: Partial<RecordingSnapshot> = {};
    for (const kind of ["audio", "video"] as const) {
      const r = recs[kind];
      if (!r) continue;
      const bytes = r.chunks.reduce((n, c) => n + c.size, 0);
      if (bytes === 0) {
        patch[kind] = "failed";
        notices.push(kind === "audio" ? NOTICE.audioEmpty : NOTICE.videoEmpty);
        continue;
      }
      const mimeType = r.recorder.mimeType || DEFAULT_TYPE[kind];
      const blob = new Blob(r.chunks, { type: mimeType });
      files.push({ kind, url: deps.createObjectURL(blob), filename: `interim-${fileStamp(deps.now())}-${kind}.${extensionFor(mimeType)}`, bytes, mimeType });
    }
    set({ ...patch, phase: "finished", files, notices });
    return files;
  }

  return {
    start(choice) {
      if (startPromise || disposed || finishPromise) return startPromise ?? Promise.resolve();
      if (!choice.audio && !choice.video) { startDone = true; startPromise = Promise.resolve(); return startPromise; }
      startPromise = doStart(choice).catch(() => {}).then(() => { startDone = true; });
      return startPromise;
    },
    finish() {
      if (!finishPromise) {
        finishPromise = startPromise === null && !disposed
          ? (set({ phase: "finished" }), Promise.resolve([]))
          : doFinish();
      }
      return finishPromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const r of Object.values(recs)) if (r && r.recorder.state !== "inactive") r.recorder.stop();
      stopTracks(mic); stopTracks(tab); mixer?.dispose();
      for (const f of snap.files) deps.revokeObjectURL(f.url);
    },
    snapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
