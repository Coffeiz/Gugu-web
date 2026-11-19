export type TrashPurgeEntry = { kind: 'file' | 'folder'; id: number }
export type TrashPurgeJobLease = {
  id: number
  userId: string
  snapshotAt: Date
  progressCurrent: number
  progressTotal: number
  failedCount: number
  status?: 'running' | 'completed' | 'failed'
  errorCode?: string | null
}

export interface TrashPurgeWorkerPorts {
  renew(jobId: number, workerId: string): Promise<boolean>
  nextBatch(job: TrashPurgeJobLease): Promise<readonly TrashPurgeEntry[]>
  deleteEntry(job: TrashPurgeJobLease, entry: TrashPurgeEntry): Promise<void>
  advance(jobId: number, workerId: string): Promise<boolean>
  finish(
    jobId: number,
    workerId: string,
    status: 'completed' | 'failed',
    errorCode: string | null,
    progressCurrent: number,
  ): Promise<boolean>
  publishProgress(job: TrashPurgeJobLease): Promise<void>
  publishFilesChanged(ownerId: string): Promise<void>
}

export interface TrashPurgeWorkerOptions {
  leaseRenewMs?: number
  onError?(error: unknown): void
}

type TrashPurgeOutcome = 'completed' | 'failed' | 'lease_lost'

/** 执行一个已领取的 owner 回收站任务；文件与租约事务由 Host 持久化端口实现。 */
export async function runTrashPurgeJob(
  claimed: TrashPurgeJobLease,
  workerId: string,
  ports: TrashPurgeWorkerPorts,
  options: TrashPurgeWorkerOptions = {},
): Promise<TrashPurgeOutcome> {
  const intervalMs = options.leaseRenewMs ?? 40_000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('回收站租约续期时间无效')
  let stopped = false
  let leaseLost = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveRenewalTick: (() => void) | undefined
  const renewLease = async () => {
    while (!stopped && !leaseLost) {
      await new Promise<void>(resolve => {
        resolveRenewalTick = resolve
        timer = setTimeout(() => { timer = undefined; resolveRenewalTick = undefined; resolve() }, intervalMs)
      })
      if (stopped) return
      try {
        if (!await ports.renew(claimed.id, workerId)) { leaseLost = true; return }
      } catch (error) { options.onError?.(error) }
    }
  }
  const renewal = renewLease()
  let progressCurrent = claimed.progressCurrent
  let outcome: TrashPurgeOutcome = 'lease_lost'
  const report = async (status: 'running' | 'completed' | 'failed', errorCode: string | null = null) => {
    try {
      await ports.publishProgress({
        ...claimed, progressCurrent, status,
        failedCount: claimed.failedCount + (status === 'failed' ? 1 : 0), errorCode,
      })
    } catch (error) { options.onError?.(error) }
  }
  try {
    while (!leaseLost) {
      const entries = await ports.nextBatch(claimed)
      if (leaseLost) break
      if (entries.length === 0) {
        if (!await ports.finish(claimed.id, workerId, 'completed', null, claimed.progressTotal)) break
        progressCurrent = claimed.progressTotal
        await report('completed')
        try { await ports.publishFilesChanged(claimed.userId) } catch (error) { options.onError?.(error) }
        outcome = 'completed'
        break
      }
      for (const entry of entries) {
        if (leaseLost) break
        await ports.deleteEntry(claimed, entry)
        if (leaseLost || !await ports.advance(claimed.id, workerId)) { leaseLost = true; break }
        progressCurrent += 1
        await report('running')
      }
    }
  } catch (error) {
    options.onError?.(error)
    if (!leaseLost && await ports.finish(claimed.id, workerId, 'failed', 'purge_failed', progressCurrent)) {
      await report('failed', 'purge_failed')
      outcome = 'failed'
    }
  } finally {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    resolveRenewalTick?.()
    await renewal
  }
  return outcome
}
