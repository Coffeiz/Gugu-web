import type { Pool } from 'pg'
import { recoverProjectDeleteJournalBatch } from '../undo/persistence/project-journal.js'
import { createLocalProjectUndoJournalStorage } from '../undo/persistence/project-journal-local.js'

/** 启动时恢复一批，之后继续扫描。关闭连接池前等待当前批次退出。 */
export function startProjectDeleteRecoveryWorker(options: {
  pool: Pick<Pool, 'connect'>
  storageRoot: string
  onError(): void
  intervalMs?: number
}): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 60_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('项目删除恢复间隔无效')
  const storage = createLocalProjectUndoJournalStorage(options.storageRoot)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const report = () => { try { options.onError() } catch { /* 诊断失败不阻断恢复。 */ } }
  const running = (async () => {
    let cursor: string | null = null
    while (!stopped) {
      try { cursor = await recoverProjectDeleteJournalBatch(options.pool, storage, cursor, report) }
      catch { report() }
      if (stopped) break
      await new Promise<void>(resolve => {
        wake = resolve
        timer = setTimeout(resolve, interval)
        timer.unref()
      })
    }
  })()
  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      wake?.()
      await running
    },
  }
}
