import { RelayServerMessageSchema } from "@/contracts";

export const RELAY_READY_TIMEOUT_MS = 12_000;
export const RELAY_END_TIMEOUT_MS = 3_000;

export type RelayFailureKind =
  | "unavailable"
  | "unauthorized"
  | "busy"
  | "upstream"
  | "timeout"
  | "closed";

export class RelayConnectError extends Error {
  constructor(
    readonly kind: RelayFailureKind,
    readonly code: number | null
  ) {
    super(`Relay connect error: ${kind}`);
    this.name = "RelayConnectError";
  }
}

export interface WebSocketLike {
  readonly readyState: number; // 1 = OPEN
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void
  ): void;
}

export interface RelayHandlers {
  onPartial(text: string): void;
  onTurnStart(turnId: string): void;
  onTurnComplete(turnId: string, text: string): void;
  onClose(info: { code: number; intentional: boolean }): void;
}

export interface RelayConnection {
  sendAudio(frame: Uint8Array): void;
  end(): Promise<void>;
  close(): void;
}

export function connectRelay(opts: {
  fetchToken: () => Promise<{ token: string; url: string }>;
  createSocket: (url: string) => WebSocketLike;
  handlers: RelayHandlers;
  readyTimeoutMs?: number;
  endTimeoutMs?: number;
}): Promise<RelayConnection> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? RELAY_READY_TIMEOUT_MS;
  const endTimeoutMs = opts.endTimeoutMs ?? RELAY_END_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let token: { token: string; url: string };
    let socket: WebSocketLike;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    let dead = false;
    let intentionalClose = false;
    let onCloseCalled = false;
    let pendingEnd: (() => void) | null = null;

    const callOnCloseOnce = (code: number) => {
      if (!onCloseCalled) {
        onCloseCalled = true;
        opts.handlers.onClose({ code, intentional: intentionalClose });
      }
    };

    // Step 1: fetch token
    opts
      .fetchToken()
      .then((t) => {
        token = t;
        // Step 2: create socket
        socket = opts.createSocket(token.url);

        // Ready timeout
        readyTimer = setTimeout(() => {
          dead = true;
          socket.close(1000);
          reject(new RelayConnectError("timeout", null));
        }, readyTimeoutMs);

        socket.addEventListener("open", () => {
          // Step 2: send auth
          socket.send(JSON.stringify({ type: "auth", token: token.token }));
        });

        socket.addEventListener("message", (event) => {
          if (dead) return;

          // Step 3: parse message
          if (typeof event.data !== "string") {
            return;
          }

          let msg: unknown;
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }

          const parsed = RelayServerMessageSchema.safeParse(msg);
          if (!parsed.success) {
            return;
          }
          const data = parsed.data;

          if (!resolved) {
            // Before ready
            if (data.type === "ready") {
              if (readyTimer) {
                clearTimeout(readyTimer);
                readyTimer = null;
              }
              resolved = true;
              resolve(createConnection());
            }
            // Ignore other messages before ready
            return;
          }

          // After ready
          switch (data.type) {
            case "partial":
              opts.handlers.onPartial(data.text);
              break;
            case "turn_start":
              opts.handlers.onTurnStart(data.turnId);
              break;
            case "turn_complete":
              opts.handlers.onTurnComplete(data.turnId, data.text);
              break;
            case "error":
              // Ignore error messages, a fatal one is followed by close
              break;
          }
        });

        socket.addEventListener("close", (event) => {
          if (dead) return;

          if (!resolved) {
            // Before ready
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = null;
            }
            const code = event.code ?? 1000;
            let kind: RelayFailureKind;
            switch (code) {
              case 4001:
                kind = "unauthorized";
                break;
              case 1013:
                kind = "busy";
                break;
              case 4502:
              case 4503:
                kind = "upstream";
                break;
              default:
                kind = "closed";
            }
            reject(new RelayConnectError(kind, code));
          } else {
            // After ready
            callOnCloseOnce(event.code ?? 1000);
            if (pendingEnd) {
              if (endTimer) {
                clearTimeout(endTimer);
                endTimer = null;
              }
              pendingEnd();
              pendingEnd = null;
            }
          }
        });

        socket.addEventListener("error", () => {
          // Ignore error event, close always follows
        });
      })
      .catch(() => {
        // Token fetch failed
        reject(new RelayConnectError("unavailable", null));
      });

    function createConnection(): RelayConnection {
      return {
        sendAudio(frame: Uint8Array): void {
          if (socket.readyState === 1) {
            socket.send(frame);
          }
        },

        end(): Promise<void> {
          return new Promise((resolveEnd) => {
            if (socket.readyState !== 1) {
              resolveEnd();
              return;
            }

            intentionalClose = true;
            socket.send(JSON.stringify({ type: "end" }));

            pendingEnd = resolveEnd;
            endTimer = setTimeout(() => {
              pendingEnd = null;
              socket.close(1000);
              resolveEnd();
            }, endTimeoutMs);
          });
        },

        close(): void {
          intentionalClose = true;
          socket.close(1000);
        },
      };
    }
  });
}
