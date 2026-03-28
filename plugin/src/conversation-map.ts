import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function getFilePath(): string {
  return join(homedir(), ".openclaw", "opendialogue-conversations.json");
}

function load(): Record<string, string> {
  const path = getFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function persist(data: Record<string, string>): void {
  const path = getFilePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Persistent per-peer conversation ID map.
 *
 * Maps each remote agent ID to a stable conversation_id so that all messages
 * exchanged between this agent and a given peer belong to the same openclaw
 * session (sessionKey = `opendialogue:<conversation_id>`).
 *
 * The map is stored at ~/.openclaw/opendialogue-conversations.json and
 * survives plugin restarts.
 */
export class ConversationMap {
  private data: Record<string, string>;

  constructor() {
    this.data = load();
  }

  get(peerId: string): string | undefined {
    return this.data[peerId];
  }

  /** Returns the existing conversation_id for this peer, or creates and persists a new one. */
  getOrCreate(peerId: string): string {
    if (!this.data[peerId]) {
      this.data[peerId] = randomBytes(16).toString("hex");
      persist(this.data);
    }
    return this.data[peerId];
  }

  /**
   * Records the conversation_id used by an inbound message from a peer.
   * If the peer already has a different conversation_id, the inbound one
   * takes precedence so both sides stay in sync.
   */
  set(peerId: string, conversationId: string): void {
    if (this.data[peerId] !== conversationId) {
      this.data[peerId] = conversationId;
      persist(this.data);
    }
  }
}
