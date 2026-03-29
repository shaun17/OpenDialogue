import { getStateFilePath, readStateFile, atomicWriteJson } from "./config";

type ConversationState = {
  lastTurn: number;
  updatedAt: number;
  /** Ring buffer of recent inbound content hashes for loop detection */
  recentHashes: string[];
  /** Count of consecutive duplicate messages */
  dupCount: number;
};

const MAX_RECENT = 5;
const DUP_THRESHOLD = 3; // block after 3 consecutive similar messages

/**
 * Reads maxTurnsPerConversation from state.json on every check,
 * so changes take effect immediately without restart.
 */
function readMaxTurns(): number {
  const state = readStateFile();
  const val = state.maxTurnsPerConversation;
  return typeof val === "number" && val > 0 ? val : 20;
}

/** Ensures maxTurnsPerConversation exists in state.json with a default value. */
export function ensureMaxTurnsInState(): void {
  const state = readStateFile();
  if (typeof state.maxTurnsPerConversation !== "number") {
    state.maxTurnsPerConversation = 20;
    atomicWriteJson(getStateFilePath(), state);
  }
}

/** Reads persisted turn counts so restart doesn't reset the tracker. */
function readPersistedTurns(): Record<string, number> {
  const state = readStateFile();
  const raw = state.conversationTurns;
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, number>;
  }
  return {};
}

function persistTurns(turns: Record<string, number>): void {
  const state = readStateFile();
  state.conversationTurns = turns;
  atomicWriteJson(getStateFilePath(), state);
}

/** Simple content fingerprint — normalize whitespace and take first 200 chars */
function contentHash(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase();
}

export class ConversationTracker {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // Restore persisted turn counts on startup
    const persisted = readPersistedTurns();
    const now = Date.now();
    for (const [convId, turn] of Object.entries(persisted)) {
      this.conversations.set(convId, { lastTurn: turn, updatedAt: now, recentHashes: [], dupCount: 0 });
    }
  }

  accept(conversationId: string, turnNumber: number | undefined, now = Date.now(), content?: string): { allowed: boolean; effectiveTurn: number; reason?: string } {
    this.gc(now);
    let state = this.conversations.get(conversationId);
    if (!state) {
      state = { lastTurn: 0, updatedAt: now, recentHashes: [], dupCount: 0 };
      this.conversations.set(conversationId, state);
    }

    const effectiveTurn = turnNumber ?? (state.lastTurn + 1);

    const maxTurns = readMaxTurns();
    if (effectiveTurn > maxTurns) {
      return { allowed: false, effectiveTurn, reason: "turn_limit_exceeded" };
    }

    // Loop detection: check if content is repetitive
    if (content) {
      const hash = contentHash(content);
      const lastHash = state.recentHashes.length > 0 ? state.recentHashes[state.recentHashes.length - 1] : undefined;
      if (lastHash && (hash === lastHash || hash.includes("503") || hash.includes("error"))) {
        state.dupCount += 1;
      } else {
        state.dupCount = 0;
      }
      state.recentHashes.push(hash);
      if (state.recentHashes.length > MAX_RECENT) {
        state.recentHashes.shift();
      }
      if (state.dupCount >= DUP_THRESHOLD) {
        return { allowed: false, effectiveTurn, reason: "loop_detected" };
      }
    }

    state.lastTurn = Math.max(state.lastTurn, effectiveTurn);
    state.updatedAt = now;

    // Persist turn counts
    this.persistAll();

    return { allowed: true, effectiveTurn };
  }

  /** Reset a conversation (e.g. when starting a new one) */
  reset(conversationId: string): void {
    this.conversations.delete(conversationId);
    this.persistAll();
  }

  private persistAll(): void {
    const turns: Record<string, number> = {};
    for (const [key, value] of this.conversations.entries()) {
      turns[key] = value.lastTurn;
    }
    persistTurns(turns);
  }

  private gc(now: number): void {
    let changed = false;
    for (const [key, value] of this.conversations.entries()) {
      if (now - value.updatedAt > this.ttlMs) {
        this.conversations.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistAll();
  }
}
