import { getStateFilePath, readStateFile, atomicWriteJson } from "./config";

type ConversationState = {
  lastTurn: number;
  updatedAt: number;
};

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

export class ConversationTracker {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  accept(conversationId: string, turnNumber: number | undefined, now = Date.now()): { allowed: boolean; effectiveTurn: number; reason?: string } {
    this.gc(now);
    const state = this.conversations.get(conversationId);
    const effectiveTurn = turnNumber ?? (state ? state.lastTurn + 1 : 1);

    const maxTurns = readMaxTurns();
    if (effectiveTurn > maxTurns) {
      return { allowed: false, effectiveTurn, reason: "turn_limit_exceeded" };
    }

    this.conversations.set(conversationId, {
      lastTurn: Math.max(state?.lastTurn ?? 0, effectiveTurn),
      updatedAt: now
    });

    return { allowed: true, effectiveTurn };
  }

  private gc(now: number): void {
    for (const [key, value] of this.conversations.entries()) {
      if (now - value.updatedAt > this.ttlMs) this.conversations.delete(key);
    }
  }
}
