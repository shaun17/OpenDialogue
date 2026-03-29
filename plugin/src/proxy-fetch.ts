/**
 * Proxy utilities for environments behind HTTP proxies (Surge, Clash, etc.).
 * Node.js native fetch and ws don't respect proxy env vars automatically.
 */

import type { Agent } from "node:http";

const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";

let _httpAgent: Agent | undefined;
let _resolved = false;

/**
 * Dynamically load https-proxy-agent (ESM-only package) and create an agent
 * for use with the `ws` WebSocket library.
 * Returns undefined if no proxy is configured or the package fails to load.
 */
export async function getProxyAgent(): Promise<Agent | undefined> {
  if (_resolved) return _httpAgent;
  _resolved = true;
  if (!PROXY_URL) return undefined;
  try {
    // Dynamic import to handle ESM-only package from CJS
    const mod = await (Function('specifier', 'return import(specifier)')('https-proxy-agent') as Promise<{ HttpsProxyAgent: new (url: string) => Agent }>);
    _httpAgent = new mod.HttpsProxyAgent(PROXY_URL);
  } catch {
    _httpAgent = undefined;
  }
  return _httpAgent;
}

/**
 * Proxy-aware fetch using undici ProxyAgent (bundled with Node.js 18+).
 */
export async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!PROXY_URL) return fetch(url, init);
  try {
    // undici is bundled with Node.js but has no CJS types — use dynamic import
    const undici = await (Function('specifier', 'return import(specifier)')('undici') as Promise<{ ProxyAgent: new (opts: { uri: string }) => object }>);
    const dispatcher = new undici.ProxyAgent({ uri: PROXY_URL });
    return fetch(url, { ...init, dispatcher } as never);
  } catch {
    return fetch(url, init);
  }
}
