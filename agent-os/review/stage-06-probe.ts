// Stage 6 re-review probes (round 2). Localhost only. Run from repo root: npx tsx <this file>
import net from "node:net";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "D:/CodeFiles/Interim/node_modules/ws/index.js";
import { startRelay } from "D:/CodeFiles/Interim/relay/src/server";
import { signRelayToken } from "D:/CodeFiles/Interim/src/shared/relay-token";

const SECRET = "x".repeat(40);
const tok = () => signRelayToken({ v: 1, exp: Date.now() + 60_000, nonce: randomBytes(16).toString("hex"), configId: "maths-oxbridge" }, SECRET);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = { secret: SECRET, apiKey: "test-key", allowedOrigins: null, authTimeoutMs: 1000, maxSessionMs: 60_000, preReadyBufferBytes: 64_000, upstreamReadyTimeoutMs: 2000 };

function client(port: number, token: string | null) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/asr`);
  const msgs: { type: string; message?: string }[] = []; let closeCode: number | null = null;
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  ws.on("close", (c) => (closeCode = c));
  ws.on("error", () => {});
  if (token) ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  return { ws, msgs, code: () => closeCode, ready: () => msgs.some((m) => m.type === "ready") && ws.readyState === 1 };
}

async function ackingUpstream() {
  const up = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const handshakes: unknown[] = [];
  up.on("upgrade", (req, s, h) => wss.handleUpgrade(req, s, h, (ws) => ws.on("message", (d, bin) => {
    if (bin) return; const m = JSON.parse(d.toString()); if (m.authorization) { handshakes.push(m); ws.send(JSON.stringify({ sessionId: "s" })); }
  })));
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
  return { url: `ws://127.0.0.1:${(up.address() as net.AddressInfo).port}`, wss, handshakes, stop: () => { for (const c of wss.clients) c.terminate(); wss.close(); up.closeAllConnections(); up.close(); } };
}

// R1 (repro from round 1): bad-token connection must not free a slot.
async function r1() {
  const up = await ackingUpstream();
  const relay = await startRelay({ ...base, port: 0, upstreamUrl: up.url, maxSessions: 2 });
  const a = client(relay.port, tok()); await sleep(300);
  const b = client(relay.port, "bad.token"); await sleep(300);
  const c = client(relay.port, tok()); await sleep(300);
  const d = client(relay.port, tok()); await sleep(300);
  const n = [a, c, d].filter((x) => x.ready()).length;
  console.log(`R1 bad-token: ready=${n} (max 2), B=${b.code()}, D=${d.code()} -> ${n <= 2 ? "OK" : "BUG"}`);
  for (const x of [a, b, c, d]) x.ws.terminate(); await relay.close(); up.stop();
}

// R2 (repro from round 1): upstream still CONNECTING when session ends.
async function r2() {
  const handshakes: unknown[] = [];
  const http = createServer(); const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, s, h) => setTimeout(() => { if (!s.destroyed) wss.handleUpgrade(req, s, h, (ws) => ws.on("message", (d) => handshakes.push(d.toString()))); }, 1500));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const relay = await startRelay({ ...base, port: 0, upstreamUrl: `ws://127.0.0.1:${(http.address() as net.AddressInfo).port}`, maxSessions: 5, upstreamReadyTimeoutMs: 300 });
  const a = client(relay.port, tok()); await sleep(2500);
  console.log(`R2 orphan: client close=${a.code()}, upstream open sockets=${wss.clients.size}, handshakes=${handshakes.length} -> ${wss.clients.size === 0 && handshakes.length === 0 ? "OK" : "BUG"}`);
  for (const c of wss.clients) c.terminate(); a.ws.terminate(); await relay.close(); wss.close(); http.closeAllConnections(); http.close();
}

// P1: N clients connect before any authenticates; all then authenticate.
async function p1() {
  const up = await ackingUpstream();
  const relay = await startRelay({ ...base, port: 0, upstreamUrl: up.url, maxSessions: 1 });
  const cs = [client(relay.port, null), client(relay.port, null), client(relay.port, null)];
  await sleep(300);
  for (const c of cs) c.ws.send(JSON.stringify({ type: "auth", token: tok() }));
  await sleep(500);
  const n = cs.filter((c) => c.ready()).length;
  console.log(`P1 concurrent pre-auth: maxSessions=1, ready+open=${n}, upstream handshakes=${up.handshakes.length} -> ${n <= 1 ? "OK" : "BUG (over-subscribed)"}`);
  for (const c of cs) c.ws.terminate(); await relay.close(); up.stop();
}

// P2: upstream sends an invalid WebSocket frame mid-session (ws 'error' on the relay's upstream socket).
async function p2() {
  const up = await ackingUpstream();
  const relay = await startRelay({ ...base, port: 0, upstreamUrl: up.url, maxSessions: 5 });
  const a = client(relay.port, tok()); await sleep(400);
  const srv = [...up.wss.clients][0] as unknown as { _socket: net.Socket };
  srv._socket.write(Buffer.from([0x83, 0x00])); // reserved opcode 0x3
  await sleep(400);
  const errs = a.msgs.filter((m) => m.type === "error").map((m) => m.message);
  console.log(`P2 mid-session upstream error: ready=${a.msgs.some((m) => m.type === "ready")}, errors=${JSON.stringify(errs)}, close=${a.code()} (brief: disconnected/4502)`);
  a.ws.terminate(); await relay.close(); up.stop();
}

// P3: upstream that completes the WS handshake but never answers a close frame. Client disconnects mid-session.
async function p3() {
  let rawClosedAt: number | null = null; let gotEndStream = false;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0); let upgraded = false;
    sock.on("data", (d) => {
      if (upgraded) { if (d.toString("latin1").length && unmaskText(d).includes("endStream")) gotEndStream = true; return; }
      buf = Buffer.concat([buf, d]);
      const s = buf.toString("latin1"); if (!s.includes("\r\n\r\n")) return;
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(s)![1].trim();
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      setTimeout(() => { const p = Buffer.from(JSON.stringify({ sessionId: "s" })); sock.write(Buffer.concat([Buffer.from([0x81, p.length]), p])); }, 50);
    });
    sock.on("close", () => (rawClosedAt = Date.now()));
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const relay = await startRelay({ ...base, port: 0, upstreamUrl: `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, maxSessions: 5 });
  const a = client(relay.port, tok()); await sleep(400);
  const ready = a.msgs.some((m) => m.type === "ready");
  const t0 = Date.now(); a.ws.close(1000);
  await sleep(4000);
  console.log(`P3 unresponsive upstream after client disconnect: ready=${ready}, endStream seen=${gotEndStream}, upstream TCP closed ${rawClosedAt ? `after ${rawClosedAt - t0} ms` : "NOT within 4000 ms"} (brief: within 2 s)`);
  await relay.close(); srv.close();
}
function unmaskText(d: Buffer): string {
  try { const len = d[1] & 0x7f; const mask = d.subarray(2, 6); const p = Buffer.from(d.subarray(6, 6 + len)); for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4]; return p.toString(); } catch { return ""; }
}

(async () => { await r1(); await r2(); await p1(); await p2(); await p3(); process.exit(0); })();
