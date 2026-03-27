import { appendFileSync } from "node:fs";
import { ensurePluginConfig, getOpenClawConfigPath } from "./config";
import { startDaemon } from "./daemon";
import { waitForGateway } from "./gateway-probe";
import { sendToHook } from "./hook-client";
import { MessageQueue } from "./message-queue";
import { startStatusServer } from "./status-server";

function log(line: string): void {
  const file = `${getOpenClawConfigPath()}.opendialogue.log`;
  appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

function short(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function main() {
  const config = ensurePluginConfig();
  const queue = new MessageQueue(100);
  const state = {
    connected: false,
    serverUrl: config.relayUrl,
    agentId: config.agentId,
    gatewayReady: false,
    sessionKey: undefined as string | undefined
  };

  const forwardToHook = async (msg: { id: string; from: string; to: string; content: string }) => {
    log(`accepted inbound message id=${msg.id} from=${msg.from} to=${msg.to} content=${short(msg.content)}`);
    try {
      const result = await sendToHook(msg.from, msg.content, {
        baseUrl: config.gatewayBaseUrl,
        token: config.hook.token,
        path: config.hook.path,
        retries: 3
      });
      const runId = typeof result.bodyJson?.runId === "string" ? result.bodyJson.runId : "unknown";
      log(`hook forward ok id=${msg.id} status=${result.status} runId=${runId} body=${short(result.bodyText, 240)}`);
    } catch (error) {
      log(`hook forward failed id=${msg.id} error=${String(error)}`);
      throw error;
    }
  };

  const ws = startDaemon({
    serverUrl: config.relayUrl,
    agentId: config.agentId,
    agentToken: config.agentToken,
    queue,
    state,
    onAccepted: forwardToHook
  });

  startStatusServer(state, () => queue.size(), (payload) => {
    ws.send(payload);
  });

  log(`plugin boot: relay=${config.relayUrl} agent=${config.agentId}`);
  state.gatewayReady = await waitForGateway(config.gatewayBaseUrl);
  log(`gateway ready=${state.gatewayReady}`);

  if (state.gatewayReady) {
    await queue.flush(async (msg) => {
      log(`flushing queued message id=${msg.id} from=${msg.from}`);
      await forwardToHook(msg);
      log(`flush ok id=${msg.id}`);
    });
  }
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exitCode = 1;
});
