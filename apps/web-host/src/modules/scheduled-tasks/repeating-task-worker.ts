import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { createKyselyRepeatingTaskRepository, createKyselyScheduledFireReceipts, dispatchRepeatingFire, type RepeatingTask } from '@gugu/core/scheduled-task-run-now'
import type { AssertScheduledTaskLease, ScheduledTaskExecutionCallback, ScheduledTaskLease } from '@gugu/core/scheduled-task-runner'
import type { TaskFilesystemRevokeEffects } from '@gugu/core/scheduled-task-filesystem-revoke'
import { createScheduledTaskTimer } from './repeating-timer.js'

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
