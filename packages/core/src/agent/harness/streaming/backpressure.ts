
import type { DispatchOutcome,RunCheckpoint,RunEvent,RunIdentity,ToolCall,ToolResult } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import type { HarnessPorts,RunCoordination } from '../ports.js'
import { cancellable } from '../run/cancellation.js'
import { sameRunIdentity } from '../run/lifecycle.js'

/** 消费者退出时先中止网络，再回收迭代器，避免return等待未结束的next。 */
export function providerStreamLifetime(signal: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const detach = () => {
    controller.abort()
    signal.removeEventListener('abort', abort)
  }
  return {
    signal: controller.signal,
    abort: detach,
    close<T>(iterator: AsyncIterator<T>) {
      detach()
      return iterator.return?.()
    },
  }
}

export async function* parallelBatchForRun<C>(scope: RunCoordination<C>, calls: readonly ToolCall[], limit: number): AsyncGenerator<RunEvent, readonly DispatchOutcome<ToolResult>[]> {
  const queued: {
    event: RunEvent
    consumed: () => void
  }[] = []
  let wake: (() => void) | undefined
  let done = false
  let result: readonly DispatchOutcome<ToolResult>[] = []
  let failure: unknown
  let commits: Promise<unknown> = Promise.resolve()
  const batch = runParallelDispatches(calls, async (call, signal) => {
    let event: RunEvent | null = null
    // 并发开始通知仍串行CAS，避免兄弟工具竞争checkpoint版本。
    commits = commits.then(async () => { event = await scope.commit({}, 'tool_call', { toolCallId: call.id, name: call.name, status: 'running' }) })
    await commits
    // 清理可能已发生在兄弟的DB提交等待期间；不能再向已无人消费的队列入项。
    if (signal.aborted)
      throw new HarnessError('cancelled', '当前任务已取消')
    await new Promise<void>((resolve) => { queued.push({ event: event!, consumed: resolve }); wake?.() })
    if (signal.aborted)
      throw new HarnessError('cancelled', '当前任务已取消')
    return scope.executeTool(call, null, signal, true)
  }, { signal: scope.controller.signal, maxConcurrency: limit }).then((value) => { result = value; done = true; wake?.() }, (error: unknown) => { failure = error; done = true; wake?.() })
  try {
    while (!done || queued.length) {
      if (!queued.length) {
        await new Promise<void>((resolve) => {
          wake = resolve; if (done || queued.length)
            resolve()
        })
        wake = undefined
      }
      const next = queued.shift()
      if (next) {
        try {
          yield next.event
        }
        finally {
          next.consumed()
        }
      }
    }
    if (failure) {
      if (failure instanceof ParallelDispatchCancelled) {
        scope.controller.abort()
        return failure.results as readonly DispatchOutcome<ToolResult>[]
      }
      throw failure
    }
    return result
  }
  finally {
    if (!done)
      scope.controller.abort()
    queued.forEach((item) => item.consumed())
    await batch
  }
}

export class ParallelDispatchCancelled<T> extends HarnessError {
  constructor(readonly results: readonly DispatchOutcome<T>[]) {
    super('cancelled', '并行工具批次已取消')
  }
}

/**
 * 调度独立工具批次，始终按模型顺序返回；普通错误只隔离当前工具。
 * 共享取消终止兄弟任务并等待全部已启动任务回收，未启动项明确标 deferred。
 */
export async function runParallelDispatches<I, T>(calls: readonly I[], dispatch: (call: I, signal: AbortSignal) => Promise<T>, options: {
  readonly signal: AbortSignal
  readonly maxConcurrency?: number
}): Promise<readonly DispatchOutcome<T>[]> {
  const limit = options.maxConcurrency ?? 5
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new HarnessError('invalid_state', '工具并发上限无效')
  const controller = new AbortController()
  const results: DispatchOutcome<T>[] = calls.map(() => ({ status: 'deferred' }))
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted)
    controller.abort()
  try {
    for (let offset = 0;offset < calls.length;offset += limit) {
      if (controller.signal.aborted)
        throw new ParallelDispatchCancelled(results)
      const batch = calls.slice(offset, offset + limit)
      await Promise.all(batch.map(async (call, index) => {
        const position = offset + index
        if (controller.signal.aborted)
          return
        try {
          const value = await dispatch(call, controller.signal)
          results[position] = { status: 'completed', value }
        }
        catch (error) {
          if (controller.signal.aborted || (error instanceof HarnessError && error.code === 'cancelled')) {
            results[position] = { status: 'cancelled' }
            controller.abort()
          }
          else
            results[position] = { status: 'error', error }
        }
      }))
      if (controller.signal.aborted)
        throw new ParallelDispatchCancelled(results)
    }
    return results
  }
  finally {
    options.signal.removeEventListener('abort', abort)
  }
}

export async function publishRunEvent<C>(ports: HarnessPorts<C>, event: RunEvent, signal?: AbortSignal): Promise<void> {
  try {
    if (signal)
      await cancellable(ports.publish(event, signal), signal)
    else
      await ports.publish(event)
    await ports.store.acknowledgeEvents(event.identity, [event.id])
  }
  catch {
    // outbox 保留权威事件，发布失败不回滚已提交的历史或再次执行工具。
    ports.diagnose('publish_failed')
  }
}

export async function* replayRunEvents<C>(ports: HarnessPorts<C>, read: (identity: RunIdentity) => Promise<RunCheckpoint<C>>, identity: RunIdentity, options?: { readonly signal?: AbortSignal }): AsyncGenerator<RunEvent> {
  identity = Object.freeze({ ...identity })
  await read(identity)
  const events = await ports.store.pendingEvents(identity)
  let sequence = 0
  for (const event of events) {
    if (options?.signal?.aborted)
      return
    if (!sameRunIdentity(identity, event.identity) || event.sequence <= sequence) {
      throw new HarnessError('invalid_state', '运行事件顺序无效')
    }
    sequence = event.sequence
    await publishRunEvent(ports, event, options?.signal)
    if (options?.signal?.aborted)
      return
    yield event!
  }
}
