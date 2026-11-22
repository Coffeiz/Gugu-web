import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'

/** Agent Run 事件与检查点的默认保留期。事件是恢复与审计日志，除当前活跃运行外没有读取路径。 */
export const DEFAULT_AGENT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 清理后至少回收这么多字节才值得重写整库；小改动不值得付出一次全库重写。 */
export const DEFAULT_AGENT_RUN_COMPACT_MIN_BYTES = 32 * 1024 * 1024

export interface SqliteAgentRunRetentionResult {
  /** 被清理的运行数。 */
  runs: number
  /** 被清理的事件数。 */
  events: number
  /** 被清理的检查点数。 */
  checkpoints: number
  /** 被删除的载荷字节数。 */
  freedBytes: number
}

export interface SqliteAgentRunRetentionOptions {
  /** 当前时间（epoch 毫秒）。 */
  now?: number
  /** 保留期长度（毫秒）。 */
  retentionMs?: number
}

/**
 * 只有终态运行可以清理：活跃运行、仍绑定在会话上的运行和租约未过期的运行都要跳过。
 * 终态运行的检查点对恢复已无意义，事件表外键也会随检查点一并删除。
 */
async function collectExpiredRuns(tx: Kysely<Database> | import('kysely').Transaction<Database>, now: number, cutoff: number) {
  return (await sql<{ user_id: string; session_id: number; run_id: string; event_bytes: number; checkpoint_bytes: number }>`
    SELECT c.user_id, c.session_id, c.run_id,
      (SELECT COALESCE(SUM(LENGTH(e.payload)), 0) FROM agent_run_events e
        WHERE e.user_id=c.user_id AND e.session_id=c.session_id AND e.run_id=c.run_id) AS event_bytes,
      LENGTH(c.payload) AS checkpoint_bytes
    FROM agent_run_checkpoints c
    WHERE c.status IN ('completed','cancelled','failed','unknown')
      AND c.updated_at_ms > 0 AND c.updated_at_ms < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM agent_run_leases l
        WHERE l.user_id=c.user_id AND l.session_id=c.session_id AND l.run_id=c.run_id AND l.expires_at_ms > ${now})
      AND NOT EXISTS (SELECT 1 FROM conversation_sessions s
        WHERE s.id=c.session_id AND s.user_id=c.user_id AND s.active_run_id=c.run_id)
  `.execute(tx)).rows
}

/**
 * 清理超过保留期的终态运行事件与检查点。
 * 磁盘不会因为删除行而自动收缩，收缩由 `compactSqliteAgentRunStorage` 负责。
 */
export async function cleanupSqliteAgentRunRetention(
  db: Kysely<Database>,
  options: SqliteAgentRunRetentionOptions = {},
): Promise<SqliteAgentRunRetentionResult> {
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? DEFAULT_AGENT_RUN_RETENTION_MS
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    throw new RangeError('Agent run 保留期时间配置无效')
  const cutoff = now - retentionMs
  return db.transaction().execute(async tx => {
    const candidates = await collectExpiredRuns(tx, now, cutoff)
    if (!candidates.length) return { runs: 0, events: 0, checkpoints: 0, freedBytes: 0 }
    let events = 0
    let freedBytes = 0
    for (const candidate of candidates) {
      const deleted = await sql`DELETE FROM agent_run_events
        WHERE user_id=${candidate.user_id} AND session_id=${candidate.session_id} AND run_id=${candidate.run_id}`.execute(tx)
      events += Number(deleted.numAffectedRows ?? deleted.numChangedRows ?? 0)
      freedBytes += Number(candidate.event_bytes ?? 0) + Number(candidate.checkpoint_bytes ?? 0)
      await sql`DELETE FROM agent_run_checkpoints
        WHERE user_id=${candidate.user_id} AND session_id=${candidate.session_id} AND run_id=${candidate.run_id}`.execute(tx)
    }
    return { runs: candidates.length, events, checkpoints: candidates.length, freedBytes }
  })
}

/** 读取空闲页数量，用于判断重写整库是否值得。 */
export async function readSqliteFreeBytes(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(db)
  const free = Number(rows[0]?.freelist_count ?? 0)
  const { rows: sizes } = await sql<{ page_size: number }>`PRAGMA page_size`.execute(db)
  const pageSize = Number(sizes[0]?.page_size ?? 0)
  if (!Number.isSafeInteger(free) || !Number.isSafeInteger(pageSize) || free < 0 || pageSize <= 0) return 0
  return free * pageSize
}

/**
 * 回收删除行留下的空闲页。VACUUM 不能在事务里执行，也不能和别的写入并发。
 * 失败只影响磁盘占用，不影响运行正确性，因此调用方可以吞掉异常。
 */
export async function compactSqliteAgentRunStorage(db: Kysely<Database>, minBytes = DEFAULT_AGENT_RUN_COMPACT_MIN_BYTES): Promise<boolean> {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new RangeError('Agent run 压缩阈值无效')
  if (await readSqliteFreeBytes(db) < minBytes) return false
  await sql.raw('VACUUM').execute(db)
  return true
}
