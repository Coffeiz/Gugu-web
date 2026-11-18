import type { InteractionResolution, RunEvent, RunIdentity } from '../models.js'

export interface InteractionResumeItem {
  identity: RunIdentity
  promptId: number
  claimToken: string
  secretServerId: string | null
  resolution: InteractionResolution
}

/** 持久队列与凭据失效由 Host 提供；Core 维护恢复顺序和 Run 身份约束。 */
export interface InteractionRecoveryPorts {
  queue: {
    claim(): Promise<InteractionResumeItem | null>
    releaseClaim(identity: RunIdentity, promptId: number, token: string): Promise<void>
    finishClaim(identity: RunIdentity, promptId: number, token: string): Promise<boolean>
    isConsumed(identity: RunIdentity, receiptId: string): Promise<boolean>
  }
  read(identity: RunIdentity): Promise<{ status: string } | null>
  resume(identity: RunIdentity, resolution?: InteractionResolution): AsyncIterable<RunEvent>
  invalidateCredential(ownerId: string, serverId: string): Promise<void>
  diagnose(): void
}

const terminal = new Set(['completed', 'cancelled', 'failed', 'unknown'])

/** 一次认领只把可信收据交给既有 Harness；幂等和运行状态由 Core Harness 管理。 */
export async function processOneInteraction(ports: InteractionRecoveryPorts): Promise<boolean> {
  const item = await ports.queue.claim()
  if (!item) return false
  try {
    const state = await ports.read(item.identity)
    if (!state) throw new Error('恢复运行不存在')
    const consumed = await ports.queue.isConsumed(item.identity, item.resolution.receiptId)
    if (item.secretServerId) await ports.invalidateCredential(item.identity.ownerId, item.secretServerId)
    if (!terminal.has(state.status) && (!consumed || state.status !== 'waiting')) {
      for await (const event of ports.resume(item.identity, consumed ? undefined : item.resolution)) {
        if (event.identity.ownerId !== item.identity.ownerId || event.identity.sessionId !== item.identity.sessionId || event.identity.runId !== item.identity.runId)
          throw new Error('运行身份不匹配')
      }
    }
    const after = await ports.read(item.identity)
    if (after && (terminal.has(after.status) || after.status === 'waiting'))
      await ports.queue.finishClaim(item.identity, item.promptId, item.claimToken)
    return true
  } finally {
    await ports.queue.releaseClaim(item.identity, item.promptId, item.claimToken)
  }
}

/** Host 负责进程启停；停止轮询不会取消已经交给 Harness 的 Run。 */
export function createInteractionRecoveryWorker(ports: InteractionRecoveryPorts, intervalMs = 10000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('恢复轮询间隔无效')
  let controller: AbortController | null = null
  let task: Promise<void> | null = null
  return {
    start() {
      if (task) return
      controller = new AbortController()
      const signal = controller.signal
      task = (async () => {
        while (!signal.aborted) {
          try { await processOneInteraction(ports) } catch { ports.diagnose() }
          if (!signal.aborted) await new Promise<void>(resolve => {
            const timer = setTimeout(done, intervalMs)
            function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
            signal.addEventListener('abort', done, { once: true })
            if (signal.aborted) done()
          })
        }
      })().finally(() => { task = null; controller = null })
    },
    async stop() { controller?.abort(); await task },
  }
}
