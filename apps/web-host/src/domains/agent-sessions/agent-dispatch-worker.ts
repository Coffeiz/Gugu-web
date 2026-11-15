import type { CancellationPort, AgentRunner } from '@gugu/core/agent'
import type { AgentDispatchLease } from './persistence/agent-run-dispatch-postgres.js'
import { AgentReconstructionVersionError } from './agent-web-reconstructor.js'

export interface AgentDispatchWorkerPorts<C> {
  dispatch: {
    claim(owner: string, session: string): Promise<AgentDispatchLease | null>
    renew(lease: AgentDispatchLease): Promise<boolean>
    cancellationRequested(lease: AgentDispatchLease): Promise<boolean>
    finish(lease: AgentDispatchLease): Promise<boolean>
    settleExpired(owner: string, session: string): Promise<boolean>
    setReconstructionStatus(lease: AgentDispatchLease, reason: 'unavailable' | 'version_conflict' | null): Promise<boolean>
  }
  /** 恢复器缺失或版本不匹配必须返回 null，不能构造空上下文或回退 Python。 */
  reconstruct(lease: AgentDispatchLease): Promise<{ harness: Pick<AgentRunner<C>, 'start' | 'resume'>; cancellation: Pick<CancellationPort, 'request' | 'notify'>; close(): Promise<void> } | null>
  /** 仅在确认未创建 checkpoint 且无活跃租约时记录安全启动失败。 */
  failStart(lease: AgentDispatchLease): Promise<boolean>
  renewIntervalMs?: number
}

/** 调度只选择执行入口；恢复与未知工具结果仍由 Core Harness 决定。 */
export function createAgentDispatchWorker<C>(ports: AgentDispatchWorkerPorts<C>) {
  const interval = ports.renewIntervalMs ?? 10000
  if (!Number.isSafeInteger(interval) || interval < 10) throw new RangeError('调度续期间隔无效')
  const running = new Map<string, { wake: boolean; task: Promise<void> }>()
  const worker = {
    async runOnce(owner: string, session: string): Promise<'idle' | 'unavailable' | 'settled' | 'unsettled'> {
      if (await ports.dispatch.settleExpired(owner, session)) return 'settled'
      const lease = await ports.dispatch.claim(owner, session)
      if (!lease) return 'idle'
      if (lease.input.v !== 2 || lease.input.source !== 'web') {
        await ports.dispatch.setReconstructionStatus(lease, 'version_conflict')
        return 'unavailable'
      }
      let worker
      try { worker = await ports.reconstruct(lease) }
      catch (error) {
        if (!(error instanceof AgentReconstructionVersionError)) throw error
        await ports.dispatch.setReconstructionStatus(lease, 'version_conflict')
        return 'unavailable'
      }
      if (!worker) { await ports.dispatch.setReconstructionStatus(lease, 'unavailable'); return 'unavailable' }
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
        if (await ports.dispatch.cancellationRequested(lease)) {
          await worker.cancellation.request(lease.identity)
          try { await worker.cancellation.notify(lease.identity) } catch { /* 持久标记仍有效。 */ }
        }
        schedule()
        try {
          const run = lease.mode === 'resume' ? worker.harness.resume(lease.identity) : worker.harness.start(lease.identity, { anchorMessageId: String(lease.input.userMessageId) })
          for await (const _event of run) { /* Core 在 yield 前提交状态和事件。 */ }
        } catch (error) { failed = { error } }
      } finally {
        stopped = true
        if (timer) clearTimeout(timer)
        if (renewing) await renewing
        await worker.close()
      }
      if (failed && !await ports.failStart(lease)) throw failed.error
      return await ports.dispatch.finish(lease) ? 'settled' : 'unsettled'
    },
    /** 同进程合并唤醒；其他进程的崩溃恢复须由 Host 显式扫描并调用。 */
    kick(owner: string, session: string): Promise<void> {
      const key = JSON.stringify([owner, session]), existing = running.get(key)
      if (existing) { existing.wake = true; return existing.task }
      const state = { wake: false, task: Promise.resolve() }
      const task = (async () => {
        do {
          state.wake = false
          while (await worker.runOnce(owner, session) === 'settled') { /* 按 FIFO 消费已结算后的下一运行。 */ }
        } while (state.wake)
      })().finally(() => { if (running.get(key) === state) running.delete(key) })
      state.task = task
      running.set(key, state)
      return task
    },
  }
  return worker
}
