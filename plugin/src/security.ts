import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "./message-queue";

const NONCE_CACHE = new Map<string, number>();
const ALLOWED_TYPES = new Set(["text", "typing", "read_receipt"]);
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF]/g;
const DIRECTIONAL_CONTROL_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;
const URL_REGEX = /(?:https?|ftp):\/\/[^\s]+|data:[^\s]+/gi;

function isFresh(timestamp: number): boolean {
  return Math.abs(Date.now() - timestamp) <= 5 * 60 * 1000;
}

function markNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [key, expiry] of NONCE_CACHE.entries()) {
    if (expiry <= now) NONCE_CACHE.delete(key);
  }
  if (NONCE_CACHE.has(nonce)) return false;
  NONCE_CACHE.set(nonce, now + 5 * 60 * 1000);
  return true;
}

export function sanitizeContent(content: string): string {
  return content.normalize("NFC").replace(ZERO_WIDTH_REGEX, "").replace(DIRECTIONAL_CONTROL_REGEX, "");
}

export function detectUrls(content: string): string[] {
  return content.match(URL_REGEX) ?? [];
}

export function validateMessage(input: unknown, sessionKey: string): IncomingMessage {
  const msg = input as IncomingMessage;
  if (!msg || typeof msg !== "object") throw new Error("invalid message object");
  if (typeof msg.id !== "string" || typeof msg.from !== "string" || typeof msg.to !== "string") throw new Error("invalid routing fields");
  if (typeof msg.type !== "string" || typeof msg.content !== "string" || typeof msg.conversation_id !== "string" || !msg.conversation_id.trim()) {
    throw new Error("invalid content fields");
  }
  if (msg.turn_number !== undefined && (!Number.isInteger(msg.turn_number) || msg.turn_number <= 0)) {
    throw new Error("invalid turn_number");
  }
  if (typeof msg.timestamp !== "number" || typeof msg.nonce !== "string" || typeof msg.signature !== "string") throw new Error("invalid security fields");

  msg.content = sanitizeContent(msg.content);
  msg.conversation_id = msg.conversation_id.trim();

  if (!isFresh(msg.timestamp)) throw new Error("stale message");
  if (!markNonce(msg.nonce)) throw new Error("replayed nonce");
  if (!ALLOWED_TYPES.has(msg.type)) throw new Error("unsupported message type");
  if (msg.content.length > 2000) throw new Error("content too long");
  if (CONTROL_CHAR_REGEX.test(msg.content)) throw new Error("control chars not allowed");

  const turnMaterial = msg.turn_number === undefined ? "" : `|${msg.turn_number}`;
  const material = `${msg.id}|${msg.from}|${msg.to}|${msg.type}|${msg.content}|${msg.conversation_id}${turnMaterial}|${msg.timestamp}|${msg.nonce}`;
  const expected = createHmac("sha256", sessionKey).update(material).digest();
  const actual = Buffer.from(msg.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("bad signature");
  }
  return msg;
}
