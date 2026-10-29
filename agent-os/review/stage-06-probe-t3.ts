// Stage 6 review-2: verifies the T3c/T3d observations against the real relay. Localhost only.
// Run from the repo root: npx tsx agent-os/review/stage-06-probe-t3.ts
// Expected: "T3c: close=4503, upstream connection events=0" and "T3d: close=4503 after ~300 ms".
import net from "node:net";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "D:/CodeFiles/Interim/node_modules/ws/index.js";
import { startRelay } from "D:/CodeFiles/Interim/relay/src/server";
import { signRelayToken } from "D:/CodeFiles/Interim/src/shared/relay-token";
const SECRET = "x".repeat(40);
const tok = () => signRelayToken({ v: 1, exp: Date.now() + 60_000, nonce: randomBytes(16).toString("hex"), configId: "maths-oxbridge" }, SECRET);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = { port: 0, secret: SECRET, apiKey: "k", allowedOrigins: null, maxSessions: 5, authTimeoutMs: 1000, maxSessionMs: 60_000, preReadyBufferBytes: 64_000, upstreamReadyTimeoutMs: 300 };

async function connCount() {
  let conns = 0; const http = createServer(); const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", () => conns++);
  http.on("upgrade", (req, s, h) => setTimeout(() => wss.handleUpgrade(req, s, h, (ws) => wss.emit("connection", ws, req)), 1500));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const relay = await startRelay({ ...base, upstreamUrl: `ws://127.0.0.1:${(http.address() as net.AddressInfo).port}` });
  const c = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`); let code = 0; c.on("close", (x) => (code = x)); c.on("error", () => {});
  c.on("open", () => c.send(JSON.stringify({ type: "auth", token: tok() })));
  await sleep(2500);
  console.log(`T3c: close=${code}, upstream connection events=${conns}`);
  await relay.close(); http.closeAllConnections(); http.close();
}

async function hungEnd() {
  const srv = net.createServer((s) => s.on("error", () => {})); const socks: net.Socket[] = [];
  srv.on("connection", (s) => socks.push(s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const relay = await startRelay({ ...base, upstreamUrl: `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}` });
  const c = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`); const msgs: string[] = []; let code = 0; const t0 = Date.now(); let at = 0;
  c.on("message", (d) => msgs.push(d.toString())); c.on("close", (x) => { code = x; at = Date.now() - t0; }); c.on("error", () => {});
  c.on("open", () => { c.send(JSON.stringify({ type: "auth", token: tok() })); c.send(JSON.stringify({ type: "end" })); });
  await sleep(1500);
  console.log(`T3d: close=${code} after ${at} ms, msgs=${JSON.stringify(msgs)}`);
  for (const s of socks) s.destroy(); await relay.close(); srv.close();
}
// T3e (review-3): client disconnects while upstream CONNECTING, with a LONG ready timeout so
// handshakeTimeout can't mask a missing terminate(). Expected: upstream connection events = 0.
async function disconnectLongTimeout() {
  let conns = 0; const http = createServer(); const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", () => conns++);
  http.on("upgrade", (req, s, h) => setTimeout(() => wss.handleUpgrade(req, s, h, (ws) => wss.emit("connection", ws, req)), 1500));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const relay = await startRelay({ ...base, upstreamReadyTimeoutMs: 5000, upstreamUrl: `ws://127.0.0.1:${(http.address() as net.AddressInfo).port}` });
  const c = new WebSocket(`ws://127.0.0.1:${relay.port}/asr`); c.on("error", () => {});
  c.on("open", () => { c.send(JSON.stringify({ type: "auth", token: tok() })); setTimeout(() => c.close(), 200); });
  await sleep(2500);
  console.log(`T3e: upstream connection events=${conns}, tracked sessions=${relay.trackedSessions()}`);
  for (const x of wss.clients) x.terminate(); await relay.close(); http.closeAllConnections(); http.close();
}
(async () => { await connCount(); await hungEnd(); await disconnectLongTimeout(); process.exit(0); })();
