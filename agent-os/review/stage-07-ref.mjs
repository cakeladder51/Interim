// Stage 7 reference implementations (pcm encoder, sentence chunker) used to verify the brief's test vectors.
// Run: node agent-os/review/stage-07-ref.mjs  — output must match the V1–V6 / C1–C11 tables in stage-07-voice-io.md.
const TARGET = 16000;
function createPcmEncoder(inputRate, frameSamples = 1600) {
  if (!Number.isInteger(inputRate) || inputRate < TARGET) throw new Error(`Unsupported input sample rate: ${inputRate}`);
  let consumed = 0, k = 0, boundary = Math.floor(((k + 1) * inputRate) / TARGET), sum = 0, count = 0;
  const frame = new Int16Array(frameSamples); let filled = 0;
  const toInt16 = (s) => Math.round(Math.max(-1, Math.min(1, s)) * 32767);
  const toBytes = (n) => { const b = new Uint8Array(n * 2); const dv = new DataView(b.buffer); for (let i = 0; i < n; i++) dv.setInt16(i * 2, frame[i], true); return b; };
  return {
    push(samples) {
      const out = [];
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i]; count++; consumed++;
        if (consumed === boundary) {
          frame[filled++] = toInt16(sum / count); sum = 0; count = 0; k++;
          boundary = Math.floor(((k + 1) * inputRate) / TARGET);
          if (filled === frameSamples) { out.push(toBytes(filled)); filled = 0; }
        }
      }
      return out;
    },
    flush() { if (filled === 0) return null; const b = toBytes(filled); filled = 0; sum = 0; count = 0; return b; },
  };
}
const i16 = (b) => Array.from({ length: b.length / 2 }, (_, i) => new DataView(b.buffer, b.byteOffset).getInt16(i * 2, true));
const hex = (b) => Buffer.from(b).toString("hex");

// V1: 48k, 4800 samples of 0.5 -> exactly one 3200-byte frame, every sample 16384
{ const e = createPcmEncoder(48000); const f = e.push(new Float32Array(4800).fill(0.5)); console.log("V1 frames", f.length, "bytes", f[0].length, "all16384", i16(f[0]).every((v) => v === 16384), "first4hex", hex(f[0].subarray(0, 4)), "flush", e.flush()); }
// V2: 48k frameSamples 4: [0,0.25,0.5, 1,1,1, -1,-1,-1, 2,2,2] -> one frame
{ const e = createPcmEncoder(48000, 4); const f = e.push(Float32Array.from([0, 0.25, 0.5, 1, 1, 1, -1, -1, -1, 2, 2, 2])); console.log("V2", f.length, JSON.stringify(f.map(i16)), hex(f[0])); }
// V3: 44.1k frameSamples 4: [0,0.5, 0.25,0.25,0.25, 0.5,0.5,0.5, -0.5,-0.5,-0.5]
{ const e = createPcmEncoder(44100, 4); const f = e.push(Float32Array.from([0, 0.5, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5])); console.log("V3", f.length, JSON.stringify(f.map(i16))); }
// V4: 16k identity frameSamples 3: [0.5,-0.5,0.25, 1] -> one frame [16384,-16383,8192], flush -> [32767]
{ const e = createPcmEncoder(16000, 3); const f = e.push(Float32Array.from([0.5, -0.5, 0.25, 1])); const fl = e.flush(); console.log("V4", JSON.stringify(f.map(i16)), "flush", JSON.stringify(i16(fl)), "flush2", e.flush()); }
// V5: split-invariance: 48k, 10000 pseudo-random samples, one push vs pushes of sizes 1,2,3,...; compare concatenated bytes
{ let x = 12345; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (const rate of [48000, 44100, 22050]) {
    const s = Float32Array.from({ length: 10000 }, rnd);
    const a = createPcmEncoder(rate); const A = [...a.push(s)]; const af = a.flush(); if (af) A.push(af);
    const b = createPcmEncoder(rate); const B = []; let i = 0, n = 1; while (i < s.length) { B.push(...b.push(s.subarray(i, i + n))); i += n; n = (n % 7) + 1; } const bf = b.flush(); if (bf) B.push(bf);
    const ca = Buffer.concat(A.map((u) => Buffer.from(u))), cb = Buffer.concat(B.map((u) => Buffer.from(u)));
    console.log("V5", rate, "equal", ca.equals(cb), "bytes", ca.length, "frames", A.length);
  } }
// V6: unsupported rates
for (const r of [8000, 15999, 44100.5]) { try { createPcmEncoder(r); console.log("V6", r, "NO THROW"); } catch (e) { console.log("V6", r, e.message); } }

// ---- sentence chunker ----
const MAX = 200;
function createSentenceChunker() {
  let buf = "";
  const BOUNDARY = /[.?!]+["')\]]*\s+|\n+/;
  return {
    push(text) {
      buf += text; const out = [];
      for (;;) {
        const m = BOUNDARY.exec(buf);
        if (m) { const end = m.index + m[0].length; const c = buf.slice(0, end).trim(); buf = buf.slice(end); if (c) out.push(c); continue; }
        if (buf.length > MAX) { let cut = buf.lastIndexOf(" ", MAX); if (cut <= 0) cut = MAX; const c = buf.slice(0, cut).trim(); buf = buf.slice(cut); if (c) out.push(c); continue; }
        break;
      }
      return out;
    },
    flush() { const c = buf.trim(); buf = ""; return c || null; },
    reset() { buf = ""; },
  };
}
const J = JSON.stringify;
{ const c = createSentenceChunker(); console.log("C1", J(c.push("Hello there. How")), J(c.push(" are you? I")), J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C2", J(c.push("Is it 3.5")), J(c.push("? Yes")), J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C3", J(c.push('He said "stop." Then')), J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C4", J(c.push("First line\nSecond")), J(c.flush())); }
{ const c = createSentenceChunker(); const r = c.push("word ".repeat(50)); console.log("C5", r.length, r[0].length, r[0].split(" ").length, J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C6", J(c.push("A. B! C? D")), J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C7", J(c.push("Wait... what")), J(c.flush())); }
{ const c = createSentenceChunker(); console.log("C8", J(c.push("   ")), J(c.flush())); }
{ const c = createSentenceChunker(); c.push("Dropped text"); c.reset(); console.log("C9", J(c.push("Kept. ")), J(c.flush())); }
{ const c = createSentenceChunker(); const t = "x".repeat(450); console.log("C10", J(c.push(t).map((s) => s.length)), J(c.flush()?.length)); }
{ const c = createSentenceChunker(); console.log("C11", J(c.push("Good.\n\nNext question: why?")), J(c.flush())); }
