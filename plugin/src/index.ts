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

  const ws = startDaemon({
    serverUrl: config.relayUrl,
    agentId: config.agentId,
    agentToken: config.agentToken,
    queue,
    state,
    onAccepted: async (msg) => {
      await sendToHook(msg.from, msg.content, {
        baseUrl: config.gatewayBaseUrl,
        token: config.hook.token,
        path: config.hook.path,
        retries: 3
      });
    }
  });

  startStatusServer(state, () => queue.size(), (payload) => {
    ws.send(payload);
  });

  log(`plugin boot: relay=${config.relayUrl} agent=${config.agentId}`);
  state.gatewayReady = await waitForGateway(config.gatewayBaseUrl);
  log(`gateway ready=${state.gatewayReady}`);

  if (state.gatewayReady) {
    await queue.flush(async (msg) => {
      await sendToHook(msg.from, msg.content, {
        baseUrl: config.gatewayBaseUrl,
        token: config.hook.token,
        path: config.hook.path,
        retries: 3
      });
    });
  }
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exitCode = 1;
});
