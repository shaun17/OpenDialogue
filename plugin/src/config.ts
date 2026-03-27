import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookConfig = {
  enabled: boolean;
  token: string;
  path: string;
  allowRequestSessionKey: boolean;
};

export type TurnControlConfig = {
  enforceTurnLimit: boolean;
  maxTurnsPerConversation: number;
};

export type PluginConfig = {
  hook: HookConfig;
  gatewayBaseUrl: string;
  relayUrl: string;
  httpServerUrl: string;
  agentId: string;
  agentToken: string;
  turnControl: TurnControlConfig;
};

export function getOpenClawConfigPath(): string {
  return join(homedir(), ".openclaw", "openclaw.json");
}

function atomicWriteJson(path: string, data: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function ensurePluginConfig(): PluginConfig {
  const openclawPath = getOpenClawConfigPath();
  const raw = readFileSync(openclawPath, "utf8");
  const data = JSON.parse(raw) as Record<string, any>;
  const hooks = typeof data.hooks === "object" && data.hooks ? data.hooks : (data.hooks = {});

  hooks.enabled = true;
  hooks.path = typeof hooks.path === "string" && hooks.path.trim() ? hooks.path : "/hooks";
  hooks.token = typeof hooks.token === "string" && hooks.token.trim() ? hooks.token : randomBytes(16).toString("hex");
  hooks.allowRequestSessionKey = false;

  atomicWriteJson(openclawPath, data);

  const agentToken = process.env.OPENDIALOGUE_AGENT_TOKEN ?? "dev-agent-token";
  const relayUrl = process.env.OPENDIALOGUE_SERVER_URL ?? "ws://127.0.0.1:19000/connect";
  const httpServerUrl = relayUrl.replace(/^wss/, 'https').replace(/^ws/, 'http').replace(/\/connect$/, '');

  // 优先使用环境变量，其次使用 openclaw.json 中持久化的 agentId
  const opendialogue = typeof data.opendialogue === 'object' && data.opendialogue !== null ? data.opendialogue as Record<string, unknown> : {};
  const persistedAgentId = typeof opendialogue.agentId === 'string' ? opendialogue.agentId : undefined;
  const agentId = process.env.OPENDIALOGUE_AGENT_ID ?? persistedAgentId ?? "";

  return {
    hook: {
      enabled: true,
      token: String(hooks.token),
      path: String(hooks.path),
      allowRequestSessionKey: false
    },
    gatewayBaseUrl: process.env.OPENDIALOGUE_GATEWAY_BASE_URL ?? "http://127.0.0.1:18789",
    relayUrl,
    httpServerUrl,
    agentId,
    agentToken,
    turnControl: {
      enforceTurnLimit: parseBoolean(process.env.OPENDIALOGUE_ENFORCE_TURN_LIMIT, false),
      maxTurnsPerConversation: parseNumber(process.env.OPENDIALOGUE_MAX_TURNS_PER_CONVERSATION, 10)
    }
  };
}

export function saveAgentId(agentId: string): void {
  const path = getOpenClawConfigPath();
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw) as Record<string, any>;
  if (typeof data.opendialogue !== 'object' || data.opendialogue === null) {
    data.opendialogue = {};
  }
  (data.opendialogue as Record<string, unknown>).agentId = agentId;
  atomicWriteJson(path, data);
}
