import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { DaemonState } from "./daemon";

type SendFn = (payload: string) => void;

function badRequest(res: import("node:http").ServerResponse, message: string): void {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

export function startStatusServer(state: DaemonState, queueSize: () => number, send: SendFn) {
  const startedAt = Date.now();
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        connected: state.connected,
        server_url: state.serverUrl,
        agent_id: state.agentId,
        queue_size: queueSize(),
        gateway_ready: state.gatewayReady,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000)
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/send") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body.to !== "string" || typeof body.content !== "string") {
          return badRequest(res, "body must include string fields: to, content");
        }
        if (body.content.length === 0 || body.content.length > 2000) {
          return badRequest(res, "content length must be 1..2000");
        }

        const timestamp = Date.now();
        const nonce = randomBytes(16).toString("hex");
        const payload = {
          id: randomBytes(8).toString("hex"),
          from: state.agentId,
          to: body.to,
          type: "text",
          content: body.content,
          timestamp,
          nonce,
          signature: ""
        };
        const material = `${payload.id}|${payload.from}|${payload.to}|${payload.content}|${payload.timestamp}|${payload.nonce}`;
        payload.signature = createHmac("sha256", state.sessionKey ?? "mock-key-for-dev").update(material).digest("hex");
        send(JSON.stringify(payload));
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      } catch (error) {
        return badRequest(res, `invalid request: ${String(error)}`);
      }
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  const port = Number(process.env.OPENDIALOGUE_STATUS_PORT ?? "18791");
  server.listen(port, "127.0.0.1");
  return server;
}
