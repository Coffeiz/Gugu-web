import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { cleanupSubagentConversations } from '#core-source/agent/subagent/retention.js'
import { cleanupSqliteAgentRunRetention, compactSqliteAgentRunStorage } from '#core-source/agent/run/sqlite-retention.js'

/** Agent Run 保留期维护：启动后先跑一次，之后每 6 小时再回收一次。 */
const AGENT_RUN_RETENTION_FIRST_DELAY_MS = 30_000
const AGENT_RUN_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

export function startDesktopAgentRetention(db: SqlDataRuntime['db']) {
  // Agent Run 的事件与检查点从建表起没有任何删除路径，桌面端按保留期回收并压缩磁盘。
  const retentionAbort = new AbortController()
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  async function runRetentionMaintenance(): Promise<void> {
    if (retentionAbort.signal.aborted) return
    try {
      const removedSubagents = await cleanupSubagentConversations(db, 'sqlite')
      const cleaned = await cleanupSqliteAgentRunRetention(db)
      if (removedSubagents || cleaned.freedBytes > 0) await compactSqliteAgentRunStorage(db)
    } catch {
      /* 保留期清理失败只影响磁盘占用，不能影响运行正确性。 */
    }
  }
  function scheduleRetentionMaintenance(delay: number): void {
    if (retentionAbort.signal.aborted) return
    if (retentionTimer) clearTimeout(retentionTimer)
    retentionTimer = setTimeout(() => {
      retentionTimer = undefined
      void runRetentionMaintenance().finally(() => scheduleRetentionMaintenance(AGENT_RUN_RETENTION_INTERVAL_MS))
    }, delay)
    retentionTimer.unref?.()
  }
  scheduleRetentionMaintenance(AGENT_RUN_RETENTION_FIRST_DELAY_MS)

  return () => {
    retentionAbort.abort()
    if (retentionTimer) clearTimeout(retentionTimer)
  }
}
