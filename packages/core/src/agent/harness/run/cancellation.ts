
import type { RunCheckpoint,RunIdentity,ToolCall,ToolResult } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import type { HarnessPorts,RunCoordination } from '../ports.js'
import { runIdentityKey,terminalRunStates } from './lifecycle.js'

/** 同一轮只绑定一次 AbortSignal；已完成的结果优先于同一时刻到达的取消。 */
export async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let settled: {
    readonly value: T
  } | {
    readonly error: unknown
  } | undefined
  const tracked = operation.then((value) => { settled = { value }; return settled }, (error: unknown) => { settled = { error }; return settled })
  let abort: (() => void) | undefined
  const cancellation = new Promise<null>((resolve) => {
    abort = () => resolve(null)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      resolve(null)
  })
  try {
    const result = await Promise.race([tracked, cancellation])
    // 同一 turn 内的完成与取消竞态，已经确定的工具回执不能被丢弃。
    const completed = result ?? settled
    if (completed) {
      if ('error' in completed)
        throw completed.error
      return completed.value
    }
    throw new HarnessError('cancelled', '当前任务已取消')
  }
  finally {
    if (abort)
      signal.removeEventListener('abort', abort)
  }
}

export async function checkCancellationForRun<C>(scope: RunCoordination<C>): Promise<void> {
  if (scope.controller.signal.aborted || await scope.ports.cancellation.isRequested(scope.identity)) {
    scope.controller.abort()
    throw new HarnessError('cancelled', '当前任务已取消')
  }
  if (!scope.lease)
    throw new HarnessError('lease_lost', '运行租约已失效')
  try {
    await scope.ports.leases.assert(scope.identity, scope.lease)
  }
  catch {
    throw new HarnessError('lease_lost', '运行租约已失效')
  }
}

export function stoppedResultForRun<C>(scope: RunCoordination<C>, call: ToolCall, status: 'cancelled' | 'deferred'): ToolResult {
  return { kind: 'completed', value: { status }, successful: false, mutated: false, executed: scope.dispatchedCalls.has(scope.dispatchKey(call)) }
}

export async function requestRunCancellation<C>(ports: HarnessPorts<C>, active: ReadonlyMap<string, AbortController>, read: (identity: RunIdentity) => Promise<RunCheckpoint<C>>, identity: RunIdentity) {
  identity = Object.freeze({ ...identity })
  let state
  try {
    state = await read(identity)
  }
  catch (error) {
    if (error instanceof HarnessError && error.code === 'not_found')
      return false
    throw error
  }
  if (terminalRunStates.has(state.status))
    return false
  try {
    await ports.cancellation.request(identity)
  }
  catch {
    throw new HarnessError('persistence_unknown', '取消请求提交结果未知，请重新查询运行状态')
  }
  // durable 标记先落地，再唤醒当前 owner run；通知失败仍保留取消事实。
  active.get(runIdentityKey(identity))?.abort()
  try {
    await ports.cancellation.notify(identity)
  }
  catch { /* 后续恢复读取 durable marker。 */ }
  return true
}
