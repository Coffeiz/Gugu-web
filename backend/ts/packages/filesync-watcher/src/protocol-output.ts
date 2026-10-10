import type { WatchEvent } from "./watcher.ts";

export type ProtocolMessage = WatchEvent | {
  protocol: number;
  kind: "response";
  id?: string;
  status: "ok" | "error";
  code?: string;
};

/** 有界 stdout 缓冲：事件可合并丢弃并保留缺口通知，控制确认优先出队。 */
export class BoundedProtocolOutput {
  private readonly queue: ProtocolMessage[] = [];
  private overflowPending = false;
  private readonly maximum: number;
  private readonly protocol: number;

  constructor(maximum: number, protocol: number) {
    this.maximum = maximum;
    this.protocol = protocol;
  }

  enqueue(message: ProtocolMessage): void {
    if (this.queue.length >= this.maximum) {
      this.overflowPending = true;
      if (message.kind === "event") return;
      const eventIndex = this.queue.findIndex((item) => item.kind === "event");
      if (eventIndex < 0) throw new Error("协议控制队列超限");
      this.queue.splice(eventIndex, 1);
      this.queue.unshift(message);
      return;
    }
    this.queue.push(message);
  }

  take(): ProtocolMessage | null {
    if (this.overflowPending) {
      this.overflowPending = false;
      return {
        protocol: this.protocol,
        kind: "event",
        event: "needs_reconcile",
        code: "output_overflow",
      };
    }
    return this.queue.shift() ?? null;
  }

  get hasPending(): boolean {
    return this.overflowPending || this.queue.length > 0;
  }
}
