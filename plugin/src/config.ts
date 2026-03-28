import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function getStateFilePath(): string {
  return join(homedir(), ".openclaw", "opendialogue-state.json");
}

export function atomicWriteJson(path: string, data: unknown): void {
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

export function readStateFile(): Record<string, unknown> {
  const path = getStateFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
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

  // Remove legacy opendialogue key if present (was mistakenly written to openclaw.json)
  delete data.opendialogue;

  atomicWriteJson(openclawPath, data);

  const relayUrl = process.env.OPENDIALOGUE_SERVER_URL ?? "ws://127.0.0.1:19000/connect";
  const httpServerUrl = relayUrl.replace(/^wss/, 'https').replace(/^ws/, 'http').replace(/\/connect$/, '');

  // Read plugin credentials from separate state file
  const state = readStateFile();
  const persistedAgentId = typeof state.agentId === 'string' ? state.agentId : undefined;
  const persistedAgentSecret = typeof state.agentSecret === 'string' ? state.agentSecret : undefined;
  const agentId = process.env.OPENDIALOGUE_AGENT_ID ?? persistedAgentId ?? "";
  const agentSecret = process.env.OPENDIALOGUE_AGENT_SECRET ?? persistedAgentSecret ?? process.env.OPENDIALOGUE_AGENT_TOKEN ?? "dev-agent-token";

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
    agentToken: agentSecret,
    turnControl: {
      enforceTurnLimit: parseBoolean(process.env.OPENDIALOGUE_ENFORCE_TURN_LIMIT, false),
      maxTurnsPerConversation: parseNumber(process.env.OPENDIALOGUE_MAX_TURNS_PER_CONVERSATION, 10)
    },
  };
}

export function saveAgentCredentials(agentId: string, agentSecret: string): void {
  const state = readStateFile();
  state.agentId = agentId;
  state.agentSecret = agentSecret;
  atomicWriteJson(getStateFilePath(), state);
}
