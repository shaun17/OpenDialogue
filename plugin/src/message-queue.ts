export type IncomingMessage = {
  id: string;
  from: string;
  to: string;
  type: string;
  content: string;
  conversation_id: string;
  turn_number?: number;
  timestamp: number;
  nonce: string;
  signature: string;
};

export class MessageQueue {
  private readonly items: IncomingMessage[] = [];
  constructor(private readonly maxSize = 100) {}

  enqueue(message: IncomingMessage): void {
    this.items.push(message);
    while (this.items.length > this.maxSize) this.items.shift();
  }

  async flush(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const pending = [...this.items];
    this.items.length = 0;
    for (const item of pending) {
      try {
        await handler(item);
      } catch {
        this.enqueue(item);
        break;
      }
    }
  }

  size(): number {
    return this.items.length;
  }
}
