export interface ScheduledTaskRecord {
  id: string
  userId: string
  enabled: boolean
  scheduleKind: 'once' | 'cron' | 'interval'
  startAt: number
  lastRunAt: number | null
  lastRunFailed: boolean
}

export interface OnceTaskRepository {
  getOnce(taskId: string): Promise<ScheduledTaskRecord | null>
  /** 必须持久化开始时间，并只允许未完成或已失败的一次性任务进入执行态。 */
  markStarted(taskId: string, at: number, userId: string, expectedStartAt?: number): Promise<boolean>
  /** Promise 仅在失败态事务提交后 resolve；通知由 runner 在提交后发出。 */
  markFailed(taskId: string, userId: string): Promise<void>
  /** Promise 仅在删除事务提交后 resolve；通知由 runner 在提交后发出。 */
  deleteCompleted(taskId: string, userId: string): Promise<void>
  findStartedOnceBefore(at: number): Promise<ScheduledTaskRecord[]>
}

export interface ScheduledTaskLease {
  /** 使用 owner 条件的非阻塞分布式锁，成功时建立或刷新 TTL。 */
  acquire(taskId: string, owner: string, leaseMs: number): Promise<boolean>
  renew(taskId: string, owner: string, leaseMs: number): Promise<boolean>
  release(taskId: string, owner: string): Promise<void>
  isHeld(taskId: string): Promise<boolean>
}

export type AssertScheduledTaskLease = () => Promise<void>
export type ScheduledTaskExecutionCallback = (assertLease: AssertScheduledTaskLease) => Promise<Record<string, string>>

export type ScheduledTaskRunResult =
  | 'completed'
  | 'failed'
  | 'busy'
  | 'not_found'
  | 'not_due'
  | 'already_run'
  | 'lease_lost'

export interface ScheduledTaskRunnerOptions {
  repository: OnceTaskRepository
  lease: ScheduledTaskLease
  createOwner(): string
  lockTimeoutMs?: number
  heartbeatIntervalMs?: number
  /** 记录续租异常的无敏感信息诊断回调；异常不应中断后续续租。 */
  onLeaseRenewError?(): void
  /** 任务状态提交后发布 scheduled_tasks 刷新事件；失败不改变执行结果。 */
  notifyTasksChanged(userId: string): Promise<void>
}

const ONCE_EXPIRATION_GRACE_MS = 120_000
const DEFAULT_LOCK_TIMEOUT_MS = 600_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 180_000
const SUCCESSFUL_DELIVERIES = new Set(['已发送', '已保存（实时提示失败）'])

/**
 * 一次性定时任务的执行与恢复编排。APS/Host 负责按时间触发，仓储负责事务，
 * lease adapter 负责 Redis owner 锁，execute 回调负责 Agent 与实际渠道投递。
 */
export class ScheduledTaskRunner {
  private readonly lockTimeoutMs: number
  private readonly heartbeatIntervalMs: number

  constructor(private readonly options: ScheduledTaskRunnerOptions) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1)
      throw new RangeError('锁超时必须是正整数毫秒')
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1 ||
      this.heartbeatIntervalMs >= this.lockTimeoutMs)
      throw new RangeError('续租间隔必须大于零且小于锁超时')
  }

  async runDue(
    taskId: string,
    execute: ScheduledTaskExecutionCallback,
    now = Date.now(),
    options: { allowFutureRetry?: boolean; userId?: string; expectedStartAt?: number; beforeStart?: (task: ScheduledTaskRecord) => Promise<boolean> } = {},
  ): Promise<ScheduledTaskRunResult> {
    const owner = this.options.createOwner()
    if (!await this.options.lease.acquire(taskId, owner, this.lockTimeoutMs)) return 'busy'

    let startedFor: string | undefined
    // Python 在获取分布式锁后立即续租，覆盖随后发生的数据库读取和写入。
    const heartbeat = this.startHeartbeat(taskId, owner)
    try {
      const task = await this.options.repository.getOnce(taskId)
      if (!task || !task.enabled || task.scheduleKind !== 'once' || (options.userId !== undefined && task.userId !== options.userId)) return 'not_found'
      const expectedStartAt = options.expectedStartAt
      if (expectedStartAt !== undefined && (task.startAt !== expectedStartAt || now - expectedStartAt > 1000)) return 'not_due'
      if (task.startAt > now && !(options.allowFutureRetry && task.lastRunFailed)) return 'not_due'
      if (task.lastRunAt !== null && (!task.lastRunFailed || expectedStartAt !== undefined)) return 'already_run'
      if (options.beforeStart && !await options.beforeStart(task)) return 'failed'
      if (heartbeat.lost) return 'lease_lost'
      if (expectedStartAt !== undefined) {
        try { await heartbeat.assertLease() } catch { return 'lease_lost' }
      }
      if (!await this.options.repository.markStarted(taskId, now, task.userId, expectedStartAt)) return 'already_run'
      startedFor = task.userId

      let delivery: Record<string, string>
      try {
        delivery = await execute(heartbeat.assertLease)
      } catch {
        heartbeat.stop()
        await heartbeat.done
        if (heartbeat.lost) return 'lease_lost'
        await this.options.repository.markFailed(taskId, task.userId)
        await this.notifyTasksChanged(task.userId)
        return 'failed'
      }
      heartbeat.stop()
      await heartbeat.done
      if (heartbeat.lost) return 'lease_lost'

      if (!this.deliverySucceeded(delivery)) {
        await this.options.repository.markFailed(taskId, task.userId)
        await this.notifyTasksChanged(task.userId)
        return 'failed'
      }
      await this.options.repository.deleteCompleted(taskId, task.userId)
      await this.notifyTasksChanged(task.userId)
      return 'completed'
    } catch (error) {
      if (startedFor !== undefined && !heartbeat.lost) {
        await this.options.repository.markFailed(taskId, startedFor)
        await this.notifyTasksChanged(startedFor)
      }
      throw error
    } finally {
      heartbeat.stop()
      await heartbeat.done
      await this.options.lease.release(taskId, owner)
    }
  }

  /** 用户手动试运行共用同一分布式租约，但不写一次性任务调度状态。 */
  async runTrial(
    taskId: string,
    execute: ScheduledTaskExecutionCallback,
  ): Promise<{ status: 'completed' | 'failed' | 'busy' | 'lease_lost'; delivery?: Record<string, string> }> {
    const owner = this.options.createOwner()
    if (!await this.options.lease.acquire(taskId, owner, this.lockTimeoutMs)) return { status: 'busy' }
    const heartbeat = this.startHeartbeat(taskId, owner)
    try {
      let delivery: Record<string, string>
      try {
        delivery = await execute(heartbeat.assertLease)
      } catch {
        heartbeat.stop()
        await heartbeat.done
        return heartbeat.lost ? { status: 'lease_lost' } : { status: 'failed' }
      }
      heartbeat.stop()
      await heartbeat.done
      if (heartbeat.lost) return { status: 'lease_lost' }
      return { status: this.deliverySucceeded(delivery) ? 'completed' : 'failed', delivery }
    } finally {
      heartbeat.stop()
      await heartbeat.done
      await this.options.lease.release(taskId, owner)
    }
  }

  /** 重启扫描只修复已超出锁宽限且没有活跃 lease 的一次性任务。 */
  async recoverAbandoned(now = Date.now(), requireExpired = false): Promise<string[]> {
    const cutoff = now - this.lockTimeoutMs
    const candidates = await this.options.repository.findStartedOnceBefore(cutoff)
    const recovered: string[] = []
    for (const task of candidates) {
      const owner = this.options.createOwner()
      try {
        if (!await this.options.lease.acquire(task.id, owner, this.lockTimeoutMs)) continue
      } catch {
        // Redis 不可用时保守保留任务。
        continue
      }
      try {
        const current = await this.options.repository.getOnce(task.id)
        if (!current || current.userId !== task.userId || current.lastRunAt === null || current.lastRunAt >= cutoff
          || current.lastRunFailed || (requireExpired && current.startAt >= now - ONCE_EXPIRATION_GRACE_MS)) continue
        await this.options.repository.markFailed(task.id, current.userId)
        await this.notifyTasksChanged(current.userId)
        recovered.push(task.id)
      } finally {
        await this.options.lease.release(task.id, owner)
      }
    }
    return recovered
  }

  /** 只清理从未执行的过期任务。手动试运行和其他 Worker 持锁时保留。 */
  async collectExpiredOnce(repository: {
    findExpiredUnstarted(before: number): Promise<ScheduledTaskRecord[]>
    deleteExpiredUnstarted(taskId: string, ownerId: string, before: number): Promise<boolean>
  }, now = Date.now()): Promise<void> {
    const before = now - ONCE_EXPIRATION_GRACE_MS
    const changed = new Set<string>()
    try {
      for (const task of await repository.findExpiredUnstarted(before)) {
        const owner = this.options.createOwner()
        if (!await this.options.lease.acquire(task.id, owner, this.lockTimeoutMs)) continue
        try {
          if (await repository.deleteExpiredUnstarted(task.id, task.userId, before)) changed.add(task.userId)
        } finally {
          await this.options.lease.release(task.id, owner)
        }
      }
    } finally {
      for (const owner of changed) await this.notifyTasksChanged(owner)
    }
  }

  private deliverySucceeded(result: Record<string, string>): boolean {
    return Object.values(result).every(status => SUCCESSFUL_DELIVERIES.has(status))
  }

  private async notifyTasksChanged(userId: string): Promise<void> {
    try {
      await this.options.notifyTasksChanged(userId)
    } catch {
      // 状态已经提交；事件总线故障不应把成功任务变成可重试任务。
    }
  }

  private startHeartbeat(taskId: string, owner: string) {
    let stopped = false
    let lost = false
    let cancelDelay = () => {}
    const { lease, onLeaseRenewError: diagnose } = this.options
    const timeout = this.lockTimeoutMs
    const done = (async () => {
      while (!stopped) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.heartbeatIntervalMs)
          cancelDelay = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        if (stopped) return
        try {
          if (!await this.options.lease.renew(taskId, owner, this.lockTimeoutMs)) {
            lost = true
            return
          }
        } catch {
          try {
            this.options.onLeaseRenewError?.()
          } catch {
            // 诊断回调也不能结束续租循环。
          }
        }
      }
    })()
    return {
      done,
      async assertLease() {
        if (!lost && !stopped) {
          try { lost = !await lease.renew(taskId, owner, timeout) || lost }
          catch {
            lost = true
            try { diagnose?.() } catch { /* 诊断异常不改变失租结果。 */ }
          }
        }
        if (lost || stopped) throw new Error('定时任务执行租约已失效')
      },
      get lost() { return lost },
      stop() {
        stopped = true
        cancelDelay()
      },
    }
  }
}
