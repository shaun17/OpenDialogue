import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensurePluginConfig, getOpenClawConfigPath, saveAgentCredentials } from "./config";
import { ConversationMap } from "./conversation-map";
import { ConversationTracker } from "./conversation-tracker";
import { startDaemon } from "./daemon";
import { waitForGateway } from "./gateway-probe";
import { sendToHook } from "./hook-client";
import { MessageQueue } from "./message-queue";
import { RateLimiter } from "./rate-limiter";
import { startStatusServer } from "./status-server";

const execFileAsync = promisify(execFile);

function log(line: string): void {
  const file = `${getOpenClawConfigPath()}.opendialogue.log`;
  appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

function short(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function main() {
  const config = ensurePluginConfig();

  // 若没有 agentId，先向 Server 注册
  if (!config.agentId) {
    log(`no agentId found, registering with server url=${config.httpServerUrl}`);
    try {
      const res = await fetch(`${config.httpServerUrl}/api/agent/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "openclaw-agent" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { agent_id, agent_secret } = await res.json() as { agent_id: string; agent_secret: string };
      saveAgentCredentials(agent_id, agent_secret);
      config.agentId = agent_id;
      config.agentToken = agent_secret;
      log(`registered agentId=${agent_id}`);
    } catch (error) {
      log(`fatal: agent registration failed error=${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const queue = new MessageQueue(100);
  const rateLimiter = new RateLimiter(30, 60_000);
  const conversationMap = new ConversationMap();
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
    // Keep the conversation map in sync with inbound conversation IDs so that
    // outbound replies to this peer always reuse the same session.
    conversationMap.set(msg.from, msg.conversation_id);
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
      log(`hook forward ok id=${msg.id} status=${result.status} runId=${runId}`);

      // Notify the user's openclaw session about the inbound message.
      // If notifySession is configured, route to that specific session via /hooks/agent.
      // Otherwise fall back to /hooks/wake which targets the main session.
      try {
        if (config.notifySession) {
          await fetch(`${config.gatewayBaseUrl}${config.hook.path}/agent`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.hook.token}` },
            body: JSON.stringify({
              message: `[OpenDialogue] Agent ${msg.from} sent you a message (conversation ${msg.conversation_id}): ${short(msg.content, 120)}`,
              name: "OpenDialogue",
              sessionKey: config.notifySession,
              wakeMode: "now"
            })
          });
        } else {
          await fetch(`${config.gatewayBaseUrl}${config.hook.path}/wake`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.hook.token}` },
            body: JSON.stringify({
              text: `[OpenDialogue] Agent ${msg.from} sent you a message (conversation ${msg.conversation_id}): ${short(msg.content, 120)}`,
              mode: "now"
            })
          });
        }
      } catch (wakeError) {
        log(`wake notification failed id=${msg.id} error=${String(wakeError)}`);
      }

      // Invoke openclaw agent to get the LLM reply, then send it back to the sender
      try {
        const { stdout } = await execFileAsync("openclaw", [
          "agent", "--agent", "main", "--json",
          "--message", `[OpenDialogue from ${msg.from}] ${msg.content}`
        ], { timeout: 120_000 });
        const jsonStart = stdout.indexOf("{");
        if (jsonStart !== -1) {
          const parsed = JSON.parse(stdout.slice(jsonStart)) as { result?: { payloads?: Array<{ text?: string }> } };
          const replyText = parsed?.result?.payloads?.[0]?.text?.trim();
          if (replyText) {
            const statusPort = Number(process.env.OPENDIALOGUE_STATUS_PORT ?? "18791");
            await fetch(`http://127.0.0.1:${statusPort}/send`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ to: msg.from, conversation_id: msg.conversation_id, content: replyText })
            });
            log(`reply sent id=${msg.id} to=${msg.from} content=${short(replyText)}`);
          }
        }
      } catch (replyError) {
        log(`reply failed id=${msg.id} error=${String(replyError)}`);
      }
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
    agentId: config.agentId,  // 此时已保证非空
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
  }, conversationMap);

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
