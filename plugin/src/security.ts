import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "./message-queue";

const NONCE_CACHE = new Map<string, number>();
const ALLOWED_TYPES = new Set(["text", "typing", "read_receipt"]);
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

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

export function validateMessage(input: unknown, sessionKey: string): IncomingMessage {
  const msg = input as IncomingMessage;
  if (!msg || typeof msg !== "object") throw new Error("invalid message object");
  if (typeof msg.id !== "string" || typeof msg.from !== "string" || typeof msg.to !== "string") throw new Error("invalid routing fields");
  if (typeof msg.type !== "string" || typeof msg.content !== "string") throw new Error("invalid content fields");
  if (typeof msg.timestamp !== "number" || typeof msg.nonce !== "string" || typeof msg.signature !== "string") throw new Error("invalid security fields");
  if (!isFresh(msg.timestamp)) throw new Error("stale message");
  if (!markNonce(msg.nonce)) throw new Error("replayed nonce");
  if (!ALLOWED_TYPES.has(msg.type)) throw new Error("unsupported message type");
  if (msg.content.length > 2000) throw new Error("content too long");
  if (CONTROL_CHAR_REGEX.test(msg.content)) throw new Error("control chars not allowed");

  const material = `${msg.id}|${msg.from}|${msg.to}|${msg.content}|${msg.timestamp}|${msg.nonce}`;
  const expected = createHmac("sha256", sessionKey).update(material).digest();
  const actual = Buffer.from(msg.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("bad signature");
  }
  return msg;
}
