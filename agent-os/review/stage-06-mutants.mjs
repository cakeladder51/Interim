// Stage 6 (speech-to-text relay) temporary-revert checks. Reusable; keep and extend.
//
// Usage (from the repo root):
//   node agent-os/review/stage-06-mutants.mjs --only=token,handler,map,config,wav,wavclient   (~5 min)
//   node agent-os/review/stage-06-mutants.mjs --only=server                                  (~8 min)
//   node agent-os/review/stage-06-mutants.mjs --restore     (restore files from on-disk backups after a kill)
//   node agent-os/review/stage-06-mutants.mjs --list        (list mutation labels by group)
//   node agent-os/review/stage-06-mutants.mjs --only=server --label="B2:"   (only labels containing the substring)
//   node agent-os/review/stage-06-mutants.mjs --only=server --part=1/2      (first half; then --part=2/2; ~5–6 min each)
//   node agent-os/review/stage-06-mutants.mjs --dry         (check every anchor resolves; "caught" = anchors found)
// Keep every run under 10 minutes (background jobs are hard-killed at 10 min).
//
// Each mutation: applies one revert, runs only the group's test files, records caught/missed.
// Every touched file is restored after each mutation and byte-verified at the end.
// On-disk backups (os.tmpdir()/interim-review/backup-s6) survive a hard kill: run --restore.
// Output is compact: "caught X/Y", then one line per missed or skipped mutation.
// "SKIPPED: NOT FOUND" means the code moved; re-anchor that entry (don't drop it).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const F = {
  token: { path: `${repo}/src/shared/relay-token.ts`, test: "tests/relay-token.test.ts tests/relay-route.test.ts" },
  handler: { path: `${repo}/src/server/relay-token-handler.ts`, test: "tests/relay-route.test.ts" },
  map: { path: `${repo}/relay/src/map-upstream.ts`, test: "tests/relay-map.test.ts" },
  config: { path: `${repo}/relay/src/config.ts`, test: "tests/relay-config.test.ts" },
  wav: { path: `${repo}/relay/src/wav.ts`, test: "tests/relay-wav.test.ts" },
  server: { path: `${repo}/relay/src/server.ts`, test: "tests/relay-server.test.ts" },
  wavclient: { path: `${repo}/relay/scripts/wav-client.ts`, test: "tests/relay-wav-client.test.ts" },
};
const bdir = join(tmpdir(), "interim-review", "backup-s6");

// [label, group, from, to, nth?]   nth = 0-based occurrence when `from` is not unique
const M = [
  // ---- token (src/shared/relay-token.ts) ----
  ["token: two dots allowed", "token", 'if (token.indexOf(".", dotIndex + 1) !== -1) {', "if (false) {"],
  ["token: signature not compared", "token", "if (!timingSafeEqual(actualSigBuffer, expectedSigDecoded)) {", "if (false) {"],
  ["token: expiry boundary >= → >", "token", "if (now >= (payload as { exp: number }).exp) {", "if (now > (payload as { exp: number }).exp) {"],
  ["token: nonce format unchecked", "token", "!/^[0-9a-f]{32}$/.test(", "!/^[\\s\\S]*$/.test("],
  ["token: empty configId allowed", "token", "((payload as Record<string, unknown>).configId as string).length === 0", "false"],
  ["token: version unchecked", "token", "(payload as Record<string, unknown>).v !== 1 ||", ""],
  ["token: sign over wrong data", "token", 'const sigBuffer = createHmac("sha256", secret).update(payloadPart).digest();', 'const sigBuffer = createHmac("sha256", secret).update(payloadPart + "x").digest();'],
  // ---- handler (src/server/relay-token-handler.ts) ----
  ["handler: secret min 32 → 31", "handler", "secret.length < 32", "secret.length < 31"],
  ["handler: url not required", "handler", "!secret || secret.length < 32 || !url", "!secret || secret.length < 32"],
  ["handler: no-store header removed", "handler", '"Cache-Control": "no-store", ', ""],
  ["handler: config not validated", "handler", "      getConfig(body.configId);", "      void body;"],
  ["handler: TTL changed", "handler", "const expiresAt = now + RELAY_TOKEN_TTL_MS;", "const expiresAt = now + 60_000;"],
  ["handler: nonce bytes 16 → 8", "handler", "deps.randomHex(16)", "deps.randomHex(8)"],
  // ---- map (relay/src/map-upstream.ts) ----
  ["map: final transcript forwarded", "map", 'if (final === true) {\n        return { kind: "ignore" };', 'if (false) {\n        return { kind: "ignore" };'],
  ["map: speechStart without turnId sent", "map", 'if (typeof turnId === "string") {\n        return { kind: "send", message: { type: "turn_start"', 'if (true) {\n        return { kind: "send", message: { type: "turn_start"'],
  ["map: upstream error text forwarded", "map", 'return { kind: "fatal", message: "Transcription service error" };', 'return { kind: "fatal", message: String(msg.message ?? "Transcription service error") };'],
  ["map: ready ignores type", "map", '&&\n    !("type" in msg)', ""],
  ["map: speechComplete without turnId", "map", 'if (typeof turnId === "string" && typeof transcript === "string") {', 'if (typeof transcript === "string") {'],
  // ---- config (relay/src/config.ts) ----
  ["config: secret min 32 → 31", "config", "secret.length < 32", "secret.length < 31"],
  ["config: api key not required", "config", '  if (!apiKey) {\n    errors.push("MODEL_API_KEY is missing");\n  }', ""],
  ["config: default port", "config", "let port = 8080;", "let port = 8081;"], // re-anchored after round-1 (was ": 8080;")
  ["config: default upstream", "config", '"wss://api.meta.ai/v1/asr/realtime"', '"wss://api.meta.ai/v1/asr/rt"'],
  ["config: origins not trimmed", "config", ".map((s) => s.trim())", ""],
  ["config: max sessions default", "config", "let maxSessions = 50;", "let maxSessions = 49;"],
  ["config: max sessions 0 accepted", "config", "parsed > 0", "parsed >= 0"],
  ["config: session ms default", "config", "maxSessionMs: 1_800_000", "maxSessionMs: 1_700_000"],
  ["config: pre-ready buffer default", "config", "preReadyBufferBytes: 64000", "preReadyBufferBytes: 32000"],
  ["B9: PORT range unchecked", "config", "if (parsedPort < 0 || parsedPort > 65535) {", "if (false) {"], // re-anchored in review-3 (round 2 split the check)
  // ---- wav (relay/src/wav.ts) ----
  ["wav: channels unchecked", "wav", "if (numChannels !== 1) {", "if (false) {"],
  ["wav: sample rate unchecked", "wav", "if (sampleRate !== 16000) {", "if (false) {"],
  ["wav: bit depth unchecked", "wav", "if (bitsPerSample !== 16) {", "if (false) {"],
  ["wav: RIFF unchecked", "wav", 'if (riff !== "RIFF") {', "if (false) {"],
  ["wav: PCM format unchecked", "wav", "if (audioFormat !== 1) {", "if (false) {"],
  ["wav: data offset off by one", "wav", "data.slice(dataChunkOffset, dataChunkOffset + dataChunkSize)", "data.slice(dataChunkOffset + 2, dataChunkOffset + dataChunkSize)"],
  // ---- wav-client (relay/scripts/wav-client.ts) ----
  ["B8: secret presence unchecked", "wavclient", '  if (!secret) {\n    console.error("RELAY_SECRET is missing from environment");\n    process.exit(1);\n  }', ""],
  ["B8: secret length unchecked", "wavclient", "  if (secret.length < 32) {", "  if (false) {"],
  // ---- server (relay/src/server.ts) ----
  ["server: auth timeout ×100", "server", "}, opts.authTimeoutMs);", "}, opts.authTimeoutMs * 100);"],
  ["server: replay allowed", "server", "if (usedNonces.some((n) => n.nonce === payload.nonce)) {", "if (false) {"],
  ["server: configId unchecked at auth", "server", "try {\n      getConfig(payload.configId);", "try {\n      void payload;"],
  ["server: handshake mode", "server", 'mode: "ENDPOINTING",', 'mode: "PUSH_TO_TALK",'],
  ["server: Bearer prefix dropped", "server", '"Bearer " + opts.apiKey', "opts.apiKey"],
  ["server: keywords empty", "server", "keywords: config.asrKeywords,", "keywords: [],"],
  ["server: pre-ready cap ignored", "server", "Math.min(buffer.length, opts.preReadyBufferBytes - session.preReadyBufferBytes)", "buffer.length"],
  ["server: pre-ready not flushed", "server", "              upstreamWs.send(buf);", ""],
  ["server: ready not sent", "server", 'sendMessage(session.clientWs, { type: "ready" });', ""],
  ["server: upstream-unavailable code", "server", "closeSession(session, 4503);\n      }\n    }, opts.upstreamReadyTimeoutMs);", "closeSession(session, 4500);\n      }\n    }, opts.upstreamReadyTimeoutMs);"],
  ["server: fatal map code", "server", 'sendMessage(session.clientWs, { type: "error", message: result.message, fatal: true });\n          closeSession(session, 4502);', 'sendMessage(session.clientWs, { type: "error", message: result.message, fatal: true });\n          closeSession(session, 4500);'],
  ["server: unexpected upstream close code", "server", '// Unexpected upstream close\n        sendMessage(session.clientWs, { type: "error", message: "Transcription service disconnected", fatal: true });\n        closeSession(session, 4502);', '// Unexpected upstream close\n        sendMessage(session.clientWs, { type: "error", message: "Transcription service disconnected", fatal: true });\n        closeSession(session, 1000);'],
  ["server: end → no endStream", "server", '      sendMessage(session.upstreamWs, { type: "endStream" });\n      } else if (session.upstreamWs?.readyState === WebSocket.CONNECTING) {', '      } else if (session.upstreamWs?.readyState === WebSocket.CONNECTING) {'], // re-anchored after round-1
  ["server: time-limit code", "server", "closeSession(session, 4008);", "closeSession(session, 4000);"],
  ["server: origin unchecked", "server", "if (opts.allowedOrigins !== null) {", "if (false) {"],
  ["server: busy code", "server", "ws.close(1013);", "ws.close(1000);"],
  ["server: busy check removed", "server", "if (activeSessions >= opts.maxSessions) {", "if (false) {", 1], // nth=1: upgrade-time check (review-2 added an auth-time one first)
  ["server: api key logged", "server", "      closeCode,\n    }));", "      closeCode,\n      key: opts.apiKey,\n    }));"],
  ["server: healthz path", "server", 'req.url === "/healthz"', 'req.url === "/health"'],
  ["server: any WS path accepted", "server", 'if (req.url !== "/asr") {', "if (false) {"],
  ["server: disconnect → no endStream", "server", 'if (session.upstreamWs.readyState === WebSocket.OPEN) {\n            sendMessage(session.upstreamWs, { type: "endStream" });', 'if (false) {\n            sendMessage(session.upstreamWs, { type: "endStream" });'], // re-anchored in review-2
  ["server: audio not forwarded", "server", "        session.upstreamWs.send(buffer);", ""],
  // round-1 fix reverts (stage-06-review.md B1–B7)
  ["B1: never marked counted", "server", "session.counted = true;\n    activeSessions++;", "activeSessions++;"],
  ["B1: never decremented", "server", "activeSessions = Math.max(0, activeSessions - 1);\n      session.counted = false;", "session.counted = false;"],
  // EQUIVALENT (expected MISSED): closeSession terminates a CONNECTING upstream, so "open" never fires for a closed session.
  ["B2: open-handler guard removed", "server", 'if (session.state === "closed") {\n        upstreamWs.close(1000);\n        return;\n      }', ""],
  ["B2: CONNECTING not terminated", "server", "} else if (session.upstreamWs.readyState === WebSocket.CONNECTING) {\n        session.upstreamWs.terminate();", "} else if (false) {\n        session.upstreamWs.terminate();"],
  ["B2: no handshakeTimeout", "server", "handshakeTimeout: opts.upstreamReadyTimeoutMs,", ""],
  ["B3: time limit skips ending", "server", 'if (session.state !== "closed") {\n        sendMessage(session.clientWs, { type: "error", message: "session time limit reached"', 'if (session.state !== "closed" && session.state !== "ending") {\n        sendMessage(session.clientWs, { type: "error", message: "session time limit reached"'],
  ["B4: invalid JSON silent", "server", '      // B4: Invalid JSON after auth sends error message\n      sendMessage(session.clientWs, { type: "error", message: "invalid message", fatal: false });', ""],
  ["B4: unknown message silent", "server", '      // B4: Any other or invalid text after auth sends error message\n      sendMessage(session.clientWs, { type: "error", message: "invalid message", fatal: false });', ""],
  ["B5: no 404 written", "server", 'socket.write("HTTP/1.1 404 Not Found\\r\\n\\r\\n");', ""],
  ["B6: pre-ready bytes uncounted", "server", "session.bytesIn += bytesToBuffer;", ""],
  ["B7: close() skips sessions", "server", "              closeSession(session, 1001);", ""],
  // round-2 fix reverts (stage-06-review-2.md B1–B6)
  ["R2-B1: auth-time busy check removed", "server", "if (activeSessions >= opts.maxSessions) {", "if (false) {", 0],
  ["R2-B1: auth-time busy message changed", "server", 'sendMessage(session.clientWs, { type: "error", message: "busy", fatal: true });', 'sendMessage(session.clientWs, { type: "error", message: "full", fatal: true });'],
  ["R2-B2: session not deleted from Set", "server", "    sessions.delete(session);", ""],
  ["R2-B3: error handler ignores opened", "server", 'if (session.state !== "closed" && !opened) {', 'if (session.state !== "closed") {'],
  ["R2-B3: opened never set", "server", "      opened = true;", "      void opened;"],
  ["R2-B4: no terminate fallback", "server", "          if (session.upstreamWs && session.upstreamWs.readyState !== WebSocket.CLOSED) {", "          if (false) {"],
  ["R2-B4: fallback only when OPEN", "server", "          if (session.upstreamWs && session.upstreamWs.readyState !== WebSocket.CLOSED) {", "          if (session.upstreamWs && session.upstreamWs.readyState === WebSocket.OPEN) {"],
  ["R2-B5: client error closes session", "server", 'clientWs.on("error", () => {});', 'clientWs.on("error", () => { closeSession(session, 1011); });'],
  ["R2-B6: PORT regex dropped", "config", "if (!/^\\d+$/.test(env.PORT)) {", "if (isNaN(parseInt(env.PORT, 10))) {"],
  ["R2-B6: max sessions regex dropped", "config", "if (/^\\d+$/.test(env.RELAY_MAX_SESSIONS)) {", "if (true) {"],
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
const labelFilter = (process.argv.find((a) => a.startsWith("--label=")) ?? "").slice(8); // substring match on label
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
  return { out: src.slice(0, idxs[nth ?? 0]) + to + src.slice(idxs[nth ?? 0] + from.length) };
}
const runTests = (files) => {
  let o = "";
  try { o = execSync(`npx vitest run ${files}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, timeout: 240000 }); }
  catch (e) { o = (e.stdout ?? "") + (e.stderr ?? ""); }
  return o.replace(/\x1b\[[0-9;]*m/g, "");
};

// --part=k/n: run only the k-th of n contiguous slices of the selected mutations (keeps runs < 10 min)
const [partK, partN] = ((process.argv.find((a) => a.startsWith("--part=")) ?? "--part=1/1").slice(7)).split("/").map(Number);
const selected = M.filter(([label, key]) => groups.includes(key) && (!labelFilter || label.includes(labelFilter)));
const sliceLen = Math.ceil(selected.length / partN);
const mine = selected.slice((partK - 1) * sliceLen, partK * sliceLen);

let total = 0, caught = 0; const lines = [];
for (const [label, key, from, to, nth] of mine) {
  total++;
  restore();
  const r = replaceNth(orig[key].toString("utf8"), from, to, nth);
  if (r.err) { lines.push(`SKIPPED (${r.err}): ${label}`); continue; }
  if (process.argv.includes("--dry")) { caught++; continue; } // --dry: anchors only, no file writes, no tests
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
