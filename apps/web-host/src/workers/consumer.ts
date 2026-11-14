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
  recoverStarted?(messageId: string): Promise<boolean>
  leaseSeconds?: number
  completedSeconds?: number
  staleAfterMs?: number
  heartbeatIntervalMs?: number
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

  close(): Promise<void> {
    if (!this.closing) {
      this.stopping = true
      this.closing = this.waitForIdle()
    }
    return this.closing
  }

  private schedule(message: InboundMessage): void {
    const key = this.options.conversationKey(message)
    const task = this.withConversationLock(key, () => this.dispatch(message))
      .catch(() => { this.failureCount++ })
      .finally(() => {
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

  private async dispatch(message: InboundMessage): Promise<void> {
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
      if (!recovered) await this.options.handle(message.id, message.payload)
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
