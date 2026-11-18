import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { createScheduledTaskExecution, createScheduledTaskGroupMemoryReader, createScheduledTaskGroupTools, createScheduledTaskRunNow,
  type RecurringStopExecution, type ScheduledTaskExecutionPorts } from '@gugu/core/scheduled-task-run-now'
import { createKyselyScheduledTaskExecutionReader, createKyselyScheduledTaskGroupScopeReader,
  createKyselyScheduledTaskRunNowReader, type ScheduledTaskExecutionPlan } from '@gugu/core/scheduled-task-run-now-read'
import { createKyselyOnceTaskRepository } from '@gugu/core/scheduled-task-once-repository'
import { ScheduledTaskRunner, type AssertScheduledTaskLease } from '@gugu/core/scheduled-task-runner'
import type { TaskFilesystemRevokeEffects } from '@gugu/core/scheduled-task-filesystem-revoke'
import { createScheduledTaskRedisLease, type ScheduledTaskRedisCommands } from './persistence/redis-lease.js'
import { createRepeatingTaskWorker } from './repeating-task-worker.js'
import { createScheduledTaskTimer } from './repeating-timer.js'
import { createLocalAgentMemoryRagStore } from '../../domains/agent-sessions/tools/agent-rag-memory-store.js'

/** 组合 Core owner/生命周期用例与实际 SQL、Redis lease、Agent/投递适配。 */
export function createScheduledTaskRunNowRuntime<DB, Artifact>(options: {
  readonly db: Kysely<DB>
  readonly backend: 'postgres' | 'sqlite'
  readonly redis: ScheduledTaskRedisCommands
  readonly execution: ScheduledTaskExecutionPorts<Artifact>
  readonly recurringStopEffects?: TaskFilesystemRevokeEffects
  readonly bindRecurringDelivery?: (task: ScheduledTaskExecutionPlan) => Promise<RecurringStopExecution<Artifact>['deliver']>
  readonly filesystemAuthorizationEnabled?: () => boolean
  readonly storageRoot?: string
  readonly notifyTasksChanged: (ownerId: string) => Promise<void>
  readonly unavailable?: (plan: ScheduledTaskExecutionPlan) => string | undefined
  readonly waitSeconds?: number
}) {
  const repository = createKyselyOnceTaskRepository(options.db, options.backend)
  const readExecution = createKyselyScheduledTaskExecutionReader(options.db, options.backend, options.filesystemAuthorizationEnabled)
  const readGroupScope = createKyselyScheduledTaskGroupScopeReader(options.db, options.backend)
  const memoryStorage = options.storageRoot ? createLocalAgentMemoryRagStore(options.storageRoot) : undefined
  const readGroupMemory = memoryStorage
    ? createScheduledTaskGroupMemoryReader(options.db, memoryStorage)
    : undefined
  const execute = createScheduledTaskExecution({
    ...options.execution,
    toolsForRun: createScheduledTaskGroupTools(options.db, options.backend, memoryStorage),
    ...(readGroupMemory ? { async loadGroupMemory(task) {
      if (!task.groupScope) return ''
      let memory = ''
      try { memory = await readGroupMemory(task.groupScope) }
      catch { console.warn('定时任务群记忆读取失败') }
      // 读取期间归属可能变化。确认该范围仍可用后才把文件内容传给模型。
      if (!await readGroupScope(task)) throw new Error('任务群聊目标不可用')
      return memory
    } } : {}),
  })
  const lease = createScheduledTaskRedisLease(options.redis)
  const runner = new ScheduledTaskRunner({
    repository, lease,
    createOwner: randomUUID,
    notifyTasksChanged: options.notifyTasksChanged,
    onLeaseRenewError() { /* 只记录固定错误，不记录任务内容或凭据。 */ },
  })
  async function prepare(ownerId: string, taskId: string, isTrial: boolean, disableRecurring?: RecurringStopExecution<Artifact>['disable']) {
    const result = await readExecution(ownerId, taskId)
    if ('error' in result) return result
    const groupScope = await readGroupScope(result.plan)
    if (groupScope === null) return { error: '任务群聊目标不可用，已跳过执行' }
    const plan = groupScope ? { ...result.plan, groupScope } : result.plan
    const unavailable = options.unavailable?.(plan)
    if (unavailable) return { error: unavailable }
    const stop = !isTrial && disableRecurring && options.bindRecurringDelivery
      ? {
          deliver: await options.bindRecurringDelivery(plan),
          disable: disableRecurring,
          notifyChanged: () => options.notifyTasksChanged(ownerId),
        }
      : undefined
    return { execute: (assertLease: AssertScheduledTaskLease) => execute(plan, isTrial, assertLease, stop) }
  }
  const active = new Set<Promise<unknown>>()
  const run = createScheduledTaskRunNow({
    readOwned: createKyselyScheduledTaskRunNowReader(options.db, options.backend),
    runner, prepare,
    waitSeconds: options.waitSeconds,
    trackOperation(operation) {
      active.add(operation)
      void operation.then(() => active.delete(operation), () => active.delete(operation))
    },
  })
  return Object.assign(run, {
    async drain() { await Promise.allSettled(active) },
    createRepeatingWorker() {
      return createRepeatingTaskWorker({ ...options, lease, prepare })
    },
    createOnceWorker() {
      return createScheduledTaskTimer({
        now: Date.now,
        setTimer: (callback, delay) => setTimeout(callback, delay),
        clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        onError() { console.error('一次性任务调度失败') },
        async list() {
          const now = Date.now()
          try {
            await runner.recoverAbandoned(now, true)
            await runner.collectExpiredOnce(repository, now)
          } catch { console.error('一次性任务状态维护失败') }
          return repository.listPendingOnce(Date.now())
        },
        async dispatch({ taskId, fireAt }) {
          let prepared: Awaited<ReturnType<typeof prepare>> | undefined
          await runner.runDue(taskId, assertLease => {
            if (!prepared || !('execute' in prepared)) throw new Error('定时任务尚未准备')
            return prepared.execute(assertLease)
          }, Date.now(), {
            expectedStartAt: fireAt,
            async beforeStart(task) {
              prepared = await prepare(task.userId, task.id, false)
              return 'execute' in prepared
            },
          })
        },
      })
    },
  })
}
