import { enqueueAgentRagRebuild, readAgentRagRebuildProgress } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'

const pollIntervalMs = 1000
const timeoutMs = 15 * 60_000

function delay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, pollIntervalMs)
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('RAG 重建已取消')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 把向量重建与现有 Memory 持久索引 Worker 串接，并等待目标 generation 完成。 */
export function createPersistentMemoryIndexRebuilder(core: Pick<SqlDataRuntime, 'db' | 'backend'>, options: {
  now(): number
  timeoutMs?: number
  wait(signal: AbortSignal): Promise<void>
}) {
  return async (ownerId: string, signal: AbortSignal): Promise<void> => {
    await enqueueAgentRagRebuild(core.db, core.backend, ownerId, 'memory')
    const deadline = options.now() + (options.timeoutMs ?? timeoutMs)
    while (true) {
      signal.throwIfAborted()
      const progress = await readAgentRagRebuildProgress(core.db, core.backend, ownerId, 'memory')
      if (!progress) throw new Error('Memory RAG 重建任务未持久化')
      if (progress.completedGeneration >= progress.generation && progress.status === 'ready') return
      if (options.now() >= deadline) throw new Error('Memory RAG 重建等待超时')
      await options.wait(signal)
    }
  }
}

export const waitForMemoryIndexRebuild = delay
