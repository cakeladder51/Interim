// Stage 7 (voice in/out) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-07-mutants.mjs --only=pcm,chunker,model     (~3 min)
//   node agent-os/review/stage-07-mutants.mjs --only=ttshandler             (~3 min)
//   node agent-os/review/stage-07-mutants.mjs --restore     (restore files from on-disk backups after a kill)
//   node agent-os/review/stage-07-mutants.mjs --list        (list mutation counts by group)
//   node agent-os/review/stage-07-mutants.mjs --only=pcm --label="clamp"   (only labels containing the substring)
//   node agent-os/review/stage-07-mutants.mjs --only=controller --part=1/2 (first half; then --part=2/2)
//   node agent-os/review/stage-07-mutants.mjs --dry         (check every anchor resolves; "caught" = anchors found)
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert, runs only the group's test files, records caught/missed.
// Every touched file is restored after each mutation and byte-verified at the end.
// On-disk backups (os.tmpdir()/interim-review/backup-s7) survive a hard kill: run --restore.
// Output is compact: "caught X/Y", then one line per missed or skipped mutation.
// "SKIPPED: NOT FOUND" means the code moved; re-anchor that entry (don't drop it).
//
// Round 1 (stage-07-review.md): groups pcm, chunker, ttshandler, model swept.
// Round 2: relayclient, tts, controller added against the fixed code (one entry per brief rule in §4/§5/§6 + B/R fixes).
// Suggested chunks (each < 10 min): --only=pcm,chunker,model | --only=ttshandler | --only=relayclient | --only=tts
//   | --only=controller --part=1/2 | --only=controller --part=2/2
// Entries marked EQUIVALENT are expected to be MISSED.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const F = {
  pcm: { path: `${repo}/src/client/voice/pcm-encoder.ts`, test: "tests/voice-pcm.test.ts" },
  chunker: { path: `${repo}/src/client/voice/sentence-chunker.ts`, test: "tests/voice-chunker.test.ts" },
  relayclient: { path: `${repo}/src/client/voice/relay-client.ts`, test: "tests/voice-relay-client.test.ts" },
  tts: { path: `${repo}/src/client/voice/tts-player.ts`, test: "tests/voice-tts-player.test.ts" },
  controller: { path: `${repo}/src/client/voice/voice-controller.ts`, test: "tests/voice-controller.test.ts" },
  ttshandler: { path: `${repo}/src/server/tts-handler.ts`, test: "tests/tts-route.test.ts" },
  model: { path: `${repo}/src/client/interview-model.ts`, test: "tests/interview-model.test.ts" },
};
const bdir = join(tmpdir(), "interim-review", "backup-s7");

// [label, group, from, to, nth?]   nth = 0-based occurrence when `from` is not unique
const M = [
  // ---- pcm (src/client/voice/pcm-encoder.ts) ----
  ["pcm: non-integer rate accepted", "pcm", "!Number.isInteger(inputRate) || ", ""],
  ["pcm: min rate 16000 → 8000", "pcm", "inputRate < TARGET_SAMPLE_RATE", "inputRate < 8000"],
  ["pcm: float ratio boundary", "pcm", "Math.floor(((outputK + 1) * inputRate) / TARGET_SAMPLE_RATE)", "Math.floor((outputK + 1) * (inputRate / TARGET_SAMPLE_RATE))"],
  ["pcm: boundary off by one", "pcm", "Math.floor(((outputK + 1) * inputRate) / TARGET_SAMPLE_RATE)", "Math.floor(((outputK + 1) * inputRate) / TARGET_SAMPLE_RATE) + 1"],
  ["pcm: no clamp", "pcm", "Math.max(-1, Math.min(1, mean))", "mean"],
  ["pcm: scale 32767 → 32768", "pcm", "Math.round(clamped * 32767)", "Math.round(clamped * 32768)"],
  ["pcm: round → floor", "pcm", "Math.round(clamped * 32767)", "Math.floor(clamped * 32767)"],
  ["pcm: big-endian frames", "pcm", "frame[i * 2] = sample & 0xff;\n        frame[i * 2 + 1] = (sample >> 8) & 0xff;", "frame[i * 2 + 1] = sample & 0xff;\n        frame[i * 2] = (sample >> 8) & 0xff;"],
  ["pcm: big-endian flush", "pcm", "frame[i * 2] = samples[i] & 0xff;\n      frame[i * 2 + 1] = (samples[i] >> 8) & 0xff;", "frame[i * 2 + 1] = samples[i] & 0xff;\n      frame[i * 2] = (samples[i] >> 8) & 0xff;"],
  ["pcm: sum not reset per window", "pcm", "        runningSum = 0;\n        count = 0;", "        count = 0;"],
  ["pcm: flush keeps samples", "pcm", "const samples = outputSamples.splice(0);", "const samples = outputSamples.slice(0);"],
  ["pcm: flush of empty returns empty frame", "pcm", "if (outputSamples.length === 0) {\n      return null;\n    }", ""],
  ["pcm: default frame size", "pcm", "export const FRAME_SAMPLES = 1600;", "export const FRAME_SAMPLES = 1024;"],
  // ---- chunker (src/client/voice/sentence-chunker.ts) ----
  ["chunker: closing quotes not kept", "chunker", "/[.?!]+[\"')\\]]*\\s+|\\n+/", "/[.?!]+\\s+|\\n+/"],
  ["chunker: no newline split", "chunker", "/[.?!]+[\"')\\]]*\\s+|\\n+/", "/[.?!]+[\"')\\]]*\\s+/"],
  ["chunker: no whitespace required", "chunker", "/[.?!]+[\"')\\]]*\\s+|\\n+/", "/[.?!]+[\"')\\]]*\\s*|\\n+/"],
  ["chunker: chunk not trimmed", "chunker", "const chunk = buffer.slice(0, endIdx).trim();", "const chunk = buffer.slice(0, endIdx);"],
  ["chunker: empty chunk emitted", "chunker", "if (chunk.length > 0) {\n          chunks.push(chunk);\n        }\n        continue;\n      }\n\n      // Step 2", "chunks.push(chunk);\n        continue;\n      }\n\n      // Step 2"],
  ["chunker: max 200 → 201", "chunker", "export const MAX_CHUNK_CHARS = 200;", "export const MAX_CHUNK_CHARS = 201;"],
  ["chunker: long cut at first space", "chunker", 'buffer.lastIndexOf(" ", MAX_CHUNK_CHARS)', 'buffer.indexOf(" ")'],
  ["chunker: no hard cut", "chunker", "cut = MAX_CHUNK_CHARS;", "cut = buffer.length;"],
  ["chunker: flush keeps buffer", "chunker", '      const result = buffer.trim();\n      buffer = "";', "      const result = buffer.trim();"],
  ["chunker: flush empty → empty string", "chunker", "return result.length > 0 ? result : null;", "return result;"],
  ["chunker: reset no-op", "chunker", 'reset(): void {\n      buffer = "";', "reset(): void {\n      void buffer;"],
  // ---- ttshandler (src/server/tts-handler.ts) ----
  ["tts-h: URL changed", "ttshandler", '"https://api.openai.com/v1/audio/speech"', '"https://api.openai.com/v1/audio/speec"'],
  ["tts-h: model changed", "ttshandler", '"gpt-4o-mini-tts"', '"tts-1"'],
  ["tts-h: voice changed", "ttshandler", 'TTS_VOICE = "alloy"', 'TTS_VOICE = "nova"'],
  ["tts-h: max chars 1000 → 1001", "ttshandler", "TTS_MAX_CHARS = 1000", "TTS_MAX_CHARS = 1001"],
  ["tts-h: timeout 10 s → 20 s", "ttshandler", "TTS_TIMEOUT_MS = 10_000", "TTS_TIMEOUT_MS = 20_000"],
  ["tts-h: no-store removed", "ttshandler", 'const headers = { "Cache-Control": "no-store" };', "const headers = {};"],
  ["tts-h: empty key accepted", "ttshandler", 'if (!key || key === "") {', "if (key === undefined) {"],
  ["tts-h: warns every request", "ttshandler", "        warned = true;", ""],
  ["tts-h: 503 code changed", "ttshandler", 'code: "tts_unavailable"', 'code: "unavailable"'],
  ["tts-h: 503 status → 500", "ttshandler", "status: 503,", "status: 500,"],
  ["tts-h: non-string text accepted", "ttshandler", 'typeof (body as Record<string, unknown>).text !== "string"', "(body as Record<string, unknown>).text === undefined"],
  ["tts-h: empty text accepted", "ttshandler", 'trimmed === "" || ', ""],
  ["tts-h: length limit off by one", "ttshandler", "trimmed.length > TTS_MAX_CHARS", "trimmed.length >= TTS_MAX_CHARS"],
  ["tts-h: 400 message changed", "ttshandler", 'message: "Invalid TTS request."', 'message: "Bad request."', 0],
  ["tts-h: input untrimmed", "ttshandler", "input: trimmed,", "input: text,"],
  ["tts-h: format changed", "ttshandler", 'response_format: "mp3"', 'response_format: "wav"'],
  ["tts-h: Bearer dropped", "ttshandler", 'Authorization: "Bearer " + key,', "Authorization: key,"],
  ["tts-h: no signal", "ttshandler", "        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),\n", ""], // re-anchored in round 2 (H1)
  ["H1: timeout via plain AbortController", "ttshandler", "signal: AbortSignal.timeout(TTS_TIMEOUT_MS),", "signal: new AbortController().signal,"],
  ["tts-h: upstream failure passed as 200", "ttshandler", "if (!upstream.ok) {", "if (false) {"],
  ["tts-h: audio content type", "ttshandler", '"Content-Type": "audio/mpeg"', '"Content-Type": "audio/mp3"'],
  ["tts-h: 502 → 500 (upstream not ok)", "ttshandler", "status: 502,", "status: 500,", 0],
  ["tts-h: 502 → 500 (fetch throws)", "ttshandler", "status: 502,", "status: 500,", 1],
  ["tts-h: 502 code changed", "ttshandler", 'code: "tts_failed"', 'code: "failed"', 0],
  ["tts-h: log status wrong", "ttshandler", "status: upstream.status,", "status: 0,"],
  ["tts-h: log chars missing", "ttshandler", "            chars: trimmed.length,\n", "", 0],
  ["tts-h: key logged", "ttshandler", 'tag: "tts_error",\n            status: upstream.status,', 'tag: "tts_error", key,\n            status: upstream.status,'],
  ["tts-h: text logged", "ttshandler", 'tag: "tts_error",\n          status: 0,', 'tag: "tts_error", text: trimmed,\n          status: 0,'],
  // ---- model (src/client/interview-model.ts; unfrozen edit only) ----
  ["model: source ignored", "model", 'text: text.trim(), source },', 'text: text.trim(), source: "typed" },'],
  ["model: default source voice", "model", 'source: "typed" | "voice" = "typed"', 'source: "typed" | "voice" = "voice"'],

  // ======== round 2 (stage-07-review.md fixes applied): previously deferred groups ========
  // ---- relayclient (src/client/voice/relay-client.ts) ----
  ["rc: token failure kind", "relayclient", 'reject(new RelayConnectError("unavailable", null));', 'reject(new RelayConnectError("closed", null));'],
  ["rc: auth token wrong", "relayclient", 'socket.send(JSON.stringify({ type: "auth", token: token.token }));', 'socket.send(JSON.stringify({ type: "auth", token: "x" + token.token }));'],
  ["rc: binary data parsed", "relayclient", 'if (typeof event.data !== "string") {\n            return;\n          }', "if (false) {\n            return;\n          }"],
  ["rc: schema unchecked", "relayclient", "if (!parsed.success) {\n            return;\n          }\n          const data = parsed.data;", "const data = (parsed.success ? parsed.data : msg);"],
  ["rc: messages before ready forwarded", "relayclient", "// Ignore other messages before ready\n            return;", "// Ignore other messages before ready"],
  ["rc: 4001 not unauthorized", "relayclient", 'case 4001:\n                kind = "unauthorized";', 'case 4001:\n                kind = "closed";'],
  ["rc: 1013 not busy", "relayclient", 'kind = "busy";', 'kind = "closed";'],
  ["rc: 4503 not upstream", "relayclient", "case 4502:\n              case 4503:", "case 4502:"],
  ["rc: 4502 not upstream", "relayclient", "case 4502:\n              case 4503:", "case 4503:"],
  ["rc: default kind upstream", "relayclient", 'default:\n                kind = "closed";', 'default:\n                kind = "upstream";'],
  ["rc: error event rejects", "relayclient", "// Ignore error event, close always follows", 'reject(new RelayConnectError("closed", null));'],
  ["rc: ready timer ×100", "relayclient", "}, readyTimeoutMs);", "}, readyTimeoutMs * 100);"],
  ["rc: timeout doesn't close", "relayclient", "dead = true;\n          socket.close(1000);", "dead = true;"],
  ["R1: dead never set", "relayclient", "          dead = true;\n", ""],
  ["R1: message ignores dead", "relayclient", "if (dead) return;\n\n          // Step 3", "// Step 3"],
  // EQUIVALENT (expected MISSED): after a timeout the promise is already rejected, so a second reject is a no-op and onClose is only reachable after ready.
  ["R1: close ignores dead", "relayclient", 'socket.addEventListener("close", (event) => {\n          if (dead) return;', 'socket.addEventListener("close", (event) => {'],
  ["rc: partial dropped", "relayclient", "opts.handlers.onPartial(data.text);", ""],
  ["rc: turn_start dropped", "relayclient", "opts.handlers.onTurnStart(data.turnId);", ""],
  ["rc: turn_complete dropped", "relayclient", "opts.handlers.onTurnComplete(data.turnId, data.text);", ""],
  ["rc: onClose not once", "relayclient", "if (!onCloseCalled) {", "if (true) {"],
  ["rc: end() not intentional", "relayclient", 'intentionalClose = true;\n            socket.send(JSON.stringify({ type: "end" }));', 'socket.send(JSON.stringify({ type: "end" }));'],
  ["rc: close() not intentional", "relayclient", "intentionalClose = true;\n          socket.close(1000);", "socket.close(1000);"],
  ["rc: close() without 1000", "relayclient", "intentionalClose = true;\n          socket.close(1000);", "intentionalClose = true;\n          socket.close();"],
  ["rc: sendAudio ignores readyState", "relayclient", "if (socket.readyState === 1) {\n            socket.send(frame);", "if (true) {\n            socket.send(frame);"],
  ["rc: end() on closed socket sends", "relayclient", "if (socket.readyState !== 1) {\n              resolveEnd();\n              return;\n            }", ""],
  ["rc: end message type", "relayclient", 'socket.send(JSON.stringify({ type: "end" }));', 'socket.send(JSON.stringify({ type: "stop" }));'],
  ["R2: close doesn't resolve end()", "relayclient", "pendingEnd();\n              pendingEnd = null;", "pendingEnd = null;"],
  ["rc: end timeout doesn't close", "relayclient", "pendingEnd = null;\n              socket.close(1000);\n              resolveEnd();", "pendingEnd = null;\n              resolveEnd();"],
  ["rc: end timer ×1000", "relayclient", "}, endTimeoutMs);", "}, endTimeoutMs * 1000);"],
  ["rc: ready timeout constant", "relayclient", "RELAY_READY_TIMEOUT_MS = 12_000", "RELAY_READY_TIMEOUT_MS = 10_000"],
  ["rc: end timeout constant", "relayclient", "RELAY_END_TIMEOUT_MS = 3_000", "RELAY_END_TIMEOUT_MS = 2_000"],
  ["rc: error name", "relayclient", 'this.name = "RelayConnectError";', ""],
  // ---- tts (src/client/voice/tts-player.ts) ----
  ["tts: no prefetch", "tts", "item.audio = deps.fetchAudio(trimmed, item.ctrl.signal);", "const c = item.ctrl;\n      item.audio = Promise.resolve().then(() => deps.fetchAudio(trimmed, c.signal));"],
  ["tts: blank text enqueued", "tts", 'if (trimmed === "") return;', ""],
  ["tts: fetches in fallback mode", "tts", "if (!fallback) {\n      item.ctrl", "if (true) {\n      item.ctrl"],
  ["tts: concurrent runs", "tts", "if (!running) {\n      void run(gen);", "if (true) {\n      void run(gen);"],
  ["tts: speaking emitted per call", "tts", "if (v !== speakingFlag) {", "if (true) {"],
  ["tts: drained without speaking(false)", "tts", "running = false;\n      setSpeaking(false);\n    }\n  }", "running = false;\n    }\n  }"],
  ["tts: sticky doesn't abort", "tts", "item.ctrl.abort();\n        item.ctrl = null;", "item.ctrl = null;"],
  // likely EQUIVALENT: the aborted fetch rejects, is counted as a failure while already sticky, and the item is spoken via the fallback either way.
  ["tts: sticky keeps the fetch promise", "tts", "item.ctrl = null;\n        item.audio = null;", "item.ctrl = null;"],
  ["tts: 503 not sticky", "tts", "if (err instanceof TtsUnavailableError) {\n      sticky();\n    } else {", "if (false) {\n      sticky();\n    } else {"],
  ["tts: 2 failures → 3", "tts", "if (++failures >= 2) {", "if (++failures >= 3) {"],
  ["tts: success doesn't reset counter", "tts", "if (g === gen) {\n          failures = 0;", "if (g === gen) {\n          void failures;"],
  ["tts: playback failure not counted", "tts", "fail(err);\n        await speakWithFallback(item);", "await speakWithFallback(item);"],
  ["tts: playback failure not spoken", "tts", "fail(err);\n        await speakWithFallback(item);", "fail(err);"],
  ["tts: fetch failure not spoken", "tts", "      fail(err);\n      await speakWithFallback(item);\n    }\n  }", "      fail(err);\n    }\n  }"],
  ["tts: stale audio still plays", "tts", "const bytes = await item.audio;\n      if (g !== gen) return;", "const bytes = await item.audio;"],
  ["tts: stale fetch error counted", "tts", "} catch (err) {\n      if (g !== gen) return;\n      fail(err);", "} catch (err) {\n      fail(err);"],
  ["tts: stop() keeps current fetch", "tts", "if (current?.ctrl) {\n      current.ctrl.abort();\n    }", ""],
  ["tts: stop() keeps queued fetches", "tts", "for (const item of queue) {\n      item.ctrl?.abort();\n    }", ""],
  ["tts: stop() keeps playback", "tts", "playback?.stop();", ""],
  ["tts: stop() no speaking(false)", "tts", "running = false;\n    setSpeaking(false);\n  }\n\n  function speaking", "running = false;\n  }\n\n  function speaking"],
  ["tts: stop() no generation bump", "tts", "function stop(): void {\n    gen++;", "function stop(): void {"],
  ["tts: error name", "tts", 'this.name = "TtsUnavailableError";', ""],
  // ---- controller (src/client/voice/voice-controller.ts) ----
  ["vc: startMic not synchronous", "controller", ["micPromise = deps.startMic((samples) => {", "      });\n    } catch {\n      updateSnapshot({ status: \"unavailable\", message: VOICE_MESSAGES.mic });"], ["micPromise = Promise.resolve().then(() => deps.startMic((samples) => {", "      }));\n    } catch {\n      updateSnapshot({ status: \"unavailable\", message: VOICE_MESSAGES.mic });"]],
  ["vc: enable guard removed", "controller", 'if (snap.status !== "off" && snap.status !== "unavailable") return;', ""],
  ["vc: enable keeps message", "controller", 'updateSnapshot({ status: "starting", message: null, partial: null });', 'updateSnapshot({ status: "starting", partial: null });'],
  ["vc: audio while not listening", "controller", 'if (snap.status !== "listening") return;', ""],
  ["vc: encoder ignores mic rate", "controller", "encoder = createPcmEncoder(m.sampleRate);", "encoder = createPcmEncoder(48000);"],
  ["vc: bad rate falls through", "controller", 'updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });\n          return;\n        }\n\n        // Connect', 'updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });\n        }\n\n        // Connect'],
  ["vc: bad rate mic not stopped", "controller", "} catch {\n          m.stop();\n          mic = null;", "} catch {\n          mic = null;"],
  ["vc: late mic not stopped", "controller", "if (disposed || gen !== generation) {\n          m.stop();\n          return;", "if (disposed || gen !== generation) {\n          return;"],
  ["vc: mic rejection → relay message", "controller", '// micPromise rejected - mic error path\n        if (disposed || gen !== generation) return;\n        updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.mic });', '// micPromise rejected - mic error path\n        if (disposed || gen !== generation) return;\n        updateSnapshot({ status: "unavailable", message: VOICE_MESSAGES.relay });'],
  ["vc: partial not set", "controller", "updateSnapshot({ partial: text });", ""],
  ["vc: barge-in ignores speaking()", "controller", "if (tts.speaking()) {", "if (true) {"],
  ["vc: barge-in threshold 2 → 1", "controller", "if (words >= BARGE_IN_MIN_WORDS) {", "if (words >= 1) {"],
  ["vc: barge-in doesn't stop", "controller", "tts.stop();\n                chunker.reset();\n                suppressed = true;", "chunker.reset();\n                suppressed = true;"],
  ["vc: barge-in doesn't suppress", "controller", "chunker.reset();\n                suppressed = true;", "chunker.reset();"],
  // likely EQUIVALENT: suppressed drops tokens and done resets the chunker, and the next request resets it too.
  ["vc: barge-in keeps chunker", "controller", "tts.stop();\n                chunker.reset();\n                suppressed = true;", "tts.stop();\n                suppressed = true;"],
  ["vc: stale partial applied", "controller", "onPartial: (text: string) => {\n            if (disposed || gen !== generation) return;", "onPartial: (text: string) => {"],
  ["vc: stale turn delivered", "controller", "onTurnComplete: (_turnId: string, text: string) => {\n            if (disposed || gen !== generation) return;", "onTurnComplete: (_turnId: string, text: string) => {"],
  ["vc: turn untrimmed", "controller", "deps.onTurn(trimmed);", "deps.onTurn(text);"],
  ["vc: turn keeps partial", "controller", "updateSnapshot({ partial: null });\n            const trimmed", "const trimmed"],
  ["vc: empty turn delivered", "controller", "if (trimmed.length > 0) {", "if (true) {"],
  ["vc: no reconnect", "controller", 'if (!info.intentional && (snap.status === "listening" || snap.status === "reconnecting")) {', "if (false) {"],
  ["vc: intentional close reconnects", "controller", 'if (!info.intentional && (snap.status === "listening" || snap.status === "reconnecting")) {', 'if (snap.status === "listening" || snap.status === "reconnecting") {'],
  ["vc: stale close reconnects", "controller", "onClose: (info) => {\n            if (disposed || gen !== generation) return;", "onClose: (info) => {"],
  ["B2.4: old connection kept while reconnecting", "controller", "connection = null;\n              // Unexpected close", "// Unexpected close"],
  ["vc: reconnecting keeps partial", "controller", 'updateSnapshot({ status: "reconnecting", partial: null });', 'updateSnapshot({ status: "reconnecting" });'],
  ["vc: stale reconnect not closed", "controller", "if (disposed || gen !== generation) {\n                    conn.close();", "if (disposed || gen !== generation) {"],
  ["vc: reconnect failure message", "controller", "message: VOICE_MESSAGES.dropped", "message: VOICE_MESSAGES.relay"],
  ["vc: reconnect failure keeps mic", "controller", "mic?.stop();\n                  mic = null;", "mic = null;"],
  ["B2.2: stale connection not closed", "controller", "if (disposed || gen !== generation) {\n              conn.close();", "if (disposed || gen !== generation) {"],
  ["vc: busy message", "controller", 'if (err.kind === "busy") {', "if (false) {"],
  ["vc: relay failure keeps mic", "controller", "if (mic) {\n              mic.stop();\n              mic = null;\n            }\n            encoder = null;\n\n            // Determine", "encoder = null;\n\n            // Determine"],
  ["vc: disable no generation bump", "controller", "// Bump generation\n    generation++;\n\n    updateSnapshot({ status: \"off\"", "updateSnapshot({ status: \"off\""],
  ["vc: disable keeps partial", "controller", 'updateSnapshot({ status: "off", message: null, partial: null });', 'updateSnapshot({ status: "off", message: null });'],
  ["vc: disable keeps mic", "controller", "// Stop mic\n    if (mic) {\n      mic.stop();", "// Stop mic\n    if (mic) {"],
  ["vc: disable no end()", "controller", "connection.end().catch(() => {});", ""],
  ["vc: disable no tts.stop", "controller", "// Stop TTS\n    tts.stop();", "// Stop TTS"],
  ["B2.3: dispose before disable", "controller", "disable();\n    disposed = true;", "disposed = true;\n    disable();"],
  ["vc: enable after dispose", "controller", "function enable(): void {\n    if (disposed) return;", "function enable(): void {"],
  ["B2.5: onChange on every update", "controller", "if (\n      next.status === snap.status &&", "if (\n      false &&"],
  ["vc: speaking not in snapshot", "controller", "updateSnapshot({ speaking });", ""],
  ["vc: request keeps speech", "controller", 'case "request":\n        tts.stop();', 'case "request":'],
  ["vc: request keeps suppression", "controller", "suppressed = false;\n        break;", "break;"],
  ["vc: token while off", "controller", 'case "token":\n        if (snap.status === "off" || suppressed) return;', 'case "token":\n        if (suppressed) return;'],
  ["vc: token while suppressed", "controller", 'case "token":\n        if (snap.status === "off" || suppressed) return;', 'case "token":\n        if (snap.status === "off") return;'],
  ["vc: done doesn't flush", "controller", "const flushChunk = chunker.flush();\n        if (flushChunk) {\n          tts.enqueue(flushChunk);\n        }\n        break;", "break;"],
  ["vc: done while off flushes", "controller", 'case "done":\n        if (snap.status === "off" || suppressed) {', 'case "done":\n        if (suppressed) {'],
  ["vc: failed keeps chunker", "controller", 'case "failed":\n        chunker.reset();', 'case "failed":'],
  ["vc: speakNow while off", "controller", 'if (snap.status === "off") return;\n\n    tts.stop();', "tts.stop();"],
  ["vc: speakNow keeps suppression", "controller", "chunker.reset();\n    suppressed = false;\n\n    const chunks", "chunker.reset();\n\n    const chunks"],
  ["vc: speakNow no flush", "controller", "const flushChunk = chunker.flush();\n    if (flushChunk) {\n      tts.enqueue(flushChunk);\n    }\n  }\n\n  function stopSpeaking", "}\n\n  function stopSpeaking"],
  ["vc: stopSpeaking no suppress", "controller", "chunker.reset();\n    suppressed = true;\n  }\n\n  function getSnapshot", "chunker.reset();\n  }\n\n  function getSnapshot"],
  ["vc: stopSpeaking no stop", "controller", "function stopSpeaking(): void {\n    if (disposed) return;\n    tts.stop();", "function stopSpeaking(): void {\n    if (disposed) return;"],
  ["vc: queueVoiceTurn separator", "controller", 'pending + " " + text.trim()', "pending + text.trim()"],
  ["vc: mic message text", "controller", 'mic: "Microphone unavailable. You can keep typing your answers."', 'mic: "Microphone unavailable."'],
  ["vc: barge-in constant", "controller", "BARGE_IN_MIN_WORDS = 2", "BARGE_IN_MIN_WORDS = 3"],
];

if (process.argv.includes("--list")) {
  for (const g of Object.keys(F)) console.log(`${g}: ${M.filter((m) => m[1] === g).length}`);
  process.exit(0);
}
if (process.argv.includes("--restore")) {
  let n = 0;
  for (const [k, v] of Object.entries(F)) if (existsSync(join(bdir, k))) { writeFileSync(v.path, readFileSync(join(bdir, k))); n++; }
  console.log(`restored ${n} file(s) from ${bdir}`); process.exit(0);
}

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const groups = only.length ? only : Object.keys(F);
const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8);
const orig = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, readFileSync(v.path)]));
mkdirSync(bdir, { recursive: true });
for (const k of Object.keys(F)) writeFileSync(join(bdir, k), orig[k]);
const restore = () => { for (const [k, v] of Object.entries(F)) writeFileSync(v.path, orig[k]); };
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(1); });

function replaceNth(src, from, to, nth) {
  const idxs = []; let i = -1;
  while ((i = src.indexOf(from, i + 1)) !== -1) idxs.push(i);
  if (idxs.length === 0) return { err: "NOT FOUND" };
  if (nth === undefined && idxs.length > 1) return { err: `AMBIGUOUS (${idxs.length})` };
  if ((nth ?? 0) >= idxs.length) return { err: "NOT FOUND (nth)" };
  return { out: src.slice(0, idxs[nth ?? 0]) + to + src.slice(idxs[nth ?? 0] + from.length) };
}
// `from`/`to` may be parallel arrays: a multi-spot revert (each anchor must be unique), applied in order.
function applyMutation(src, from, to, nth) {
  if (!Array.isArray(from)) return replaceNth(src, from, to, nth);
  let out = src;
  for (let i = 0; i < from.length; i++) {
    const r = replaceNth(out, from[i], to[i]);
    if (r.err) return r;
    out = r.out;
  }
  return { out };
}
const runTests = (files) => {
  let o = "";
  try { o = execSync(`npx vitest run ${files}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, timeout: 240000 }); }
  catch (e) { o = (e.stdout ?? "") + (e.stderr ?? ""); }
  return o.replace(/\x1b\[[0-9;]*m/g, "");
};

const [partK, partN] = ((process.argv.find((a) => a.startsWith("--part=")) ?? "--part=1/1").slice(7)).split("/").map(Number);
const selected = M.filter(([label, key]) => groups.includes(key) && (!labelFilter || label.includes(labelFilter)));
const sliceLen = Math.ceil(selected.length / partN);
const mine = selected.slice((partK - 1) * sliceLen, partK * sliceLen);

let total = 0, caught = 0; const lines = [];
for (const [label, key, from, to, nth] of mine) {
  total++;
  restore();
  const r = applyMutation(orig[key].toString("utf8"), from, to, nth);
  if (r.err) { lines.push(`SKIPPED (${r.err}): ${label}`); continue; }
  if (process.argv.includes("--dry")) { caught++; continue; }
  writeFileSync(F[key].path, r.out);
  const out = runTests(F[key].test);
  const summary = (out.match(/Tests\s+.*$/m) ?? [""])[0];
  if (/\d+ failed/.test(summary) || /Failed Suites|Error:/.test(out) && !/passed \(\d+\)\s*$/.test(summary)) caught++;
  else lines.push(`MISSED: ${label}`);
}
restore();
const bad = Object.entries(F).filter(([k, v]) => !readFileSync(v.path).equals(orig[k])).map(([k]) => k);
console.log(`groups=${groups.join(",")} caught ${caught}/${total}`);
for (const l of lines) console.log(l);
console.log(bad.length ? `RESTORE MISMATCH: ${bad.join(",")} — run with --restore` : "restore: all files byte-identical");
