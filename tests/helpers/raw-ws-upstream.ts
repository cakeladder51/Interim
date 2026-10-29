import net from "node:net";
import { createHash } from "node:crypto";

// A minimal WebSocket upstream: completes the HTTP upgrade, sends {"sessionId":"s"},
// then ignores every frame it receives. It never answers a close frame.
export async function startUnresponsiveUpstream(): Promise<{
  url: string;
  openSockets(): number;
  stop(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on("data", (d) => {
      if (upgraded) return;
      buf = Buffer.concat([buf, d]);
      const head = buf.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      setTimeout(() => {
        const payload = Buffer.from(JSON.stringify({ sessionId: "s" }));
        if (!sock.destroyed) sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }, 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    openSockets: () => sockets.size,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
