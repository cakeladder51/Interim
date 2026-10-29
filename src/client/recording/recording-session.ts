import { extensionFor, fileStamp, type RecordingKind } from "./recording-format";

export type { RecordingKind };
export interface RecordingChoice {
  audio: boolean;
  video: boolean;
}
export interface TrackLike {
  readonly kind: string;
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
}
export interface BlobEventLike {
  data: Blob;
}
export interface RecorderLike {
  readonly mimeType: string;
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((e: BlobEventLike) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs: number): void;
  stop(): void;
}
export interface Mixer {
  stream: StreamLike;
  dispose(): void;
}
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
export interface RecordingFile {
  kind: RecordingKind;
  url: string;
  filename: string;
  bytes: number;
  mimeType: string;
}
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

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  let snapshot: RecordingSnapshot = {
    phase: "idle",
    audio: "off",
    video: "off",
    files: [],
    notices: [],
  };
  const listeners: Set<() => void> = new Set();
  let disposed = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let startCompleted = false;
  let finishPromise: Promise<RecordingFile[]> | null = null;
  const recorders: { audio?: RecorderLike; video?: RecorderLike } = {};
  const chunks: { audio: Blob[]; video: Blob[] } = { audio: [], video: [] };
  const stopPromises: { audio?: Deferred<void>; video?: Deferred<void> } = {};
  let micStream: StreamLike | null = null;
  let tabStream: StreamLike | null = null;
  let mixer: Mixer | null = null;

  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  }
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function emit(): void {
    if (disposed) return;
    for (const listener of listeners) {
      listener();
    }
  }

  function updateSnap(
    updates: Partial<RecordingSnapshot>,
    appendNotices?: string[]
  ): void {
    if (disposed) return;
    const baseNotices = snapshot.notices;
    const newNotices = appendNotices
      ? [...baseNotices, ...appendNotices]
      : baseNotices;
    snapshot = { ...snapshot, ...updates, notices: newNotices };
    emit();
  }

  function stopAllTracks(stream: StreamLike | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function createMixerOrNull(mic: StreamLike | null): Mixer | null {
    try {
      return deps.createMixer(mic);
    } catch {
      return null;
    }
  }

  function failUnsupported(kind: RecordingKind): false {
    updateSnap(
      { [kind]: "failed" },
      [kind === "audio" ? NOTICE.audioUnsupported : NOTICE.videoUnsupported]
    );
    return false;
  }

  // review-1 B4: getStream() (combine) or recorder.start() throwing counts as createRecorder throwing.
  // A recorder is kept only once it has started, so finish() never waits for one that can't stop.
  function startRecorder(getStream: () => StreamLike, kind: RecordingKind): boolean {
    let recorder: RecorderLike;
    try {
      recorder = deps.createRecorder(getStream(), kind);
    } catch {
      return failUnsupported(kind);
    }
    const kindChunks: Blob[] = [];
    const stopped = deferred<void>();
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        kindChunks.push(e.data);
      }
    };
    recorder.onstop = () => {
      stopped.resolve();
      updateSnap({ [kind]: "stopped" });
    };
    recorder.onerror = () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    };
    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch {
      return failUnsupported(kind);
    }
    recorders[kind] = recorder;
    chunks[kind] = kindChunks;
    stopPromises[kind] = stopped;
    updateSnap({ [kind]: "recording" });
    return true;
  }

  function doStart(choice: RecordingChoice): Promise<void> {
    // S1: run at most once
    if (started || disposed || startCompleted || finishPromise) {
      return startPromise ?? Promise.resolve();
    }
    started = true;
    startPromise = doStartInner(choice);
    return startPromise;
  }

  async function doStartInner(choice: RecordingChoice): Promise<void> {
    if (!choice.audio && !choice.video) {
      // S1: nothing chosen, stay idle
      startCompleted = true;
      return;
    }

    // S2: set phase starting, call tab then mic before any await
    const audioStatus = choice.audio ? "starting" : "off";
    const videoStatus = choice.video ? "starting" : "off";
    updateSnap({ phase: "starting", audio: audioStatus, video: videoStatus });

    // S2: call getTab first (if video), then getMic (if anything chosen)
    // These calls must be synchronous - before any await
    let micP: Promise<StreamLike> | null = null;
    let tabP: Promise<StreamLike> | null = null;
    let micThrew: Error | null = null;
    let tabThrew: Error | null = null;

    // Call getTab first if video is chosen
    if (choice.video) {
      try {
        tabP = deps.getTab();
      } catch (e) {
        tabThrew = e instanceof Error ? e : new Error(String(e));
      }
    }

    // Then call getMic if anything is chosen
    if (choice.audio || choice.video) {
      try {
        micP = deps.getMic();
      } catch (e) {
        micThrew = e instanceof Error ? e : new Error(String(e));
      }
    }

    // S3: wait for both promises in ONE allSettled, so no rejection is ever left unhandled (review-1 B1)
    const [tabResult, micResult] = await Promise.allSettled([
      tabThrew ? Promise.reject(tabThrew) : (tabP ?? Promise.resolve(null)),
      micThrew ? Promise.reject(micThrew) : (micP ?? Promise.resolve(null)),
    ]);

    const micGranted =
      micResult.status === "fulfilled" && micResult.value !== null;
    const micRejected =
      micResult.status === "rejected" || micThrew !== null;

    const tabGranted =
      tabResult.status === "fulfilled" && tabResult.value !== null;
    const tabRejected =
      tabResult.status === "rejected" || tabThrew !== null;

    if (disposed) {
      // S4: dispose while waiting
      if (micGranted && micResult.status === "fulfilled" && micResult.value) {
        stopAllTracks(micResult.value);
      }
      if (tabGranted && tabResult.status === "fulfilled" && tabResult.value) {
        stopAllTracks(tabResult.value);
      }
      return;
    }

    micStream = micGranted
      ? (micResult as PromiseFulfilledResult<StreamLike>).value
      : null;
    tabStream = tabGranted
      ? (tabResult as PromiseFulfilledResult<StreamLike>).value
      : null;

    // S5/S6: handle blocked, applied together in one change (review-1 B2)
    const blocked: Partial<RecordingSnapshot> = {};
    const blockedNotices: string[] = [];
    if (choice.audio && micRejected) {
      blocked.audio = "failed";
      blockedNotices.push(NOTICE.micBlocked);
    }
    if (choice.video && tabRejected) {
      blocked.video = "failed";
      blockedNotices.push(NOTICE.tabBlocked);
    }
    if (blockedNotices.length > 0) {
      updateSnap(blocked, blockedNotices);
    }

    // S7: if nothing can record
    const canAudio = choice.audio && micGranted;
    const canVideo = choice.video && tabGranted;
    if (!canAudio && !canVideo) {
      stopAllTracks(micStream);
      stopAllTracks(tabStream);
      updateSnap({ phase: "finished", files: [] });
      startCompleted = true;
      return;
    }

    // S8: create mixer and recorders. createMixer throwing counts as createRecorder throwing
    // for each kind that would have started (review-1 B4).
    const mix = createMixerOrNull(micStream);
    mixer = mix;

    let anyRecorder = false;

    if (canAudio) {
      if (mix ? startRecorder(() => mix.stream, "audio") : failUnsupported("audio")) {
        anyRecorder = true;
      }
    }

    if (canVideo) {
      const tab = tabStream!;
      if (mix ? startRecorder(() => deps.combine(tab, mix.stream), "video") : failUnsupported("video")) {
        anyRecorder = true;
      }
    }

    // S9: set up "Stop sharing" listener for video track
    if (tabStream) {
      for (const track of tabStream.getTracks()) {
        if (track.kind === "video") {
          track.addEventListener("ended", () => {
            const vidRecorder = recorders.video;
            if (vidRecorder && vidRecorder.state !== "inactive") {
              vidRecorder.stop();
            }
          });
        }
      }
    }

    if (!anyRecorder) {
      stopAllTracks(micStream);
      stopAllTracks(tabStream);
      mixer?.dispose();
      updateSnap({ phase: "finished", files: [] });
      startCompleted = true;
      return;
    }

    updateSnap({ phase: "recording" });
    startCompleted = true;
  }

  function doFinish(): Promise<RecordingFile[]> {
    // F1: idempotent
    if (finishPromise) {
      return finishPromise;
    }

    // F1: if start never called, finish idle
    if (!started && !disposed) {
      updateSnap({ phase: "finished" });
      finishPromise = Promise.resolve([]);
      return finishPromise;
    }

    // F3: if start has already completed, set finishing synchronously
    if (startCompleted && snapshot.phase === "recording") {
      updateSnap({ phase: "finishing" });
    }

    finishPromise = doFinishInner();
    return finishPromise;
  }

  async function doFinishInner(): Promise<RecordingFile[]> {
    // F2: wait for start to complete
    if (startPromise && !startCompleted) {
      await startPromise;
    }

    if (disposed) {
      return [];
    }

    // F2: if already finished
    if (snapshot.phase === "finished") {
      return snapshot.files;
    }

    // F3: set finishing if not already set
    if (snapshot.phase !== "finishing") {
      updateSnap({ phase: "finishing" });
    }

    // Stop any running recorders
    for (const kind of ["audio", "video"] as RecordingKind[]) {
      const rec = recorders[kind];
      if (rec && rec.state !== "inactive") {
        rec.stop();
      }
    }

    // Wait for all stop promises
    const stopPs: Promise<void>[] = [];
    for (const kind of ["audio", "video"] as RecordingKind[]) {
      if (recorders[kind]) {
        stopPs.push(stopPromises[kind]?.promise ?? Promise.resolve());
      }
    }
    await Promise.all(stopPs);

    if (disposed) {
      return [];
    }

    // F4: stop streams and dispose mixer
    stopAllTracks(micStream);
    stopAllTracks(tabStream);
    if (mixer) {
      mixer.dispose();
    }

    // F5: build files
    const files: RecordingFile[] = [];
    const newFailedKinds: Partial<Record<RecordingKind, "failed">> = {};
    const newNotices: string[] = [];

    // Process audio first
    if (recorders.audio) {
      const audioChunks = chunks.audio;
      const audioBytes = audioChunks.reduce((sum, b) => sum + b.size, 0);
      if (audioBytes === 0) {
        newFailedKinds.audio = "failed";
        newNotices.push(NOTICE.audioEmpty);
      } else {
        const rec = recorders.audio;
        const mimeType = rec.mimeType || "audio/webm";
        const blob = new Blob(audioChunks, { type: mimeType });
        const url = deps.createObjectURL(blob);
        const filename = `interim-${fileStamp(deps.now())}-audio.${extensionFor(mimeType)}`;
        files.push({
          kind: "audio",
          url,
          filename,
          bytes: audioBytes,
          mimeType,
        });
      }
    }

    // Then video
    if (recorders.video) {
      const videoChunks = chunks.video;
      const videoBytes = videoChunks.reduce((sum, b) => sum + b.size, 0);
      if (videoBytes === 0) {
        newFailedKinds.video = "failed";
        newNotices.push(NOTICE.videoEmpty);
      } else {
        const rec = recorders.video;
        const mimeType = rec.mimeType || "video/webm";
        const blob = new Blob(videoChunks, { type: mimeType });
        const url = deps.createObjectURL(blob);
        const filename = `interim-${fileStamp(deps.now())}-video.${extensionFor(mimeType)}`;
        files.push({
          kind: "video",
          url,
          filename,
          bytes: videoBytes,
          mimeType,
        });
      }
    }

    // F6: in one change, set phase finished, files, failed kinds, notices
    updateSnap(
      {
        phase: "finished",
        files,
        ...newFailedKinds,
      },
      newNotices.length > 0 ? newNotices : undefined
    );

    return files;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // D1: stop recorders
    for (const kind of ["audio", "video"] as RecordingKind[]) {
      const rec = recorders[kind];
      if (rec && rec.state !== "inactive") {
        rec.stop();
      }
    }

    // Stop streams
    stopAllTracks(micStream);
    stopAllTracks(tabStream);

    // Dispose mixer
    if (mixer) {
      mixer.dispose();
    }

    // Revoke URLs
    for (const file of snapshot.files) {
      deps.revokeObjectURL(file.url);
    }

    listeners.clear();
  }

  function snapshotFn(): RecordingSnapshot {
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // Wrap methods to work unbound (N4)
  return {
    start: (choice) => {
      if (startPromise) return startPromise;
      return doStart(choice);
    },
    finish: doFinish,
    dispose,
    snapshot: snapshotFn,
    subscribe,
  };
}
