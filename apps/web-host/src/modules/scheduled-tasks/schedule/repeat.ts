import { nextCronFire } from './cron.js'
import { nextIntervalFire } from './interval.js'
import { type RepeatingTask, type ScheduledFire, createKyselyRepeatingTaskRepository, createKyselyScheduledFireReceipts, dispatchRepeatingFire } from '@gugu/core/scheduled-task-run-now'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { AssertScheduledTaskLease, ScheduledTaskExecutionCallback, ScheduledTaskLease } from '@gugu/core/scheduled-task-runner'
import type { TaskFilesystemRevokeEffects } from '@gugu/core/scheduled-task-filesystem-revoke'

type RepeatingSchedule = Omit<RepeatingTask, 'userId' | 'version'>

type TimerSchedule = RepeatingSchedule | { id: string; kind: 'once'; startAt: number }

const maxTimerDelay = 2 ** 31 - 1

/** 计算严格晚于指定时刻的触发；无匹配时等待下一次 reconcile。 */
export function nextRepeatingFire(task: RepeatingSchedule, after: number): number | null {
  const lower = Math.max(after + 1, task.startAt ?? -Infinity)
  if (task.kind === 'interval') return nextIntervalFire({ intervalMinutes: task.intervalMinutes ?? 0,
    startAt: task.startAt ?? task.createdAt, endAt: task.endAt, after: lower })
  return nextCronFire(task.cron, lower, task.endAt)
}

/** 定时器只负责触发。调用方持任务租约复核当前计划。 */
export function createScheduledTaskTimer<Task extends TimerSchedule>(options: {
  list(): Promise<readonly Task[]>
  dispatch(fire: ScheduledFire, task: Task): Promise<unknown>
  onError(error: unknown): void
  now(): number
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(handle: unknown): void
  reconcileMs?: number
}) {
  const interval = options.reconcileMs ?? 30_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('调度协调间隔无效')
  let stopped = true
  let generation = 0
  let current: Promise<void> = Promise.resolve()
  let reconcileHandle: unknown
  const jobs = new Map<string, { signature: string; handle: unknown }>()
  const inflight = new Set<Promise<unknown>>()
  const report = (error: unknown) => { try { options.onError(error) } catch { /* 诊断失败不影响其他任务 */ } }
  const schedule = (task: Task, after: number, epoch: number) => {
    const next = task.kind === 'once'
      ? (task.startAt >= after - 1000 ? task.startAt : null)
      : nextRepeatingFire(task, after)
    if (next === null) { jobs.delete(task.id); return }
    const signature = JSON.stringify(task)
    const job: { signature: string; handle: unknown } = { signature, handle: undefined }
    const arm = () => {
      job.handle = options.setTimer(() => {
        if (stopped || generation !== epoch || jobs.get(task.id) !== job) return
        const now = options.now()
        if (now < next) {
          try { arm() } catch (error) { jobs.delete(task.id); report(error) }
          return
        }
        jobs.delete(task.id)
        if (now - next <= 1000) {
          const work = Promise.resolve().then(() => options.dispatch({ taskId: task.id, fireAt: next }, task)).catch(report)
          inflight.add(work)
          void work.finally(() => inflight.delete(work))
        }
        if (task.kind !== 'once') {
          try { schedule(task, now, epoch) } catch (error) { report(error) }
        }
      }, Math.min(maxTimerDelay, Math.max(1, next - options.now())))
    }
    arm()
    jobs.set(task.id, job)
  }
  const reconcile = async (epoch: number) => {
    try {
      const tasks = await options.list()
      if (stopped || generation !== epoch) return
      const ids = new Set(tasks.map(task => task.id))
      for (const [id, job] of jobs) if (!ids.has(id)) { options.clearTimer(job.handle); jobs.delete(id) }
      for (const task of tasks) {
        const old = jobs.get(task.id)
        if (old?.signature === JSON.stringify(task)) continue
        if (old) options.clearTimer(old.handle)
        try { schedule(task, options.now(), epoch) } catch (error) { jobs.delete(task.id); report(error) }
      }
    } catch (error) { report(error) }
    if (!stopped && generation === epoch) {
      const handle = options.setTimer(() => {
        if (!stopped && generation === epoch && reconcileHandle === handle) {
          reconcileHandle = undefined
          current = reconcile(epoch)
        }
      }, Math.min(maxTimerDelay, interval))
      reconcileHandle = handle
    }
  }
  return {
    start() { if (stopped) { stopped = false; current = reconcile(++generation) } },
    /** 提交后立即重新读取，避免新任务在下次周期扫描前到期。 */
    refresh() {
      if (stopped) return Promise.resolve()
      const epoch = generation
      if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
      reconcileHandle = undefined
      current = current.then(async () => {
        if (stopped || generation !== epoch) return
        if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
        reconcileHandle = undefined
        await reconcile(epoch)
      })
      return current
    },
    async stop() {
      stopped = true
      generation++
      const reconciling = current
      if (reconcileHandle !== undefined) options.clearTimer(reconcileHandle)
      reconcileHandle = undefined
      for (const job of jobs.values()) options.clearTimer(job.handle)
      jobs.clear()
      await Promise.allSettled([reconciling, ...inflight])
    },
  }
}

export const createRepeatingTimer = createScheduledTaskTimer

const leaseMs = 600_000

export function createRepeatingTaskWorker<DB>(options: {
  db: Kysely<DB>
  backend: 'postgres' | 'sqlite'
  lease: ScheduledTaskLease
  prepare(ownerId: string, taskId: string, isTrial: false,
    disableRecurring?: (assertLease?: AssertScheduledTaskLease) => Promise<boolean>): Promise<{ execute: ScheduledTaskExecutionCallback } | { error: string }>
  recurringStopEffects?: TaskFilesystemRevokeEffects
  notifyTasksChanged(ownerId: string): Promise<void>
}) {
  const { db, backend, lease } = options
  const tasks = createKyselyRepeatingTaskRepository(db, backend)
  const receipts = createKyselyScheduledFireReceipts(db, backend)

  async function collectEnded(now: number) {
    const changed = new Set<string>()
    try {
      for (const task of await tasks.listEnded(now)) {
        const token = randomUUID()
        if (!await lease.acquire(task.id, token, leaseMs)) continue
        try {
          if (await tasks.deleteEnded(task, now)) changed.add(task.userId)
        } finally { await lease.release(task.id, token) }
      }
    } finally {
      for (const ownerId of changed) {
        try { await options.notifyTasksChanged(ownerId) }
        catch { /* 删除已提交，实时通知失败不会恢复任务。 */ }
      }
    }
  }

  const timer = createScheduledTaskTimer<RepeatingTask>({
    now: Date.now,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onError() { console.error('周期任务调度失败') },
    async list() {
      const now = Date.now()
      try { await collectEnded(now) }
      catch { console.error('周期任务到期维护失败') }
      return tasks.list(Date.now())
    },
    async dispatch(fire, task) {
      let execute: ScheduledTaskExecutionCallback | undefined
      await dispatchRepeatingFire({
        fire, owner: randomUUID(), lease, receipts, leaseMs,
        async isCurrent() {
          if (!await tasks.isCurrent(task, Date.now())) return false
          const effects = options.recurringStopEffects
          const disable = task.eventId === null && effects
            ? (assertLease?: AssertScheduledTaskLease) => tasks.stopAfterRun(task, effects, assertLease)
            : undefined
          const plan = await options.prepare(task.userId, task.id, false, disable)
          if ('error' in plan) return false
          execute = plan.execute
          return true
        },
        async execute(assertLease) {
          if (!execute || !await tasks.markStarted(task, Date.now())) throw new Error('周期任务计划已变更')
          await execute(assertLease)
        },
      })
    },
  })
  return {
    async start() {
      try { await receipts.verifySchema() }
      catch { throw new Error('周期任务触发收据表不可用') }
      timer.start()
    },
    refresh: timer.refresh,
    stop: timer.stop,
  }
}
