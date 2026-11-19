import { WorkerAdmission } from './admission.js'
import type { MessageLeaseStore } from './message-lease.js'
import { MESSAGE_LEASE_HEARTBEAT_SECONDS } from './redis-message-lease.js'

export interface RenewableMessageLeaseStore extends MessageLeaseStore {
  renew(stateKey: string, owner: string, leaseSeconds: number): Promise<boolean>
}

export interface InboundMessage {
  id: string
  payload: Record<string, unknown>
}

export interface StreamQueue {
  claimStale(count: number, minIdleMs: number): Promise<InboundMessage[]>
  consume(count: number, blockMs: number): Promise<InboundMessage[]>
  acknowledge(messageId: string): Promise<void>
}

export interface WorkerConsumerOptions {
  queue: StreamQueue
  leases: RenewableMessageLeaseStore
  concurrency: number
  pendingCapacity?: number
  createOwner(): string
  stateKey(messageId: string): string
  conversationKey(message: InboundMessage): string
  handle(messageId: string, payload: Record<string, unknown>): Promise<void>
  /** 立即处理控制/被动消息并解封；null表示本条已完成，回复消息返回进程内可信载荷。 */
  beforeBatch?(messageId: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null>
  /** 只在持久批次事务成功后返回；失败保留每条消息各自的Stream与租约状态。 */
  handleBatch?(messages: readonly InboundMessage[]): Promise<void>
  batchDelayMs?: number
  recoverStarted?(messageId: string): Promise<boolean>
  leaseSeconds?: number
  completedSeconds?: number
  staleAfterMs?: number
  heartbeatIntervalMs?: number
}

interface BufferedMessage {
  message: InboundMessage
  live(): boolean
  resolve(): void
  reject(error: unknown): void
}
interface ConversationBuffer {
  items: BufferedMessage[]
  timer: ReturnType<typeof setTimeout> | null
  deadline: number
  flushing: boolean
}

/**
 * 有界的入站队列消费编排。队列 adapter 负责 Stream claim/read/ack，
 * lease adapter 负责跨进程原子去重；具体业务 handler 由 Worker Host 注入。
 */
export class WorkerConsumer {
  private readonly admission: WorkerAdmission
  private readonly inFlight = new Set<Promise<void>>()
  private stopping = false
  private closing?: Promise<void>
  private failureCount = 0
  private readonly leaseSeconds: number
  private readonly completedSeconds: number
  private readonly staleAfterMs: number
  private readonly heartbeatIntervalMs: number
  private readonly pendingCapacity: number
  private readonly conversationTails = new Map<string, Promise<void>>()
  private readonly preparationTails = new Map<string, Promise<void>>()
  private readonly buffers = new Map<string, ConversationBuffer>()
  private readonly batchDelayMs: number

  constructor(private readonly options: WorkerConsumerOptions) {
    this.admission = new WorkerAdmission(options.concurrency)
    const pythonCapacity = Math.min(128, Math.max(1, options.concurrency * 2))
    this.pendingCapacity = options.pendingCapacity ?? pythonCapacity
    if (!Number.isSafeInteger(this.pendingCapacity) || this.pendingCapacity < 1 || this.pendingCapacity > pythonCapacity)
      throw new RangeError('pendingCapacity 必须在 1 到 Python 并发准入上限之间')
    this.leaseSeconds = options.leaseSeconds ?? 120
    this.completedSeconds = options.completedSeconds ?? 3600
    this.staleAfterMs = options.staleAfterMs ?? 60_000
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? MESSAGE_LEASE_HEARTBEAT_SECONDS * 1000
    this.batchDelayMs = options.batchDelayMs ?? 1000
    if (Boolean(options.beforeBatch) !== Boolean(options.handleBatch)) throw new TypeError('批次准备和处理端口必须同时配置')
    if (!Number.isSafeInteger(this.batchDelayMs) || this.batchDelayMs < 1) throw new RangeError('批次防抖间隔无效')
  }

  get failures(): number {
    return this.failureCount
  }

  async runOnce(blockMs = 5000): Promise<number> {
    if (this.stopping) return 0
    const free = Math.max(0, this.pendingCapacity - this.admission.pendingIds.length)
    if (free <= 0) return 0
    const pending = new Set(this.admission.pendingIds)
    const stale = (await this.options.queue.claimStale(free, this.staleAfterMs))
      .filter(message => !pending.has(message.id))
    const newMessages = free > stale.length
      ? await this.options.queue.consume(free - stale.length, blockMs)
      : []
    const messages = [...stale, ...newMessages].filter((message, index, all) =>
      !pending.has(message.id) && all.findIndex(candidate => candidate.id === message.id) === index,
    )
    if (this.stopping) return 0
    const before = new Set(this.admission.pendingIds)
    this.admission.claim(messages.map(message => message.id))
    const reserved = new Set(this.admission.pendingIds.filter(id => !before.has(id)))
    const accepted = messages.filter(message => reserved.has(message.id))
    for (const message of accepted) this.schedule(message)
    return accepted.length
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight])
  }

  /** 准入满时等待实际在途任务释放容量，避免Host空转饿死网络/取消回调。 */
  async waitForCapacity(): Promise<void> {
    if (this.admission.pendingIds.length >= this.pendingCapacity && this.inFlight.size)
      await Promise.race([...this.inFlight])
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopping = true
      for (const [key, buffer] of this.buffers) this.flushBuffer(key, buffer)
      this.closing = this.waitForIdle()
    }
    return this.closing
  }

  private schedule(message: InboundMessage): void {
    const key = this.options.conversationKey(message)
    let releasePreparation = () => {}
    let previous = Promise.resolve()
    let prepared: Promise<void> | null = null
    if (this.options.handleBatch) {
      previous = this.preparationTails.get(key) ?? Promise.resolve()
      prepared = new Promise<void>(resolve => { releasePreparation = resolve })
      this.preparationTails.set(key, prepared)
    }
    const task = (this.options.handleBatch
      ? this.dispatch(message, { key, previous, release: releasePreparation })
      : this.withConversationLock(key, () => this.dispatch(message)))
      .catch(() => { this.failureCount++ })
      .finally(async () => {
        if (prepared) {
          await previous
          releasePreparation()
          if (this.preparationTails.get(key) === prepared) this.preparationTails.delete(key)
        }
        this.admission.dispatchFinished(message.id)
        this.inFlight.delete(task)
      })
    this.inFlight.add(task)
  }

  private async withConversationLock(key: string, dispatch: () => Promise<void>): Promise<void> {
    const previous = this.conversationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.conversationTails.set(key, current)
    await previous
    try {
      await dispatch()
    } finally {
      release()
      if (this.conversationTails.get(key) === current) this.conversationTails.delete(key)
    }
  }

  private async dispatch(message: InboundMessage, preparation?: { key: string; previous: Promise<void>; release(): void }): Promise<void> {
    const owner = this.options.createOwner()
    const key = this.options.stateKey(message.id)
    const claim = await this.options.leases.claim(key, owner, this.leaseSeconds)
    if (claim === 'busy') return
    if (claim === 'completed') {
      await this.options.queue.acknowledge(message.id)
      this.admission.acknowledge(message.id)
      return
    }

    const heartbeat = this.startHeartbeat(key, owner)
    let recovered = false
    try {
      recovered = Boolean(this.options.recoverStarted &&
        await this.options.recoverStarted(message.id))
      if (!recovered) {
        if (preparation) {
          const payload = await this.options.beforeBatch!(message.id, message.payload)
          if (payload !== null) {
            const plain = { id: message.id, payload }
            if (this.options.conversationKey(plain) !== preparation.key) throw new Error('批次准备改变会话作用域')
            await preparation.previous
            const completed = this.bufferMessage(preparation.key, plain, () => !heartbeat.lost)
            preparation.release()
            await completed
          }
        } else await this.options.handle(message.id, message.payload)
      }
    } finally {
      heartbeat.stop()
      await heartbeat.done
    }
    if (heartbeat.lost) return
    const completed = await this.options.leases.complete(key, owner, this.completedSeconds)
    if (!completed) return
    await this.options.queue.acknowledge(message.id)
    this.admission.acknowledge(message.id)
  }

  private bufferMessage(key: string, message: InboundMessage, live: () => boolean): Promise<void> {
    let buffer = this.buffers.get(key)
    if (!buffer) {
      buffer = { items: [], timer: null, deadline: 0, flushing: false }
      this.buffers.set(key, buffer)
    }
    if (buffer.items.length >= 128) throw new Error('批次消息超过准入上限')
    const done = new Promise<void>((resolve, reject) => buffer!.items.push({ message, live, resolve, reject }))
    buffer.deadline = Date.now() + this.batchDelayMs
    this.armBuffer(key, buffer)
    return done
  }

  private armBuffer(key: string, buffer: ConversationBuffer): void {
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = null
    if (buffer.flushing) return
    if (this.stopping) { this.flushBuffer(key, buffer); return }
    buffer.timer = setTimeout(() => this.flushBuffer(key, buffer), Math.max(0, buffer.deadline - Date.now()))
  }

  private flushBuffer(key: string, buffer: ConversationBuffer): void {
    if (buffer.flushing || !buffer.items.length) return
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = null
    buffer.flushing = true
    void this.withConversationLock(key, async () => {
      // 同一轮准入中的慢early-persist不能让快消息先被flush；准备本身不持有此锁。
      let preparation: Promise<void> | undefined
      do {
        preparation = this.preparationTails.get(key)
        if (preparation) await preparation
      } while (this.preparationTails.get(key) !== preparation)
      const current = buffer.items.splice(0), live = current.filter(item => item.live())
      try {
        if (live.length) await this.options.handleBatch!(live.map(item => item.message))
        for (const item of current) item.resolve()
      } catch (error) { for (const item of current) item.reject(error) }
    }).finally(() => {
      buffer.flushing = false
      if (buffer.items.length) this.armBuffer(key, buffer)
      else if (this.buffers.get(key) === buffer) this.buffers.delete(key)
    })
  }

  private startHeartbeat(stateKey: string, owner: string) {
    let stopped = false
    let lost = false
    let cancelDelay = () => {}
    const done = (async () => {
      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.heartbeatIntervalMs)
          cancelDelay = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        if (stopped) return
        try {
          if (!(await this.options.leases.renew(stateKey, owner, this.leaseSeconds))) {
            lost = true
            return
          }
        } catch {
          lost = true
          return
        }
      }
    })()
    return {
      done,
      get lost() { return lost },
      stop() {
        stopped = true
        cancelDelay()
      },
    }
  }
}
