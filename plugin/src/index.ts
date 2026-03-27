import { appendFileSync } from "node:fs";
import { ensurePluginConfig, getOpenClawConfigPath } from "./config";
import { ConversationTracker } from "./conversation-tracker";
import { startDaemon } from "./daemon";
import { waitForGateway } from "./gateway-probe";
import { sendToHook } from "./hook-client";
import { MessageQueue } from "./message-queue";
import { RateLimiter } from "./rate-limiter";
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
  const rateLimiter = new RateLimiter(30, 60_000);
  const conversationTracker = new ConversationTracker(config.turnControl.maxTurnsPerConversation);
  const state = {
    connected: false,
    serverUrl: config.relayUrl,
    agentId: config.agentId,
    gatewayReady: false,
    sessionKey: undefined as string | undefined,
    lastError: undefined as string | undefined
  };

  const forwardToHook = async (msg: { id: string; from: string; to: string; content: string; conversation_id: string; turn_number?: number; timestamp: number }) => {
    if (!rateLimiter.allow(msg.from, msg.timestamp ?? Date.now())) {
      log(`dropped inbound message reason=rate_limit_exceeded id=${msg.id} from=${msg.from}`);
      return;
    }

    const turnCheck = conversationTracker.accept(msg.conversation_id, msg.turn_number, msg.timestamp ?? Date.now());
    if (config.turnControl.enforceTurnLimit && !turnCheck.allowed) {
      log(`dropped inbound message reason=${turnCheck.reason} id=${msg.id} from=${msg.from} conversation_id=${msg.conversation_id} turn=${turnCheck.effectiveTurn} maxTurns=${config.turnControl.maxTurnsPerConversation}`);
      return;
    }

    log(`accepted inbound message id=${msg.id} from=${msg.from} to=${msg.to} conversation_id=${msg.conversation_id} turn=${turnCheck.effectiveTurn} content=${short(msg.content)}`);
    try {
      const result = await sendToHook(
        msg.from,
        msg.content,
        {
          baseUrl: config.gatewayBaseUrl,
          token: config.hook.token,
          path: config.hook.path,
          retries: 3
        },
        {
          conversation_id: msg.conversation_id,
          turn_number: turnCheck.effectiveTurn,
          trust_level: "unknown"
        }
      );
      const runId = typeof result.bodyJson?.runId === "string" ? result.bodyJson.runId : "unknown";
      log(`hook forward ok id=${msg.id} status=${result.status} runId=${runId} body=${short(result.bodyText, 240)}`);
    } catch (error) {
      log(`hook forward failed id=${msg.id} error=${String(error)}`);
      throw error;
    }
  };

  const flushQueue = async () => {
    if (!state.gatewayReady || queue.size() === 0) return;
    await queue.flush(async (msg) => {
      log(`flushing queued message id=${msg.id} from=${msg.from}`);
      await forwardToHook(msg);
      log(`flush ok id=${msg.id}`);
    });
  };

  const daemon = startDaemon({
    serverUrl: config.relayUrl,
    agentId: config.agentId,
    agentToken: config.agentToken,
    queue,
    state,
    onAccepted: forwardToHook,
    onDropped: (reason, raw) => {
      log(`dropped inbound message reason=${reason} raw=${short(String(raw), 240)}`);
    },
    onEvent: (line) => {
      log(line);
    }
  });

  startStatusServer(state, () => queue.size(), (payload) => {
    log(`outbound send requested payload=${short(String(payload), 240)}`);
    const sent = daemon.send(payload);
    log(`outbound ws send attempted sent=${sent}`);
  }, {
    enforceTurnLimit: config.turnControl.enforceTurnLimit,
    maxTurnsPerConversation: config.turnControl.maxTurnsPerConversation
  });

  log(`plugin boot: relay=${config.relayUrl} agent=${config.agentId}`);
  state.gatewayReady = await waitForGateway(config.gatewayBaseUrl);
  log(`gateway ready=${state.gatewayReady}`);
  await flushQueue();

  setInterval(async () => {
    const wasReady = state.gatewayReady;
    const isReady = await waitForGateway(config.gatewayBaseUrl, 1, 250);
    state.gatewayReady = isReady;
    if (isReady && !wasReady) {
      log("gateway transitioned to ready");
      await flushQueue();
    }
    if (!isReady && wasReady) {
      log("gateway transitioned to not-ready");
    }
  }, 2000);
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exitCode = 1;
});
