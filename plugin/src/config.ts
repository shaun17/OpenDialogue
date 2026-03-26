import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HookConfig = {
  enabled: boolean;
  token: string;
  path: string;
  allowRequestSessionKey: boolean;
};

export type PluginConfig = {
  hook: HookConfig;
  gatewayBaseUrl: string;
  relayUrl: string;
  agentId: string;
  agentToken: string;
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
  return {
    hook: {
      enabled: true,
      token: String(hooks.token),
      path: String(hooks.path),
      allowRequestSessionKey: false
    },
    gatewayBaseUrl: process.env.OPENDIALOGUE_GATEWAY_BASE_URL ?? "http://127.0.0.1:18789",
    relayUrl: process.env.OPENDIALOGUE_SERVER_URL ?? "ws://127.0.0.1:19000/connect",
    agentId: process.env.OPENDIALOGUE_AGENT_ID ?? "local-agent",
    agentToken
  };
}
