import type { Pool } from 'pg'
import { purgeExpiredProject, recoverProjectExpiryJournal } from './persistence/project-expiry-postgres.js'

export interface ProjectExpiryWorkerOptions {
  enabled: boolean
  pool: Pool
  storageRoot: string
  defaultLimitBytes: number | null
  intervalMs?: number
  retentionMs?: number
  recoveryRetryMs?: number
  onError(error: unknown): void
}

/** 显式启用；停止时等待当前批次完成。部署时确保 Python 清理循环已停用。 */
export function startProjectExpiryWorker(options: ProjectExpiryWorkerOptions): { stop(): Promise<void> } {
  if (!options.enabled) return { async stop() {} }
  const interval = options.intervalMs ?? 3_600_000
  const retention = options.retentionMs ?? 30 * 86_400_000
  const recoveryRetry = options.recoveryRetryMs ?? 1000
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(retention) || retention < 1 || !Number.isSafeInteger(recoveryRetry) || recoveryRetry < 1)
    throw new RangeError('清理间隔和保留时间必须是正整数毫秒')
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveWait: (() => void) | undefined
  const wait = (delay: number) => new Promise<void>(resolve => {
    resolveWait = resolve
    timer = setTimeout(resolve, delay)
    timer.unref()
  })
  const recover = async () => {
    while (!stopping) {
      const result = await recoverProjectExpiryJournal(options.pool, options.storageRoot)
      if (result === false) return
      if (result === 'busy') await wait(recoveryRetry)
    }
  }
  const task = (async () => {
    try { await recover() } catch (error) { options.onError(error) }
    while (!stopping) {
      await wait(interval)
      if (stopping) break
      try {
        await recover()
        const cutoff = new Date(Date.now() - retention)
        while (!stopping && await purgeExpiredProject(options.pool, options.storageRoot, cutoff, options.defaultLimitBytes)) { /* 逐项清理 */ }
      } catch (error) { options.onError(error) }
    }
  })()
  return { async stop() { stopping = true; if (timer) clearTimeout(timer); resolveWait?.(); await task } }
}
