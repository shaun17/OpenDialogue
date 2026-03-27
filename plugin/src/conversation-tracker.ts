type ConversationState = {
  lastTurn: number;
  updatedAt: number;
};

export class ConversationTracker {
  private readonly conversations = new Map<string, ConversationState>();

  constructor(
    private readonly maxTurns: number,
    private readonly ttlMs = 24 * 60 * 60 * 1000
  ) {}

  accept(conversationId: string, turnNumber: number | undefined, now = Date.now()): { allowed: boolean; effectiveTurn: number; reason?: string } {
    this.gc(now);
    const state = this.conversations.get(conversationId);
    const effectiveTurn = turnNumber ?? (state ? state.lastTurn + 1 : 1);

    if (effectiveTurn > this.maxTurns) {
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
