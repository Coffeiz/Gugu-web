import type { RunCheckpoint, RunEvent, RunIdentity, InteractionResolution } from '@gugu/core/agent'
import type { createPostgresInteractionResumeQueue } from './persistence/agent-interaction-resume-postgres.js'

type Queue = ReturnType<typeof createPostgresInteractionResumeQueue>
export interface InteractionWorkerPorts {
  queue: Pick<Queue, 'claim' | 'releaseClaim' | 'finishClaim' | 'isConsumed'>
  read(identity: RunIdentity): Promise<Pick<RunCheckpoint<unknown>, 'status'> | null>
  resume(identity: RunIdentity, resolution?: InteractionResolution): AsyncIterable<RunEvent>
  invalidateCredential(ownerId: string, serverId: string): Promise<void>
  diagnose(): void
}
const terminal = new Set(['completed', 'cancelled', 'failed', 'unknown'])
/** 一次认领只负责把收据交给既有 Harness；运行状态与幂等仍由 Core 管理。 */
export async function processOneInteraction(ports: InteractionWorkerPorts): Promise<boolean> {
  const item = await ports.queue.claim()
  if (!item) return false
  try {
    const state = await ports.read(item.identity)
    if (!state) throw new Error('恢复运行不存在')
    const consumed = await ports.queue.isConsumed(item.identity, item.resolution.receiptId)
    if (item.secretServerId) await ports.invalidateCredential(item.identity.ownerId, item.secretServerId)
    if (!terminal.has(state.status) && (!consumed || state.status !== 'waiting')) {
      for await (const event of ports.resume(item.identity, consumed ? undefined : item.resolution)) {
        if (event.identity.ownerId !== item.identity.ownerId || event.identity.sessionId !== item.identity.sessionId || event.identity.runId !== item.identity.runId) throw new Error('运行身份不匹配')
      }
    }
    const after = await ports.read(item.identity)
    if (after && (terminal.has(after.status) || after.status === 'waiting')) await ports.queue.finishClaim(item.identity, item.promptId, item.claimToken)
    return true
  } finally { await ports.queue.releaseClaim(item.identity, item.promptId, item.claimToken) }
}
/** Host 负责在启动后 start、关闭前 stop；停止轮询不取消已在执行的 run。 */
export function createInteractionRecoveryWorker(ports: InteractionWorkerPorts, intervalMs = 10000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('恢复轮询间隔无效')
  let controller: AbortController | null = null, task: Promise<void> | null = null
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
