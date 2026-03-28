import { randomBytes } from "node:crypto";
import { atomicWriteJson, getStateFilePath, readStateFile } from "./config";

/**
 * Persistent per-peer conversation ID map, stored under the "conversations"
 * key inside ~/.openclaw/opendialogue-state.json alongside agentId/agentSecret.
 *
 * Maps each remote agent ID to a stable conversation_id so that all messages
 * exchanged with a given peer share the same openclaw session
 * (sessionKey = `opendialogue:<conversation_id>`).
 */
export class ConversationMap {
  private data: Record<string, string>;

  constructor() {
    const state = readStateFile();
    this.data = (typeof state.conversations === "object" && state.conversations !== null)
      ? (state.conversations as Record<string, string>)
      : {};
  }

  get(peerId: string): string | undefined {
    return this.data[peerId];
  }

  /** Returns the existing conversation_id for this peer, or creates and persists a new one. */
  getOrCreate(peerId: string): string {
    if (!this.data[peerId]) {
      this.data[peerId] = randomBytes(16).toString("hex");
      this.persist();
    }
    return this.data[peerId];
  }

  /**
   * Records the conversation_id from an inbound message.
   * If it differs from what we have, updates and persists so both sides stay in sync.
   */
  set(peerId: string, conversationId: string): void {
    if (this.data[peerId] !== conversationId) {
      this.data[peerId] = conversationId;
      this.persist();
    }
  }

  private persist(): void {
    const state = readStateFile();
    state.conversations = this.data;
    atomicWriteJson(getStateFilePath(), state);
  }
}
