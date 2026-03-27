import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { IncomingMessage, MessageQueue } from "./message-queue";
import { validateMessage } from "./security";

export type DaemonState = {
  connected: boolean;
  serverUrl: string;
  agentId: string;
  gatewayReady: boolean;
  sessionKey?: string;
  lastError?: string;
};

export type DaemonOptions = {
  serverUrl: string;
  agentId: string;
  agentToken: string;
  queue: MessageQueue;
  state: DaemonState;
  onAccepted: (msg: IncomingMessage) => Promise<void>;
  onDropped?: (reason: string, raw: unknown) => void;
  onEvent?: (line: string) => void;
  reconnectDelayMs?: number;
};

export type DaemonHandle = {
  send: (payload: string) => boolean;
  close: () => void;
};

export function startDaemon(options: DaemonOptions): DaemonHandle {
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  let ws: WebSocket | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const stopPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
    options.onEvent?.(`relay reconnect scheduled delayMs=${reconnectDelayMs}`);
  };

  const connect = () => {
    if (closed) return;
    options.onEvent?.(`relay connect attempt url=${options.serverUrl}`);
    const connTs = Date.now();
    const connNonce = randomBytes(16).toString("hex");
    const connMaterial = `${options.agentId}|${options.agentId}|server|connect|connect||${connTs}|${connNonce}`;
    const connSig = createHmac("sha256", options.agentToken).update(connMaterial).digest("hex");
    ws = new WebSocket(options.serverUrl, {
      headers: {
        "x-agent-id": options.agentId,
        "x-signature": connSig,
        "x-timestamp": String(connTs),
        "x-nonce": connNonce,
      }
    });

    ws.on("open", () => {
      options.state.connected = true;
      options.state.lastError = undefined;
      options.onEvent?.("relay connected");
      stopPing();
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    });

    ws.on("close", () => {
      options.state.connected = false;
      options.onEvent?.("relay disconnected");
      stopPing();
      scheduleReconnect();
    });

    ws.on("error", (error) => {
      options.state.lastError = String(error);
      options.onEvent?.(`relay error error=${String(error)}`);
    });

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === "session") {
          options.state.sessionKey = data.session_key;
          options.onEvent?.("relay session key received");
          return;
        }
        if (data.type === "pong") return;
        if (!options.state.sessionKey) return;
        const message = validateMessage(data, options.state.sessionKey);
        if (options.state.gatewayReady) {
          await options.onAccepted(message);
        } else {
          options.queue.enqueue(message);
          options.onEvent?.(`queued inbound message id=${message.id}`);
        }
      } catch (error) {
        options.state.lastError = String(error);
        options.onDropped?.(String(error), String(raw));
      }
    });
  };

  connect();

  return {
    send: (payload: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        options.state.lastError = "Error: relay socket not connected";
        options.onEvent?.("outbound send skipped because relay socket not connected");
        return false;
      }
      ws.send(payload);
      return true;
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPing();
      ws?.close();
    }
  };
}
