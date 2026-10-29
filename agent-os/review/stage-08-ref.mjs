// Stage 8 reference: turn controller + FNV-1a hash, and the brief's vectors V1-V14 / H1-H4.
// Not app code; never hand it to the builder. Run: node agent-os/review/stage-08-ref.mjs
export const PARTIAL_MIN_NEW_WORDS = 8, PARTIAL_MAX_WAIT_MS = 3000, SILENCE_FIRST_MS = 20000,
  SILENCE_REPEAT_MS = 10000, SILENCE_MAX_PROMPTS = 2, CANVAS_IDLE_MS = 4000, CANVAS_MAX_CHARS = 1_500_000;

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const countWords = (t) => t.split(/\s+/).filter(Boolean).length;

export function createTurnController(deps) {
  let disposed = false, idle = false, busy = false, lastKind = null;
  let latest = null, latestWords = 0, sentWords = 0, firstUnsentAt = null, partialTimer = null;
  let since = null, silenceTimer = null, prompts = 0;
  let getImage = null, canvasTimer = null, canvasDue = false, lastHash = null;
  const clear = (h) => { if (h !== null) deps.clearTimer(h); return null; };
  function armSilence(delay) {
    silenceTimer = clear(silenceTimer);
    if (prompts >= SILENCE_MAX_PROMPTS) return;
    silenceTimer = deps.setTimer(onSilence, delay);
  }
  function onSilence() {
    silenceTimer = null;
    if (!idle || since === null) return;
    if (busy) { armSilence(SILENCE_REPEAT_MS); return; }
    const ms = Math.max(1, Math.round(deps.now() - since));
    if (deps.send({ type: "silence", ms })) { busy = true; lastKind = "silence"; } else armSilence(SILENCE_REPEAT_MS);
  }
  function flush() {
    if (!idle || busy) return;
    if (latest !== null && latestWords > sentWords &&
        (latestWords - sentWords >= PARTIAL_MIN_NEW_WORDS ||
         (firstUnsentAt !== null && deps.now() - firstUnsentAt >= PARTIAL_MAX_WAIT_MS))) {
      if (deps.send({ type: "partial", text: latest })) {
        busy = true; lastKind = "partial"; sentWords = latestWords; firstUnsentAt = null; partialTimer = clear(partialTimer);
      }
      return;
    }
    if (canvasDue && getImage !== null) {
      canvasDue = false;
      const image = getImage();
      if (image === null || image.length > CANVAS_MAX_CHARS) return;
      const h = hashString(image);
      if (h === lastHash) return;
      if (deps.send({ type: "canvas", image })) { busy = true; lastKind = "canvas"; lastHash = h; } else canvasDue = true;
    }
  }
  function activity() {
    if (disposed) return;
    prompts = 0;
    if (idle) { since = deps.now(); armSilence(SILENCE_FIRST_MS); }
  }
  return {
    setIdle(v) {
      if (disposed) return;
      if (v && !idle) { idle = true; since = deps.now(); armSilence(SILENCE_FIRST_MS); }
      else if (!v && idle) { idle = false; silenceTimer = clear(silenceTimer); since = null; }
      if (idle) flush();
    },
    activity,
    partial(text) {
      if (disposed) return;
      const w = countWords(text);
      if (w < sentWords) sentWords = 0;
      latest = text; latestWords = w;
      activity();
      if (w > sentWords && firstUnsentAt === null) {
        firstUnsentAt = deps.now();
        partialTimer = clear(partialTimer);
        partialTimer = deps.setTimer(() => { partialTimer = null; flush(); }, PARTIAL_MAX_WAIT_MS);
      }
      flush();
    },
    turnBoundary() {
      if (disposed) return;
      latest = null; latestWords = 0; sentWords = 0; firstUnsentAt = null; partialTimer = clear(partialTimer);
      activity();
    },
    canvasChanged(g) {
      if (disposed) return;
      getImage = g; canvasDue = false; canvasTimer = clear(canvasTimer);
      canvasTimer = deps.setTimer(() => { canvasTimer = null; canvasDue = true; flush(); }, CANVAS_IDLE_MS);
      activity();
    },
    settled(move) {
      if (disposed || !busy) return;
      busy = false;
      const spoke = move !== null && move.type !== "silent";
      if (lastKind === "silence" && spoke) prompts++;
      lastKind = null;
      if (idle) {
        if (spoke) { since = deps.now(); armSilence(SILENCE_FIRST_MS); }
        else if (silenceTimer === null && since !== null) armSilence(SILENCE_REPEAT_MS);
      }
      if (idle) flush();
    },
    dispose() {
      disposed = true; idle = false;
      partialTimer = clear(partialTimer); silenceTimer = clear(silenceTimer); canvasTimer = clear(canvasTimer);
    },
  };
}

// ---- fake clock harness (same shape the brief asks the builder to write) ----
function harness() {
  let t = 0, seq = 0; const timers = new Map(); const sends = []; let sendOk = true;
  const deps = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    send: (e) => { sends.push({ t, ...(e.type === "canvas" ? { type: "canvas", image: e.image.slice(0, 30) } : e) }); return sendOk; },
  };
  const advanceTo = (to) => {
    for (;;) {
      const due = [...timers.values()].filter((x) => x.at <= to).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers.delete(due.id); t = due.at; due.fn();
    }
    t = to;
  };
  return { deps, sends, advanceTo, setOk: (v) => { sendOk = v; }, pending: () => timers.size };
}
const W = (n) => Array.from({ length: n }, (_, i) => "w" + (i + 1)).join(" ");
const silent = { type: "silent" }, hint = { type: "hint", rung: 0 };
const run = (name, fn) => { const h = harness(); const c = createTurnController(h.deps); fn(c, h); console.log(name, JSON.stringify(h.sends)); };

run("V1", (c, h) => { c.setIdle(true); c.partial(W(3)); h.advanceTo(2999); h.advanceTo(3000); });
run("V2", (c, h) => { c.setIdle(true); c.partial(W(8)); h.advanceTo(100); });
run("V3", (c, h) => { c.setIdle(true); c.partial(W(8)); h.advanceTo(100); c.partial(W(16)); h.advanceTo(200); c.settled(silent); h.advanceTo(300); });
run("V4", (c, h) => { c.setIdle(true); c.partial(W(3)); h.advanceTo(1000); c.setIdle(false); h.advanceTo(5000); c.setIdle(true); h.advanceTo(5100); });
run("V5", (c, h) => { c.setIdle(true); h.advanceTo(19999); h.advanceTo(20000); h.advanceTo(20100); c.settled(silent); h.advanceTo(30100); h.advanceTo(30200); c.settled(hint); h.advanceTo(50200); h.advanceTo(50300); c.settled(hint); h.advanceTo(120000); c.activity(); h.advanceTo(140000); });
run("V6", (c, h) => { c.setIdle(true); h.advanceTo(15000); c.activity(); h.advanceTo(34999); h.advanceTo(35000); });
run("V7", (c, h) => { c.setIdle(true); h.advanceTo(10000); c.setIdle(false); h.advanceTo(12000); c.setIdle(true); h.advanceTo(31999); h.advanceTo(32000); });
run("V8", (c, h) => { const A = () => "data:image/png;base64,AAA", B = () => "data:image/png;base64,BBB"; c.setIdle(true); c.canvasChanged(A); h.advanceTo(2000); c.canvasChanged(A); h.advanceTo(5999); h.advanceTo(6000); c.settled(silent); h.advanceTo(7000); c.canvasChanged(A); h.advanceTo(11000); h.advanceTo(12000); c.canvasChanged(B); h.advanceTo(16000); });
run("V9", (c, h) => { const big = "data:image/png;base64," + "A".repeat(1_500_001 - 22); const ok = "data:image/png;base64," + "B".repeat(1_500_000 - 22); c.setIdle(true); c.canvasChanged(() => null); h.advanceTo(4000); c.canvasChanged(() => big); h.advanceTo(8000); c.canvasChanged(() => ok); h.advanceTo(12000); });
run("V10", (c, h) => { c.setIdle(true); c.partial(W(5)); h.advanceTo(1000); c.turnBoundary(); h.advanceTo(4000); c.partial(W(3)); h.advanceTo(6999); h.advanceTo(7000); });
run("V11", (c, h) => { c.setIdle(true); c.partial(W(10)); h.advanceTo(500); c.settled(silent); c.partial(W(4)); h.advanceTo(3499); h.advanceTo(3500); });
run("V12", (c, h) => { c.setIdle(true); h.setOk(false); c.partial(W(8)); h.setOk(true); h.advanceTo(100); c.partial(W(8)); h.advanceTo(200); });
run("V13", (c, h) => { c.setIdle(true); c.partial(W(8)); c.partial(W(12)); c.canvasChanged(() => "data:image/png;base64,CCC"); h.advanceTo(5000); c.settled(silent); h.advanceTo(5100); c.settled(silent); h.advanceTo(5200); });
run("V14", (c, h) => { c.setIdle(true); c.partial(W(3)); c.canvasChanged(() => "data:image/png;base64,DDD"); c.dispose(); console.log("V14 pending timers after dispose", h.pending()); h.advanceTo(60000); c.setIdle(true); c.partial(W(9)); c.activity(); });
run("V15", (c, h) => { c.partial(W(9)); h.advanceTo(3000); c.setIdle(true); h.advanceTo(3100); });
for (const s of ["", "a", "foobar", "data:image/png;base64,AAA"]) console.log("H", JSON.stringify(s), hashString(s));
