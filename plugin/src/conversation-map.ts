import { randomBytes } from "node:crypto";
import { atomicWriteJson, getStateFilePath, readStateFile } from "./config";

export type PeerEntry = {
  conversationId: string;
  replySession?: string;
};

/**
 * Persistent per-peer conversation state, stored under the "conversations"
 * key inside ~/.openclaw/opendialogue-state.json.
 *
 * Each peer maps to:
 *   - conversationId: stable ID shared with the peer for openclaw sessionKey
 *   - replySession:   (optional) the local openclaw session to notify when
 *                     this peer sends a message back
 */
export class ConversationMap {
  private data: Record<string, PeerEntry>;

  constructor() {
    const state = readStateFile();
    const raw = state.conversations;
    if (typeof raw === "object" && raw !== null) {
      // Support migration from old format (Record<string, string>)
      const entries: Record<string, PeerEntry> = {};
      for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof val === "string") {
          entries[key] = { conversationId: val };
        } else if (typeof val === "object" && val !== null && "conversationId" in val) {
          entries[key] = val as PeerEntry;
        }
      }
      this.data = entries;
    } else {
      this.data = {};
    }
  }

  getEntry(peerId: string): PeerEntry | undefined {
    return this.data[peerId];
  }

  getConversationId(peerId: string): string | undefined {
    return this.data[peerId]?.conversationId;
  }

  getReplySession(peerId: string): string | undefined {
    return this.data[peerId]?.replySession;
  }

  /** Returns the existing conversationId for this peer, or creates and persists a new one. */
  getOrCreateConversationId(peerId: string): string {
    if (!this.data[peerId]) {
      this.data[peerId] = { conversationId: randomBytes(16).toString("hex") };
      this.persist();
    }
    return this.data[peerId].conversationId;
  }

  /** Updates conversationId from an inbound message so both sides stay in sync. */
  setConversationId(peerId: string, conversationId: string): void {
    const entry = this.data[peerId];
    if (!entry) {
      this.data[peerId] = { conversationId };
      this.persist();
    } else if (entry.conversationId !== conversationId) {
      entry.conversationId = conversationId;
      this.persist();
    }
  }

  /** Records the replySession for a peer (set when /send is called with reply_session). */
  setReplySession(peerId: string, replySession: string): void {
    const entry = this.data[peerId];
    if (!entry) {
      this.data[peerId] = { conversationId: randomBytes(16).toString("hex"), replySession };
      this.persist();
    } else if (entry.replySession !== replySession) {
      entry.replySession = replySession;
      this.persist();
    }
  }

  private persist(): void {
    const state = readStateFile();
    state.conversations = this.data;
    atomicWriteJson(getStateFilePath(), state);
  }
}
