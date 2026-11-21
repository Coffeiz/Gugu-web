import type { CancellationPort } from '../ports.js'
import type { AgentRunner, InteractionResolution, RunEvent, RunIdentity } from '../models.js'
import { drainAgentRuns } from './shutdown.js'

export interface AgentDispatchRuntimeLease {
  identity: RunIdentity
  input: { userMessageId: number }
  replyChoice?: 'pending' | 'reply'
  mode: 'start' | 'resume'
  /** Host 仅可在持久收据完成 owner/单次消费校验后附加；Core Harness 再校验 interaction 绑定。 */
  resolution?: InteractionResolution
}

export class AgentDispatchDeferredError extends Error {}

export class AgentRunReconstructionVersionError extends Error {}

export interface AgentDispatchWorkerPorts<C, L extends AgentDispatchRuntimeLease> {
  dispatch: {
    acceptsInput(input: L['input']): boolean
    claim(owner: string, session: string): Promise<L | null>
    renew(lease: L): Promise<boolean>
    cancellationRequested(lease: L): Promise<boolean>
    finish(lease: L): Promise<boolean>
    settleExpired(owner: string, session: string): Promise<boolean>
    setReconstructionStatus(lease: L, reason: 'unavailable' | 'version_conflict' | null): Promise<boolean>
  }
  /** 缺少恢复器或运行版本不匹配时必须保留持久任务，不得构造空上下文。 */
  reconstruct(lease: L): Promise<{
    harness: Pick<AgentRunner<C>, 'start' | 'resume'>
    cancellation: Pick<CancellationPort, 'request' | 'notify'>
    consume?(events: AsyncIterable<RunEvent>): Promise<void>
    close(): Promise<void>
  } | null>
  /** 仅当没有 checkpoint 且租约仍有效时记录安全启动失败。 */
  failStart(lease: L): Promise<boolean>
  runExclusive?<T>(task: () => Promise<T>): Promise<T>
  renewIntervalMs?: number
}

/** Agent Run 调度执行编排；持久队列、租约和重建依赖由 Host 注入。 */
export function createAgentDispatchWorker<C, L extends AgentDispatchRuntimeLease>(ports: AgentDispatchWorkerPorts<C, L>) {
  const interval = ports.renewIntervalMs ?? 10000
  if (!Number.isSafeInteger(interval) || interval < 10) throw new RangeError('调度续期间隔无效')
  const running = new Map<string, { wake: boolean; task: Promise<void> }>()
  const tasks = new Set<Promise<unknown>>()
  const cancellations = new Set<() => Promise<void>>()
  let closing: Promise<void> | undefined
  let cancelPending = false
  let generation = 0
  async function execute(owner: string, session: string): Promise<'idle' | 'unavailable' | 'settled' | 'unsettled'> {
    if (closing) return 'idle'
    if (await ports.dispatch.settleExpired(owner, session)) return 'settled'
    const lease = await ports.dispatch.claim(owner, session)
    if (!lease) return 'idle'
    if (!ports.dispatch.acceptsInput(lease.input) || (lease.mode === 'start' && lease.resolution !== undefined)) {
      await ports.dispatch.setReconstructionStatus(lease, 'version_conflict')
      return 'unavailable'
    }
    let runtime
    try { runtime = await ports.reconstruct(lease) }
    catch (error) {
      if (error instanceof AgentDispatchDeferredError) {
        await ports.dispatch.setReconstructionStatus(lease, 'unavailable')
        return 'unavailable'
      }
      if (!(error instanceof AgentRunReconstructionVersionError)) throw error
      await ports.dispatch.setReconstructionStatus(lease, 'version_conflict')
      return 'unavailable'
    }
    if (!runtime) { await ports.dispatch.setReconstructionStatus(lease, 'unavailable'); return 'unavailable' }
    const cancellation = runtime.cancellation
    const cancel = async () => {
      await cancellation.request(lease.identity)
      await cancellation.notify(lease.identity)
    }
    cancellations.add(cancel)
    let stopped = false, renewing: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null
    let failed: { error: unknown } | null = null
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(() => {
        renewing = ports.dispatch.renew(lease).then(ok => { if (!ok) stopped = true }).catch(() => { stopped = true }).finally(() => { renewing = null; if (!stopped) schedule() })
      }, interval)
      timer.unref?.()
    }
    try {
      if (!await ports.dispatch.setReconstructionStatus(lease, null)) throw new Error('调度租约失效')
      if (cancelPending || await ports.dispatch.cancellationRequested(lease)) {
        await runtime.cancellation.request(lease.identity)
        try { await runtime.cancellation.notify(lease.identity) } catch { /* 持久标记仍有效。 */ }
      }
      schedule()
      try {
        const run = lease.mode === 'resume'
          ? runtime.harness.resume(lease.identity, lease.resolution)
          : runtime.harness.start(lease.identity, { anchorMessageId: String(lease.input.userMessageId), ...(lease.replyChoice ? { replyChoice: lease.replyChoice } : {}) })
        if (runtime.consume) await runtime.consume(run)
        else for await (const _event of run) { /* Core 在 yield 前提交状态和事件。 */ }
      } catch (error) { failed = { error } }
    } finally {
      cancellations.delete(cancel)
      stopped = true
      if (timer) clearTimeout(timer)
      if (renewing) await renewing
      await runtime.close()
    }
    if (failed?.error instanceof AgentDispatchDeferredError) {
      await ports.dispatch.setReconstructionStatus(lease, 'unavailable')
      return 'unavailable'
    }
    if (failed && !await ports.failStart(lease)) throw failed.error
    return await ports.dispatch.finish(lease) ? 'settled' : 'unsettled'
  }
  const worker = {
    runOnce(owner: string, session: string): Promise<'idle' | 'unavailable' | 'settled' | 'unsettled'> {
      if (closing) return Promise.resolve('idle')
      const admittedGeneration = generation
      const task = () => {
        if (admittedGeneration !== generation) return Promise.resolve('idle' as const)
        const work = execute(owner, session).finally(() => tasks.delete(work))
        tasks.add(work)
        return work
      }
      return ports.runExclusive ? ports.runExclusive(task) : task()
    },
    close(): Promise<void> {
      if (closing) return closing
      generation++
      closing = drainAgentRuns([...tasks], async () => {
        cancelPending = true
        await Promise.allSettled([...cancellations].map(cancel => cancel()))
      })
      return closing
    },
    reopen() {
      closing = undefined
      cancelPending = false
      running.clear()
    },
    /** 同进程合并唤醒；跨进程崩溃恢复由 Host supervisor 扫描。 */
    kick(owner: string, session: string): Promise<void> {
      if (closing) return Promise.resolve()
      const key = JSON.stringify([owner, session]), existing = running.get(key)
      if (existing) { existing.wake = true; return existing.task }
      const state = { wake: false, task: Promise.resolve() }
      const admittedGeneration = generation
      const task = (async () => {
        do {
          state.wake = false
          while (admittedGeneration === generation && await worker.runOnce(owner, session) === 'settled') { /* 按 FIFO 消费已结算后的下一运行。 */ }
        } while (state.wake && admittedGeneration === generation)
      })().finally(() => { if (running.get(key) === state) running.delete(key) })
      state.task = task
      running.set(key, state)
      return task
    },
  }
  return worker
}
