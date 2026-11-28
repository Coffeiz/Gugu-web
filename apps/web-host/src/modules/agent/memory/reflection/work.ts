import type { CompactionReflectionEdits } from '@gugu/core/agent/memory/owner-reflection-edits'
import type { createRedisAgentReflectionInbox } from './queue.js'
import type { createLocalOwnerReflectionWriter } from './write.js'

type Batch = NonNullable<Awaited<ReturnType<ReturnType<typeof createRedisAgentReflectionInbox>>>>
  & { compactionCandidate?: { output: CompactionReflectionEdits; evidence: string } }
type Writer = ReturnType<typeof createLocalOwnerReflectionWriter>
type Snapshot = Awaited<ReturnType<Writer['snapshot']>>

/** 恢复持久发布优先于模型调用，只有提交收据后才确认 Redis 批次。 */
export function createOwnerReflectionWork(options: {
  claim(): Promise<Batch | null>
  writer: Writer
  checkSource?(batch: Batch, signal: AbortSignal): Promise<{ kind: 'ready' | 'defer' | 'discard' | 'split' }>
  extract(batch: Batch, snapshot: Snapshot, signal: AbortSignal): Promise<
    { kind: 'ready'; output: unknown; time: { now: number; date: string } } | { kind: 'defer' | 'discard' | 'split' }
  >
  diagnose(): void
}) {
  return async (signal = new AbortController().signal): Promise<'idle' | 'ready' | 'retrying' | 'superseded'> => {
    signal.throwIfAborted()
    const batch = await options.claim()
    if (!batch) return 'idle'
    const retry = async (): Promise<'retrying' | 'superseded'> => await batch.retry(30_000) ? 'retrying' : 'superseded'
    const complete = async (): Promise<'ready' | 'superseded'> => await batch.complete() ? 'ready' : 'superseded'
    const split = async (): Promise<'ready' | 'superseded'> => await batch.split() ? 'ready' : 'superseded'
    try {
      signal.throwIfAborted()
      if (!await batch.isCurrent()) return 'superseded'
      const recovered = await options.writer.reconcile(batch, signal)
      if (recovered !== null) return complete()
      const source = await options.checkSource?.(batch, signal)
      if (source?.kind === 'discard') return complete()
      if (source?.kind === 'split') return split()
      if (source?.kind === 'defer') return retry()
      const snapshot = await options.writer.snapshot(batch, signal)
      const result = await options.extract(batch, snapshot, signal)
      signal.throwIfAborted()
      if (result.kind === 'discard') return complete()
      if (result.kind === 'split') return split()
      if (result.kind !== 'ready') return retry()
      if (!await batch.isCurrent()) return 'superseded'
      const written = await options.writer.publish(batch, snapshot.version, result.output, result.time, signal)
      return written === 'stale' ? retry() : complete()
    } catch {
      if (signal.aborted) {
        // 后台停止后保留队首和已写入的收据，尽快交给下一次启动。
        await batch.retry(0).catch(() => undefined)
        signal.throwIfAborted()
      }
      try { options.diagnose() } catch { /* 诊断失败不改变批次处理结果。 */ }
      return retry()
    }
  }
}
