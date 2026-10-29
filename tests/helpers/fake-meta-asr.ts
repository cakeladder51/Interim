import { createServer } from "node:http";
import WebSocket, { WebSocketServer, type WebSocket as WsType } from "ws";

export interface FakeMetaOptions {
  ack?: "immediate" | "never";
  rejectHandshake?: boolean;
}

export interface FakeMetaResult {
  url: string;
  handshakes: unknown[];
  audio: Buffer[];
  texts: unknown[];
  send(event: object): void;
  sendRawFrame(bytes: Buffer): void;
  close(code: number): void;
  connections(): number;
  openConnections(): number;
  stop(): Promise<void>;
}

export async function startFakeMetaAsr(behaviour?: FakeMetaOptions): Promise<FakeMetaResult> {
  const ack = behaviour?.ack ?? "immediate";
  const rejectHandshake = behaviour?.rejectHandshake ?? false;

  const handshakes: unknown[] = [];
  const audio: Buffer[] = [];
  const texts: unknown[] = [];

  // Track all connections
  const allSockets: WsType[] = [];
  let ws: WsType | null = null; // latest connection for send/close
  let connectionCount = 0;
  // Track which connections have received handshake ack
  const ackedConnections = new Set<WsType>();

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      connectionCount++;
      ws = clientWs as WsType;
      allSockets.push(ws);

      clientWs.on("message", (data, isBinary) => {
        if (isBinary) {
          audio.push(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
        } else {
          const text = Buffer.isBuffer(data) ? data.toString("utf-8") : data.toString();
          let msg: unknown;
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          texts.push(msg);

          // First message for each connection is handshake
          if (!ackedConnections.has(clientWs as WsType)) {
            handshakes.push(msg);
            ackedConnections.add(clientWs as WsType);
            if (rejectHandshake) {
              clientWs.close(1008);
              return;
            }
            if (ack === "immediate") {
              clientWs.send(JSON.stringify({ sessionId: "sess-1" }));
            }
          }
        }
      });

      clientWs.on("close", () => {
        // Don't clear ws - keep tracking latest for openConnections
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;

      resolve({
        url: `ws://127.0.0.1:${port}`,
        handshakes,
        audio,
        texts,
        send(event: object) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
          }
        },
        sendRawFrame(bytes: Buffer) {
          // Write raw bytes to the latest connection's TCP socket
          const socket = (ws as unknown as { _socket: import("node:net").Socket })._socket;
          if (socket && !socket.destroyed) {
            socket.write(bytes);
          }
        },
        close(code: number) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(code);
          }
        },
        connections() {
          return connectionCount;
        },
        openConnections() {
          return allSockets.filter((s) => s.readyState === WebSocket.OPEN).length;
        },
        async stop() {
          wss.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      });
    });
  });
}
