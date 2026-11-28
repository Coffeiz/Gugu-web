import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { createSqlRagRebuildWorker, enqueueMissingAgentRagBaselines, enqueueAgentRagRebuildInTransaction } from '#core-source/agent/rag/index.js'

export type MemoryRebuild = { revision: string | number; generation: number }

export function startDesktopRagWorker(
  db: SqlDataRuntime['db'], ownerId: string,
  sources: Parameters<typeof createSqlRagRebuildWorker>[2],
  currentEmbeddingGeneration: () => number,
) {
  const rebuildRag = createSqlRagRebuildWorker(db, 'sqlite', sources)
  let ragWorkerStopped = false
  let ragBaselineEnqueued = false
  let lastMemoryRevision: string | number | undefined
  let pendingMemoryRebuild: MemoryRebuild | undefined
  let ragWorkerTimer: ReturnType<typeof setTimeout> | undefined
  let ragWorkerResolveWait: (() => void) | undefined

  async function runRagWorker(signal: AbortSignal): Promise<void> {
    while (!ragWorkerStopped && !signal.aborted) {
      try {
        if (!ragBaselineEnqueued) {
          await enqueueMissingAgentRagBaselines(db, 'sqlite', Object.keys(sources))
          ragBaselineEnqueued = true
        }
        const pending = pendingMemoryRebuild
        if (pending) {
          await db.transaction().execute(async tx => {
            if (pending.generation === currentEmbeddingGeneration())
              await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'memory')
          })
          if (pending.generation === currentEmbeddingGeneration()) lastMemoryRevision = pending.revision
          if (pendingMemoryRebuild === pending) pendingMemoryRebuild = undefined
        }
        const result = await rebuildRag(signal)
        if (result === 'ready' || result === 'superseded') continue
      } catch {
        if (signal.aborted) break
      }
      if (ragWorkerStopped || signal.aborted) break
      await new Promise<void>(resolve => {
        const finishWait = () => {
          ragWorkerResolveWait = undefined
          resolve()
        }
        ragWorkerResolveWait = finishWait
        ragWorkerTimer = setTimeout(finishWait, 1_000)
        ragWorkerTimer.unref?.()
      })
      ragWorkerTimer = undefined
    }
  }

  const ragWorkerAbort = new AbortController()
  const ragWorkerTask = runRagWorker(ragWorkerAbort.signal)

  return {
    get lastMemoryRevision() { return lastMemoryRevision },
    enqueueMemoryRebuild(rebuild: MemoryRebuild) { pendingMemoryRebuild = rebuild },
    async close() {
      ragWorkerStopped = true
      ragWorkerAbort.abort(new Error('桌面 RAG Worker 已停止'))
      if (ragWorkerTimer) clearTimeout(ragWorkerTimer)
      ragWorkerResolveWait?.()
      await ragWorkerTask
    },
  }
}
