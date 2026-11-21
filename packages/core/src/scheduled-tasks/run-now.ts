import type { AssertScheduledTaskLease, ScheduledTaskExecutionCallback, ScheduledTaskRunner } from './runner.js'
export { createScheduledTaskAgentAttempt, createScheduledTaskExecution,
  scheduledTaskSupportsFileDelivery, type RecurringStopExecution, type ScheduledTaskExecutionPorts } from './execute.js'
export { createScheduledTaskGroupMemoryReader } from './group-memory.js'
export { createScheduledTaskGroupTools, createScheduledTaskGroupScopeVerifier, createScheduledTaskGroupMemoryAuthorizer } from './group-tools.js'
export { createScheduledTaskHarness, scheduledTaskProviderSelection } from './agent-harness.js'
export { createScheduledTaskContextLoader } from './owner-context.js'
export { allowsScheduledMcpTool, createScheduledTaskRunToolPorts } from './agent-tools.js'
export { dispatchRepeatingFire, type ScheduledFire, type ScheduledFireReceipts } from './repeating-dispatch.js'
export { createKyselyScheduledFireReceipts } from './fire-receipts.js'
export { createKyselyRepeatingTaskRepository, type RepeatingTask } from './repeating-repository.js'

export interface ScheduledTaskRunNowRecord {
  scheduleKind: 'once' | 'cron' | 'interval'
  enabled: boolean
  endAt: number | null
  lastRunFailed: boolean
}

export class ScheduledTaskRunNowError extends Error {
  constructor(readonly code: 'not_found') {
    super('定时任务不存在')
    this.name = 'ScheduledTaskRunNowError'
  }
}

type RunExecution = { status: 'completed' | 'failed' | 'busy' | 'lease_lost' | 'not_found' | 'not_due' | 'already_run'; delivery?: Record<string, string> }
type PreparedExecution = { execute: ScheduledTaskExecutionCallback } | { error: string }

type CompletedRunResponse = { ok: true; result?: Record<string, string>; msg: string; pending?: undefined }
type RunNowResponse = CompletedRunResponse | { ok: false; msg: string; result?: undefined; pending?: undefined }
  | { ok: true; pending: true; msg: string; result?: undefined }

function response(delivery: Record<string, string> | undefined): CompletedRunResponse {
  if (!delivery || Object.keys(delivery).length === 0)
    return { ok: true, msg: '已执行（该任务未选任何投递渠道）' }
  return { ok: true, result: delivery, msg: `试运行结果：\n${Object.entries(delivery).map(([channel, status]) => `· ${channel}：${status}`).join('\n')}` }
}

export function createScheduledTaskRunNow(options: {
  readOwned(ownerId: string, taskId: string): Promise<ScheduledTaskRunNowRecord | null>
  runner: Pick<ScheduledTaskRunner, 'runDue' | 'runTrial'>
  prepare(ownerId: string, taskId: string, isTrial: boolean): Promise<PreparedExecution>
  now?: () => number
  waitSeconds?: number
  trackOperation?(operation: Promise<unknown>): void
}) {
  const now = options.now ?? Date.now
  const waitSeconds = options.waitSeconds ?? 180
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0)
    throw new RangeError('等待时限必须是正数秒')

  return async function run(ownerId: string, taskId: string): Promise<RunNowResponse> {
    const task = await options.readOwned(ownerId, taskId)
    if (!task) throw new ScheduledTaskRunNowError('not_found')
    if (task.scheduleKind !== 'once' && task.endAt !== null && task.endAt <= now())
      return { ok: false as const, msg: '任务已结束，不能立即运行' }

    const retryFailedOnce = task.scheduleKind === 'once' && task.lastRunFailed
    let delivery: Record<string, string> | undefined
    let prepared: PreparedExecution | undefined
    const prepare = async () => {
      prepared = await options.prepare(ownerId, taskId, !retryFailedOnce)
      if ('execute' in prepared) return true
      delivery = { 错误: prepared.error }
      return false
    }
    const execute = (assertLease: AssertScheduledTaskLease) => {
      if (!prepared || !('execute' in prepared)) throw new Error('定时任务尚未准备')
      return prepared.execute(assertLease)
    }
    const currentTime = now()
    const operation: Promise<RunExecution> = retryFailedOnce
      ? options.runner.runDue(taskId, async assertLease => {
        delivery = await execute(assertLease)
        return delivery
      }, currentTime, { allowFutureRetry: true, userId: ownerId, beforeStart: prepare }).then(status => ({ status, ...(delivery ? { delivery } : {}) }))
      : options.runner.runTrial(taskId, async assertLease => {
        // 与正式触发共用租约。等待拿锁期间停用或删除的任务不得进入执行器。
        const current = await options.readOwned(ownerId, taskId)
        if (!current?.enabled) return { 错误: '任务不存在或已停用' }
        if (current.scheduleKind !== 'once' && current.endAt !== null && current.endAt <= now())
          return { 错误: '任务已结束' }
        if (!await prepare()) return delivery!
        delivery = await execute(assertLease)
        return delivery
      }).then(result => ({ ...result }))

    // 先吸收后台拒绝，再 race 等待窗口；超时只结束 HTTP 等待，不取消执行任务。
    const settled = operation.then<RunExecution, RunExecution>(result => result, () => ({ status: 'failed' }))
    options.trackOperation?.(settled)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), waitSeconds * 1000)
    })
    const result = await Promise.race([settled, timeout])
    if (timer) clearTimeout(timer)
    if (result === null)
      return { ok: true as const, pending: true as const, msg: `试运行仍在执行，完成后会按任务渠道投递（已等待 ${waitSeconds} 秒）。` }
    if (result.status === 'busy') delivery = { 错误: '任务正在执行，请稍后再试' }
    else if (result.status === 'lease_lost') delivery = { 错误: '任务执行租约已失效，请稍后重试' }
    else if (result.status === 'not_found') delivery = { 错误: '任务不存在或已停用' }
    else if (result.status === 'not_due') delivery = { 错误: '一次性任务尚未到执行时间' }
    else if (result.status === 'already_run') delivery = { 错误: '一次性任务已经执行过或正在执行' }
    else if (result.status === 'failed' && !result.delivery && !delivery) delivery = { 错误: '任务执行失败' }
    else delivery = result.delivery ?? delivery
    return response(delivery)
  }
}
