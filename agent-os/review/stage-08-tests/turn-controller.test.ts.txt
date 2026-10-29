import { describe, it, expect, beforeEach } from "vitest";
import {
  createTurnController,
  hashString,
  PARTIAL_MIN_NEW_WORDS,
  PARTIAL_MAX_WAIT_MS,
  SILENCE_FIRST_MS,
  SILENCE_REPEAT_MS,
  SILENCE_MAX_PROMPTS,
  CANVAS_IDLE_MS,
  CANVAS_MAX_CHARS,
} from "../src/client/turn-controller";
import type { BackgroundEvent } from "../src/client/interview-model";

// Helper to generate words
function W(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
}

// Fake clock
let t = 0;
let timerId = 0;
let timerQueue: { at: number; fn: () => void; id: number }[] = [];
let sends: ({ t: number } & BackgroundEvent)[] = [];
let sendOk = true;

function advanceTo(x: number): void {
  while (true) {
    const due = timerQueue.filter((tm) => tm.at <= x).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timerQueue = timerQueue.filter((tm) => tm.id !== due.id);
    t = due.at;
    due.fn();
  }
  t = x;
}

function resetFake(): void {
  t = 0;
  timerId = 0;
  timerQueue = [];
  sends = [];
  sendOk = true;
}

function makeController() {
  return createTurnController({
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++timerId;
      timerQueue.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      timerQueue = timerQueue.filter((tm) => tm.id !== h);
    },
    send: (event) => {
      sends.push({ t, ...event });
      return sendOk;
    },
  });
}

describe("hashString", () => {
  it('"" -> 811c9dc5', () => {
    expect(hashString("")).toBe("811c9dc5");
  });
  it('"a" -> e40c292c', () => {
    expect(hashString("a")).toBe("e40c292c");
  });
  it('"foobar" -> bf9cf968', () => {
    expect(hashString("foobar")).toBe("bf9cf968");
  });
  it('"data:image/png;base64,AAA" -> 325d4f85', () => {
    expect(hashString("data:image/png;base64,AAA")).toBe("325d4f85");
  });
});

describe("constants", () => {
  it("PARTIAL_MIN_NEW_WORDS = 8", () => {
    expect(PARTIAL_MIN_NEW_WORDS).toBe(8);
  });
  it("PARTIAL_MAX_WAIT_MS = 3000", () => {
    expect(PARTIAL_MAX_WAIT_MS).toBe(3000);
  });
  it("SILENCE_FIRST_MS = 20000", () => {
    expect(SILENCE_FIRST_MS).toBe(20000);
  });
  it("SILENCE_REPEAT_MS = 10000", () => {
    expect(SILENCE_REPEAT_MS).toBe(10000);
  });
  it("SILENCE_MAX_PROMPTS = 2", () => {
    expect(SILENCE_MAX_PROMPTS).toBe(2);
  });
  it("CANVAS_IDLE_MS = 4000", () => {
    expect(CANVAS_IDLE_MS).toBe(4000);
  });
  it("CANVAS_MAX_CHARS = 1500000", () => {
    expect(CANVAS_MAX_CHARS).toBe(1_500_000);
  });
});

describe("turn controller vectors", () => {
  beforeEach(resetFake);

  it("V1: partial 3 words, wait 3s triggers", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(3));
    advanceTo(2999);
    expect(sends).toEqual([]);
    advanceTo(3000);
    expect(sends).toEqual([{ t: 3000, type: "partial", text: W(3) }]);
  });

  it("V2: 8 words sends immediately", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(100);
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(8) }]);
  });

  it("V3: two partials, settled in between", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(100);
    ctrl.partial(W(16));
    advanceTo(200);
    ctrl.settled({ type: "silent" });
    advanceTo(300);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 200, type: "partial", text: W(16) },
    ]);
  });

  it("V4: partial goes while not idle, then idle triggers send", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(3));
    advanceTo(1000);
    ctrl.setIdle(false);
    advanceTo(5000);
    ctrl.setIdle(true);
    advanceTo(5100);
    expect(sends).toEqual([{ t: 5000, type: "partial", text: W(3) }]);
  });

  it("V5: silence prompts with two-prompt cap", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(19999);
    advanceTo(20000);
    expect(sends).toEqual([{ t: 20000, type: "silence", ms: 20000 }]);
    sends = [];
    advanceTo(20100);
    ctrl.settled({ type: "silent" });
    advanceTo(30100);
    expect(sends).toEqual([{ t: 30100, type: "silence", ms: 30100 }]);
    sends = [];
    advanceTo(30200);
    ctrl.settled({ type: "hint", rung: 0 });
    // After spoke, prompts incremented
    advanceTo(50200);
    expect(sends).toEqual([{ t: 50200, type: "silence", ms: 20000 }]);
    sends = [];
    advanceTo(50300);
    ctrl.settled({ type: "hint", rung: 0 });
    sends = [];
    // Two prompts used, activity resets
    advanceTo(120000);
    ctrl.activity();
    advanceTo(140000);
    expect(sends).toEqual([{ t: 140000, type: "silence", ms: 20000 }]);
  });

  it("V6: activity resets silence timer", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(15000);
    ctrl.activity();
    advanceTo(34999);
    expect(sends).toEqual([]);
    advanceTo(35000);
    expect(sends).toEqual([{ t: 35000, type: "silence", ms: 20000 }]);
  });

  it("V7: toggling idle preserves since", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(10000);
    ctrl.setIdle(false);
    advanceTo(12000);
    ctrl.setIdle(true);
    advanceTo(31999);
    expect(sends).toEqual([]);
    advanceTo(32000);
    expect(sends).toEqual([{ t: 32000, type: "silence", ms: 20000 }]);
  });

  it("V8: canvas dedup", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    const A = () => "data:image/png;base64,AAA";
    const B = () => "data:image/png;base64,BBB";
    ctrl.canvasChanged(A);
    advanceTo(2000);
    ctrl.canvasChanged(A);
    advanceTo(5999);
    expect(sends).toEqual([]);
    advanceTo(6000);
    expect(sends).toEqual([{ t: 6000, type: "canvas", image: "data:image/png;base64,AAA" }]);
    sends = [];
    ctrl.settled({ type: "silent" });
    advanceTo(7000);
    ctrl.canvasChanged(A);
    advanceTo(11000);
    expect(sends).toEqual([]);
    advanceTo(12000);
    ctrl.canvasChanged(B);
    advanceTo(16000);
    expect(sends).toEqual([{ t: 16000, type: "canvas", image: "data:image/png;base64,BBB" }]);
  });

  it("V9: canvas too big rejected, ok accepted", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    const big = "data:image/png;base64," + "A".repeat(1_500_001 - 22);
    const ok = "data:image/png;base64," + "B".repeat(1_500_000 - 22);
    ctrl.canvasChanged(() => null);
    advanceTo(4000);
    expect(sends).toEqual([]);
    ctrl.canvasChanged(() => big);
    advanceTo(8000);
    expect(sends).toEqual([]);
    ctrl.canvasChanged(() => ok);
    advanceTo(12000);
    expect(sends).toEqual([{ t: 12000, type: "canvas", image: ok }]);
    expect(ok.length).toBe(1_500_000);
  });

  it("V10: turnBoundary resets partial state", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(5));
    advanceTo(1000);
    ctrl.turnBoundary();
    advanceTo(4000);
    ctrl.partial(W(3));
    advanceTo(6999);
    expect(sends).toEqual([]);
    advanceTo(7000);
    expect(sends).toEqual([{ t: 7000, type: "partial", text: W(3) }]);
  });

  it("V11: partial after settled with fewer words", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(10));
    advanceTo(500);
    ctrl.settled({ type: "silent" });
    ctrl.partial(W(4));
    advanceTo(3499);
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(10) }]);
    advanceTo(3500);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(10) },
      { t: 3500, type: "partial", text: W(4) },
    ]);
  });

  it("V12: send returns false, retries on next partial", () => {
    resetFake();
    sendOk = false;
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(8) }]);
    sendOk = true;
    advanceTo(100);
    ctrl.partial(W(8));
    advanceTo(200);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 100, type: "partial", text: W(8) },
    ]);
  });

  it("V13: partial before canvas", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    ctrl.partial(W(12));
    ctrl.canvasChanged(() => "data:image/png;base64,CCC");
    advanceTo(5000);
    ctrl.settled({ type: "silent" });
    advanceTo(5100);
    ctrl.settled({ type: "silent" });
    advanceTo(5200);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 5000, type: "partial", text: W(12) },
      { t: 5100, type: "canvas", image: "data:image/png;base64,CCC" },
    ]);
  });

  it("V14: dispose clears timers", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(3));
    ctrl.canvasChanged(() => "data:image/png;base64,DDD");
    ctrl.dispose();
    expect(timerQueue).toEqual([]);
    advanceTo(60000);
    ctrl.setIdle(true);
    ctrl.partial(W(9));
    ctrl.activity();
    expect(sends).toEqual([]);
  });

  it("V15: not idle, nothing sent until idle", () => {
    const ctrl = makeController();
    ctrl.partial(W(9));
    advanceTo(3000);
    ctrl.setIdle(true);
    advanceTo(3100);
    expect(sends).toEqual([{ t: 3000, type: "partial", text: W(9) }]);
  });
});

// Review 1 additions (stage-08-review.md G1): vectors V16-V30 and H5, verified against the reviewer reference.
describe("turn controller vectors (review 1 additions)", () => {
  beforeEach(resetFake);
  const A = "data:image/png;base64,AAA";
  const B = "data:image/png;base64,BBB";

  it('H5: "s0" -> 0751b736 (zero-padded)', () => {
    expect(hashString("s0")).toBe("0751b736");
  });

  it("V16: silence timer while a partial is in flight re-arms 10 s later", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(20000);
    advanceTo(25000);
    ctrl.settled({ type: "silent" });
    advanceTo(29999);
    advanceTo(30000);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 30000, type: "silence", ms: 30000 },
    ]);
  });

  it("V17: a refused silence send re-arms 10 s later", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    sendOk = false;
    advanceTo(20000);
    sendOk = true;
    advanceTo(29999);
    advanceTo(30000);
    expect(sends).toEqual([
      { t: 20000, type: "silence", ms: 20000 },
      { t: 30000, type: "silence", ms: 30000 },
    ]);
  });

  it("V18: sending a partial clears its wait timer (only the silence timer is left)", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(8) }]);
    expect(timerQueue.map((tm) => tm.at)).toEqual([20000]);
  });

  it("V19: nothing else is sent while a canvas step is in flight", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.canvasChanged(() => A);
    advanceTo(4000);
    advanceTo(4500);
    ctrl.partial(W(8));
    advanceTo(5000);
    ctrl.settled({ type: "silent" });
    expect(sends).toEqual([
      { t: 4000, type: "canvas", image: A },
      { t: 5000, type: "partial", text: W(8) },
    ]);
  });

  it("V20: a refused canvas send is retried on the next flush", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.canvasChanged(() => A);
    sendOk = false;
    advanceTo(4000);
    sendOk = true;
    advanceTo(4100);
    ctrl.setIdle(true);
    expect(sends).toEqual([
      { t: 4000, type: "canvas", image: A },
      { t: 4100, type: "canvas", image: A },
    ]);
  });

  it("V21: a sent canvas is not re-read on later flushes", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    let reads = 0;
    let img = A;
    ctrl.canvasChanged(() => {
      reads++;
      return img;
    });
    advanceTo(4000);
    advanceTo(4100);
    ctrl.settled({ type: "silent" });
    img = B;
    advanceTo(4200);
    ctrl.setIdle(true);
    expect(sends).toEqual([{ t: 4000, type: "canvas", image: A }]);
    expect(reads).toBe(1);
  });

  it("V22: a partial counts as activity for the silence timer", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(15000);
    ctrl.partial(W(1));
    advanceTo(18000);
    advanceTo(18100);
    ctrl.settled({ type: "silent" });
    advanceTo(34999);
    advanceTo(35000);
    expect(sends).toEqual([
      { t: 18000, type: "partial", text: W(1) },
      { t: 35000, type: "silence", ms: 20000 },
    ]);
  });

  it("V23: the 3 s wait runs from the first unsent word", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(3));
    advanceTo(1000);
    ctrl.partial(W(4));
    advanceTo(2999);
    expect(sends).toEqual([]);
    advanceTo(3000);
    expect(sends).toEqual([{ t: 3000, type: "partial", text: W(4) }]);
  });

  it("V24: turnBoundary resets the sent-word count", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(100);
    ctrl.settled({ type: "silent" });
    advanceTo(200);
    ctrl.turnBoundary();
    ctrl.partial(W(8));
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 200, type: "partial", text: W(8) },
    ]);
  });

  it("V25: turnBoundary counts as activity and lifts the two-prompt cap", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(20000);
    advanceTo(20100);
    ctrl.settled({ type: "hint", rung: 0 });
    advanceTo(40100);
    advanceTo(40200);
    ctrl.settled({ type: "hint", rung: 1 });
    advanceTo(60000);
    ctrl.turnBoundary();
    advanceTo(79999);
    advanceTo(80000);
    expect(sends).toEqual([
      { t: 20000, type: "silence", ms: 20000 },
      { t: 40100, type: "silence", ms: 20000 },
      { t: 80000, type: "silence", ms: 20000 },
    ]);
  });

  it("V26: a new stroke while a canvas is due restarts the 4 s idle wait", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    ctrl.canvasChanged(() => A);
    advanceTo(4000);
    advanceTo(5000);
    ctrl.canvasChanged(() => B);
    advanceTo(6000);
    ctrl.settled({ type: "silent" });
    advanceTo(8999);
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(8) }]);
    advanceTo(9000);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 9000, type: "canvas", image: B },
    ]);
  });

  it("V27: a canvas change counts as activity for the silence timer", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(15000);
    ctrl.canvasChanged(() => null);
    advanceTo(34999);
    expect(sends).toEqual([]);
    advanceTo(35000);
    expect(sends).toEqual([{ t: 35000, type: "silence", ms: 20000 }]);
  });

  it("V28: settled() with nothing in flight is ignored", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    advanceTo(15000);
    ctrl.settled({ type: "hint", rung: 0 });
    advanceTo(20000);
    expect(sends).toEqual([{ t: 20000, type: "silence", ms: 20000 }]);
  });

  it("V29: only spoken replies to silence count toward the cap", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(100);
    ctrl.settled({ type: "realign", misconceptionId: "m1" });
    advanceTo(20100);
    advanceTo(20200);
    ctrl.settled({ type: "hint", rung: 0 });
    advanceTo(40200);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 20100, type: "silence", ms: 20000 },
      { t: 40200, type: "silence", ms: 20000 },
    ]);
  });

  it("V30: a silent reply keeps a live silence timer", () => {
    const ctrl = makeController();
    ctrl.setIdle(true);
    ctrl.partial(W(8));
    advanceTo(100);
    ctrl.settled({ type: "silent" });
    advanceTo(19999);
    expect(sends).toEqual([{ t: 0, type: "partial", text: W(8) }]);
    advanceTo(20000);
    expect(sends).toEqual([
      { t: 0, type: "partial", text: W(8) },
      { t: 20000, type: "silence", ms: 20000 },
    ]);
  });
});
