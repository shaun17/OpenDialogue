import WebSocket from "ws";
import type { IncomingMessage, MessageQueue } from "./message-queue";
import { validateMessage } from "./security";

export type DaemonState = {
  connected: boolean;
  serverUrl: string;
  agentId: string;
  gatewayReady: boolean;
  sessionKey?: string;
};

export type DaemonOptions = {
  serverUrl: string;
  agentId: string;
  agentToken: string;
  queue: MessageQueue;
  state: DaemonState;
  onAccepted: (msg: IncomingMessage) => Promise<void>;
};

export function startDaemon(options: DaemonOptions): WebSocket {
  const ws = new WebSocket(options.serverUrl, {
    headers: {
      authorization: `Bearer ${options.agentToken}`,
      "x-agent-id": options.agentId
    }
  });

  ws.on("open", () => {
    options.state.connected = true;
  });

  ws.on("close", () => {
    options.state.connected = false;
  });

  ws.on("message", async (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === "session") {
      options.state.sessionKey = data.session_key;
      return;
    }
    if (data.type === "pong") return;
    if (!options.state.sessionKey) return;
    const message = validateMessage(data, options.state.sessionKey);
    if (options.state.gatewayReady) {
      await options.onAccepted(message);
    } else {
      options.queue.enqueue(message);
    }
  });

  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);

  ws.on("close", () => clearInterval(timer));
  return ws;
}
