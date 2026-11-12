/**
 * 为流式消费者维护有界的进程内准入状态。
 * Worker Host 负责持久认领与确认；此对象避免已认领但未确认的消息在内存中无限累积。
 */
export class WorkerAdmission {
  private concurrency: number
  private readonly pending = new Set<string>()
  private readonly buffered = new Set<string>()

  constructor(concurrency: number) {
    this.concurrency = validateConcurrency(concurrency)
  }

  get capacity(): number {
    return Math.max(0, Math.min(128, this.concurrency * 2) - this.pending.size)
  }

  get pendingIds(): string[] {
    return [...this.pending].sort()
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = validateConcurrency(concurrency)
  }

  /** 按可用容量预留消息，并忽略本地已存在的过期认领 ID。 */
  claim(messageIds: readonly string[]): number {
    const available = this.capacity
    if (available === 0) return 0
    let claimed = 0
    for (const id of messageIds) {
      if (!id || this.pending.has(id)) continue
      this.pending.add(id)
      claimed++
      if (claimed === available) break
    }
    return claimed
  }

  buffer(messageId: string): void {
    if (!this.pending.has(messageId)) throw new Error('消息尚未取得准入名额')
    this.buffered.add(messageId)
  }

  /** 派发完成时，仅释放未转入缓冲区的消息。 */
  dispatchFinished(messageId: string): void {
    if (!this.buffered.has(messageId)) this.pending.delete(messageId)
  }

  /** 持久确认后，同时释放 pending 与防抖缓冲占用。 */
  acknowledge(messageId: string): void {
    this.pending.delete(messageId)
    this.buffered.delete(messageId)
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('worker 并发数必须为正整数')
  return value
}
