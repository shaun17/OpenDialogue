/**
 * Batches rapid-fire inbound messages from the same agent (e.g. offline queue flush)
 * into a single combined message, so only one LLM call is made instead of N.
 *
 * When a message arrives, it waits `windowMs` for more messages from the same agent.
 * If more arrive within the window, the timer resets. Once the window expires,
 * all collected messages are flushed as one batch.
 */

type InboundMsg = {
  id: string;
  from: string;
  to: string;
  content: string;
  conversation_id: string;
  turn_number?: number;
  timestamp: number;
};

type FlushFn = (combined: InboundMsg) => Promise<void>;

type PendingBatch = {
  messages: InboundMsg[];
  timer: ReturnType<typeof setTimeout>;
};

export class OfflineBatcher {
  private readonly batches = new Map<string, PendingBatch>();

  constructor(
    private readonly flush: FlushFn,
    private readonly windowMs = 2000,
    private readonly maxBatch = 50,
  ) {}

  /** Enqueue a message. It may be flushed immediately or batched. */
  add(msg: InboundMsg): void {
    const key = msg.from;
    const existing = this.batches.get(key);

    if (existing) {
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      // If we hit max batch size, flush immediately
      if (existing.messages.length >= this.maxBatch) {
        this.batches.delete(key);
        void this.flushBatch(key, existing.messages);
        return;
      }
      existing.timer = setTimeout(() => {
        this.batches.delete(key);
        void this.flushBatch(key, existing.messages);
      }, this.windowMs);
    } else {
      const batch: PendingBatch = {
        messages: [msg],
        timer: setTimeout(() => {
          this.batches.delete(key);
          void this.flushBatch(key, batch.messages);
        }, this.windowMs),
      };
      this.batches.set(key, batch);
    }
  }

  private async flushBatch(key: string, messages: InboundMsg[]): Promise<void> {
    if (messages.length === 0) return;

    if (messages.length === 1) {
      // Single message — no batching needed
      await this.flush(messages[0]!);
      return;
    }

    // Combine multiple messages into one, sorted by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);
    const combined: InboundMsg = {
      id: messages[messages.length - 1]!.id, // use latest message id
      from: messages[0]!.from,
      to: messages[0]!.to,
      conversation_id: messages[messages.length - 1]!.conversation_id,
      turn_number: messages[messages.length - 1]!.turn_number,
      timestamp: messages[messages.length - 1]!.timestamp,
      content: [
        `[${messages.length} offline messages received at once]`,
        ...messages.map((m, i) => `[${i + 1}] ${m.content}`),
      ].join('\n'),
    };

    await this.flush(combined);
  }

  /** Number of agents with pending batches */
  get pending(): number {
    return this.batches.size;
  }
}
