import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { verifyRelayToken } from "@/shared/relay-token";
import { getConfig } from "@/config/load";
import { mapUpstreamEvent, isUpstreamReady } from "./map-upstream";

export interface RelayOptions {
  port: number;
  secret: string;
  apiKey: string;
  upstreamUrl: string;
  allowedOrigins: string[] | null;
  maxSessions: number;
  authTimeoutMs: number;
  upstreamReadyTimeoutMs: number;
  maxSessionMs: number;
  preReadyBufferBytes: number;
  now?: () => number;
}

interface Session {
  configId: string;
  nonce: string;
  startedAt: number;
  bytesIn: number;
  clientWs: WebSocket;
  upstreamWs: WebSocket | null;
  state: "awaiting_auth" | "connecting_upstream" | "ready" | "ending" | "closed";
  preReadyBuffer: Buffer[];
  preReadyBufferBytes: number;
  authTimer: NodeJS.Timeout | null;
  upstreamReadyTimer: NodeJS.Timeout | null;
  sessionTimer: NodeJS.Timeout | null;
  counted: boolean; // B1: tracks if session was counted in activeSessions
}

interface UsedNonce {
  nonce: string;
  expiresAt: number;
}

export async function startRelay(opts: RelayOptions): Promise<{ port: number; close(): Promise<void>; trackedSessions(): number }> {
  const now = opts.now ?? Date.now;

  // Per-instance nonce tracking
  const usedNonces: UsedNonce[] = [];

  function purgeExpiredNonces(currentTime: number) {
    // Remove expired nonces in place
    const validNonces = usedNonces.filter((n) => n.expiresAt > currentTime);
    usedNonces.length = 0;
    usedNonces.push(...validNonces);
  }

  let activeSessions = 0;
  const sessions = new Set<Session>(); // B2: track sessions for proper cleanup

  const server = createServer((req: IncomingMessage, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

  function sendMessage(ws: WebSocket, msg: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function closeSession(session: Session, closeCode: number) {
    if (session.state === "closed") return;
    session.state = "closed";

    // Clear timers
    if (session.authTimer) clearTimeout(session.authTimer);
    if (session.upstreamReadyTimer) clearTimeout(session.upstreamReadyTimer);
    if (session.sessionTimer) clearTimeout(session.sessionTimer);

    // B1: Decrement activeSessions exactly once, only if counted
    if (session.counted) {
      activeSessions = Math.max(0, activeSessions - 1);
      session.counted = false;
    }

    // Log session end
    const durationMs = now() - session.startedAt;
    console.info(JSON.stringify({
      tag: "relay_session",
      configId: session.configId,
      durationMs,
      bytesIn: session.bytesIn,
      closeCode,
    }));

    // B4: Close upstream with 2s terminate fallback
    if (session.upstreamWs) {
      if (session.upstreamWs.readyState === WebSocket.OPEN) {
        // B4: Set up terminate fallback timer
        const upstreamTerminateTimer = setTimeout(() => {
          if (session.upstreamWs && session.upstreamWs.readyState !== WebSocket.CLOSED) {
            session.upstreamWs.terminate();
          }
        }, 2000);
        upstreamTerminateTimer.unref();
        session.upstreamWs.close(1000);
      } else if (session.upstreamWs.readyState === WebSocket.CONNECTING) {
        session.upstreamWs.terminate();
      }
    }

    // Close client
    if (session.clientWs.readyState === WebSocket.OPEN) {
      session.clientWs.close(closeCode);
    }

    // B2: Remove from sessions set
    sessions.delete(session);
  }

  function createSession(clientWs: WebSocket): Session {
    return {
      configId: "",
      nonce: "",
      startedAt: now(),
      bytesIn: 0,
      clientWs,
      upstreamWs: null,
      state: "awaiting_auth",
      preReadyBuffer: [],
      preReadyBufferBytes: 0,
      authTimer: null,
      upstreamReadyTimer: null,
      sessionTimer: null,
      counted: false,
    };
  }

  async function handleConnection(clientWs: WebSocket) {
    const session = createSession(clientWs);
    sessions.add(session); // B2: track session

    // Auth timeout
    session.authTimer = setTimeout(() => {
      if (session.state === "awaiting_auth") {
        sendMessage(clientWs, { type: "error", message: "unauthorized", fatal: true });
        closeSession(session, 4001);
      }
    }, opts.authTimeoutMs);

    clientWs.on("message", (data: RawData, isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      
      if (session.state === "awaiting_auth") {
        handleAuth(session, buffer, isBinary);
      } else if (session.state === "connecting_upstream") {
        if (isBinary) {
          // Buffer audio before upstream is ready
          const bytesToBuffer = Math.min(buffer.length, opts.preReadyBufferBytes - session.preReadyBufferBytes);
          if (bytesToBuffer > 0) {
            session.preReadyBuffer.push(buffer.subarray(0, bytesToBuffer));
            session.preReadyBufferBytes += bytesToBuffer;
            // B6: count pre-ready buffered bytes in bytesIn
            session.bytesIn += bytesToBuffer;
          }
        } else {
          // Handle text messages (like end)
          handleClientTextMessage(session, buffer);
        }
      } else if (session.state === "ready") {
        handleReadyState(session, buffer, isBinary);
      } else if (session.state === "ending") {
        // Ignore messages in ending state
      }
    });

    clientWs.on("close", () => {
      if (session.state !== "closed") {
        if (session.upstreamWs) {
          // Send endStream upstream and close
          if (session.upstreamWs.readyState === WebSocket.OPEN) {
            sendMessage(session.upstreamWs, { type: "endStream" });
          }
          // B4: The 2s terminate is now handled in closeSession
        }
        closeSession(session, 1000);
      }
    });

    // B5: error listener is a no-op; close always follows
    clientWs.on("error", () => {});
  }

  function handleAuth(session: Session, buffer: Buffer, isBinary: boolean) {
    if (session.authTimer) clearTimeout(session.authTimer);

    // First message must be text auth
    if (isBinary) {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(buffer.toString("utf-8"));
    } catch {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    // Check auth message
    if (typeof msg !== "object" || msg === null || (msg as Record<string, unknown>).type !== "auth" || typeof (msg as Record<string, unknown>).token !== "string") {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    const token = (msg as { token: string }).token;
    const verifyResult = verifyRelayToken(token, opts.secret, now());

    if (!verifyResult.ok) {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    const payload = verifyResult.payload;

    // Check replay
    purgeExpiredNonces(now());
    if (usedNonces.some((n) => n.nonce === payload.nonce)) {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    // Check configId
    try {
      getConfig(payload.configId);
    } catch {
      sendMessage(session.clientWs, { type: "error", message: "unauthorized", fatal: true });
      closeSession(session, 4001);
      return;
    }

    // B1: Check maxSessions after token/replay/configId checks, before recording nonce
    if (activeSessions >= opts.maxSessions) {
      sendMessage(session.clientWs, { type: "error", message: "busy", fatal: true });
      closeSession(session, 1013);
      return;
    }

    // Record nonce
    usedNonces.push({ nonce: payload.nonce, expiresAt: payload.exp });

    // Auth succeeded
    session.configId = payload.configId;
    session.nonce = payload.nonce;
    session.state = "connecting_upstream";
    
    // B1: mark session as counted and increment counter
    session.counted = true;
    activeSessions++;

    // B3: Start session timer at auth time
    session.sessionTimer = setTimeout(() => {
      if (session.state !== "closed") {
        sendMessage(session.clientWs, { type: "error", message: "session time limit reached", fatal: true });
        closeSession(session, 4008);
      }
    }, opts.maxSessionMs);

    // Connect upstream
    connectUpstream(session);
  }

  function connectUpstream(session: Session) {
    const upstreamWs = new WebSocket(opts.upstreamUrl, {
      handshakeTimeout: opts.upstreamReadyTimeoutMs,
    });

    session.upstreamWs = upstreamWs;

    // B3: Track whether upstream socket ever opened
    let opened = false;

    session.upstreamReadyTimer = setTimeout(() => {
      if (session.state === "connecting_upstream") {
        sendMessage(session.clientWs, { type: "error", message: "Transcription service unavailable", fatal: true });
        closeSession(session, 4503);
      }
    }, opts.upstreamReadyTimeoutMs);

    upstreamWs.on("open", () => {
      opened = true; // B3: Mark as opened
      // B2: Don't send handshake if session is already closed
      if (session.state === "closed") {
        upstreamWs.close(1000);
        return;
      }
      // Send handshake
      const config = getConfig(session.configId);
      const handshake = {
        authorization: { accessToken: "Bearer " + opts.apiKey },
        audioEncoding: "PCM_16KHZ",
        model: "muse-voice-transcribe-1.0",
        mode: "ENDPOINTING",
        partialMode: "CUMULATIVE",
        keywords: config.asrKeywords,
      };
      upstreamWs.send(JSON.stringify(handshake));
    });

    upstreamWs.on("message", (data: RawData) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      let msg: unknown;
      try {
        msg = JSON.parse(buffer.toString("utf-8"));
      } catch {
        return;
      }

      if (typeof msg !== "object" || msg === null) return;

      if (session.state === "connecting_upstream") {
        // Check for ready message
        if (isUpstreamReady(msg as Record<string, unknown>)) {
          if (session.upstreamReadyTimer) clearTimeout(session.upstreamReadyTimer);
          session.state = "ready";

          // Send ready to client
          sendMessage(session.clientWs, { type: "ready" });

          // Flush buffered audio
          for (const buf of session.preReadyBuffer) {
            if (upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(buf);
            }
          }
          session.preReadyBuffer = [];
          return;
        }
      }

      if (session.state === "ready" || session.state === "ending") {
        // Map upstream events
        const result = mapUpstreamEvent(msg as Record<string, unknown>);
        if (result.kind === "send") {
          sendMessage(session.clientWs, result.message);
        } else if (result.kind === "fatal") {
          sendMessage(session.clientWs, { type: "error", message: result.message, fatal: true });
          closeSession(session, 4502);
        }
      }
    });

    upstreamWs.on("close", (code: number) => {
      if (session.state === "ending") {
        if (code !== 1000) {
          sendMessage(session.clientWs, { type: "error", message: "Transcription service disconnected", fatal: true });
          closeSession(session, 4502);
        } else {
          closeSession(session, 1000);
        }
      } else if (session.state !== "closed") {
        // Unexpected upstream close
        sendMessage(session.clientWs, { type: "error", message: "Transcription service disconnected", fatal: true });
        closeSession(session, 4502);
      }
    });

    upstreamWs.on("error", () => {
      // B3: Keep listener attached (error without listener crashes), but logic in close handler
      // If !opened, send "unavailable" / 4503; if opened, close handler sends "disconnected" / 4502
      if (session.state !== "closed" && !opened) {
        sendMessage(session.clientWs, { type: "error", message: "Transcription service unavailable", fatal: true });
        closeSession(session, 4503);
      }
      // If opened, do nothing - the close event will fire next and handle "disconnected" / 4502
    });
  }

  function handleReadyState(session: Session, buffer: Buffer, isBinary: boolean) {
    if (isBinary) {
      // Forward binary to upstream
      session.bytesIn += buffer.length;
      if (session.upstreamWs?.readyState === WebSocket.OPEN) {
        session.upstreamWs.send(buffer);
      }
    } else {
      handleClientTextMessage(session, buffer);
    }
  }

  function handleClientTextMessage(session: Session, buffer: Buffer) {
    let msg: unknown;
    try {
      msg = JSON.parse(buffer.toString("utf-8"));
    } catch {
      // B4: Invalid JSON after auth sends error message
      sendMessage(session.clientWs, { type: "error", message: "invalid message", fatal: false });
      return;
    }

    if (typeof msg !== "object" || msg === null) {
      // B4: Invalid structure sends error message
      sendMessage(session.clientWs, { type: "error", message: "invalid message", fatal: false });
      return;
    }

    if ((msg as Record<string, unknown>).type === "end") {
      session.state = "ending";
      if (session.upstreamWs?.readyState === WebSocket.OPEN) {
        sendMessage(session.upstreamWs, { type: "endStream" });
      } else if (session.upstreamWs?.readyState === WebSocket.CONNECTING) {
        // B3/B2: If still connecting, close upstream once it opens
        session.upstreamWs.once("open", () => {
          if (session.state === "ending" || session.state === "closed") {
            session.upstreamWs?.close(1000);
          }
        });
      }
    } else {
      // B4: Any other or invalid text after auth sends error message
      sendMessage(session.clientWs, { type: "error", message: "invalid message", fatal: false });
    }
  }

  // Handle HTTP upgrade
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    // Check path
    if (req.url !== "/asr") {
      // B5: Send 404 before destroying
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Check origin
    if (opts.allowedOrigins !== null) {
      const origin = req.headers.origin;
      if (!origin || !opts.allowedOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    // Check max sessions
    if (activeSessions >= opts.maxSessions) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        sendMessage(ws, { type: "error", message: "busy", fatal: true });
        ws.close(1013);
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws);
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port, () => {
      const actualPort = (server.address() as { port: number }).port;
      resolve({
        port: actualPort,
        async close() {
          // B2: Close all active sessions properly (iterate over copy)
          for (const session of [...sessions]) {
            if (session.state !== "closed") {
              closeSession(session, 1001);
            }
          }
          wss.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        trackedSessions() {
          return sessions.size;
        },
      });
    });
  });
}
