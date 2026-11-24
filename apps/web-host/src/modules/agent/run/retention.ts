import type { Pool } from 'pg'
import { createPostgresSubagentRetention } from '@gugu/core/agent-sessions'

/** Agent Run 事件与检查点的默认保留期；事件是恢复与审计日志，除当前活跃运行外没有读取路径。 */
export const AGENT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 清理超过保留期的终态运行检查点；事件与交互收据随检查点外键级联删除。
 * 活跃运行、仍绑定在会话上的运行和租约未过期的运行一律跳过。
 * PostgreSQL 侧的 agent_run_events/agent_run_checkpoints 已有 created_at/updated_at，不需要改表结构。
 */
export async function cleanupExpiredAgentRuns(
  pool: Pick<Pool, 'query'>,
  now: Date,
  retentionMs = AGENT_RUN_RETENTION_MS,
): Promise<number> {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new RangeError('Agent run 保留期时间配置无效')
  const cutoff = new Date(now.getTime() - retentionMs)
  const result = await pool.query(
    `WITH expired AS (
       SELECT c.user_id, c.session_id, c.run_id
       FROM agent_run_checkpoints c
       WHERE c.status IN ('completed','cancelled','failed','unknown')
         AND c.updated_at < $1
         AND NOT EXISTS (SELECT 1 FROM agent_run_leases l
           WHERE l.user_id=c.user_id AND l.session_id=c.session_id AND l.run_id=c.run_id AND l.expires_at > $2)
         AND NOT EXISTS (SELECT 1 FROM conversation_sessions s
           WHERE s.id=c.session_id AND s.user_id=c.user_id AND s.active_run_id=c.run_id)
     )
     DELETE FROM agent_run_checkpoints c USING expired e
     WHERE c.user_id=e.user_id AND c.session_id=e.session_id AND c.run_id=e.run_id`,
    [cutoff, now],
  )
  return result.rowCount ?? 0
}

/** 首轮及后续均等待间隔；停止时等待在途清理结束。 */
export function startAgentRunRetentionWorker(options: {
  pool: Pool
  intervalMs?: number
  retentionMs?: number
  now?: () => Date
  onError(): void
}): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 3_600_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('清理间隔无效')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const wait = () => new Promise<void>(resolve => {
    wake = resolve
    timer = setTimeout(resolve, interval)
    timer.unref()
  })
  const cleanupSubagents = createPostgresSubagentRetention(options.pool)
  const running = (async () => {
    while (!stopped) {
      await wait()
      if (stopped) break
      try {
        await cleanupSubagents()
        await cleanupExpiredAgentRuns(options.pool, options.now?.() ?? new Date(), options.retentionMs)
      } catch {
        try { options.onError() } catch { /* 诊断失败不能终止后续清理 */ }
      }
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
