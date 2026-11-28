import { createScheduledTaskRunNow } from '@gugu/scheduler/tasks'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { configureRagJieba } from '@gugu/core/agent/rag'
import { createScheduledTaskExecution, createScheduledTaskGroupMemoryReader, createScheduledTaskGroupMemoryAuthorizer, createScheduledTaskGroupTools,
  type RecurringStopExecution, type ScheduledTaskExecutionPorts } from '@gugu/core/agent/scenes/task'
import { createKyselyScheduledTaskExecutionReader, createKyselyScheduledTaskGroupScopeReader,
  createKyselyScheduledTaskRunNowReader, type ScheduledTaskExecutionPlan } from '@gugu/core/tasks/execution-read'
import { createKyselyOnceTaskRepository } from '@gugu/core/tasks/schedule-storage'
import { createScheduledTaskTimer, ScheduledTaskRunner, type AssertScheduledTaskLease } from '@gugu/scheduler'
import type { TaskFilesystemRevokeEffects } from '@gugu/core/workspaces/task-filesystem-revoke'
import { createScheduledTaskRedisLease, type ScheduledTaskRedisCommands } from './lease.js'
import { createRepeatingTaskWorker } from '../schedule/repeat.js'
import { createLocalAgentMemoryRagStore } from '../../agent/rag/memory.js'
import { getAgentRagJieba } from '../../agent/rag/jieba.js'

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
  const authorizeGroupMemory = createScheduledTaskGroupMemoryAuthorizer(options.db, options.backend)
  const memoryStorage = options.storageRoot ? createLocalAgentMemoryRagStore(options.storageRoot) : undefined
  if (memoryStorage) configureRagJieba(getAgentRagJieba())
  const readGroupMemory = memoryStorage
    ? createScheduledTaskGroupMemoryReader(options.db, memoryStorage)
    : undefined
  const execute = createScheduledTaskExecution({
    ...options.execution,
    toolsForRun: createScheduledTaskGroupTools(options.db, options.backend, memoryStorage),
    ...(readGroupMemory ? { async loadGroupMemory(task) {
      const scope = await authorizeGroupMemory(task)
      if (!scope) return ''
      const memory = await readGroupMemory(scope)
      return await authorizeGroupMemory(task) ? memory : ''
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
