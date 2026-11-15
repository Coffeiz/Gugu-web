import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, integer, nowUtc, utc, type Clock } from '../../data/codec.js'

export interface SessionRefreshResult {
  id: number
  contextEpoch: number
  snapshotHash: string | null
  sessionInfoHash: string | null
  expiresAt: string
}
export interface SessionRefreshRepository {
  refresh(ownerId: string, sessionId: number): Promise<SessionRefreshResult | null>
}
/** 所有者来自 Host 鉴权；越权和不存在返回相同结果。 */
export function createAgentSessionRefresh(repository: SessionRefreshRepository) {
  return async (ownerId: string, sessionId: number): Promise<SessionRefreshResult | null> => {
    const owner = dataContext(ownerId).ownerId
    if (!Number.isSafeInteger(sessionId)) throw new CoreError('invalid_request', '会话 ID 无效')
    return repository.refresh(owner, sessionId)
  }
}

/** 复用 Core Kysely 事务；SQLite 使用 runtime 的 BEGIN IMMEDIATE。 */
export function createSqlAgentSessionRefreshRepository(db: Kysely<any>, backend: 'sqlite' | 'postgres', clock: Clock = nowUtc): SessionRefreshRepository {
  return { async refresh(ownerId, sessionId) {
    const owner = backend === 'sqlite' ? ownerId.replaceAll('-', '') : ownerId
    const time = databaseTime(clock(), backend)
    try {
      return await db.transaction().execute(async tx => {
        const result = await sql<{ id: number | string; context_epoch: number | string; snapshot_hash: string | null; session_info_hash: string | null; snapshot_expires_at: string | Date }>`UPDATE conversation_sessions SET snapshot_expires_at=${time}, context_epoch=COALESCE(context_epoch,0)+1, updated_at=${time} WHERE id=${sessionId} AND user_id=${owner} RETURNING id,context_epoch,snapshot_hash,session_info_hash,snapshot_expires_at`.execute(tx)
        const row = result.rows[0]
        if (!row) return null
        const expiry = row.snapshot_expires_at instanceof Date ? row.snapshot_expires_at.toISOString() : row.snapshot_expires_at
        const expiresAt = utc(expiry).replace(' ', 'T').replace('+00:00', 'Z').replace(/(\.\d*?)0+Z$/, '$1Z').replace(/\.Z$/, 'Z')
        return { id: integer(row.id), contextEpoch: integer(row.context_epoch), snapshotHash: row.snapshot_hash, sessionInfoHash: row.session_info_hash, expiresAt }
      })
    } catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: conversation_sessions/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', 'Agent 会话数据表尚未初始化')
      throw error
    }
  } }
}
/** 复用 Host 的 PG 连接池，池生命周期由 Host 管理。 */
export function createPostgresAgentSessionRefreshRepository(pool: Pick<Pool, 'query' | 'connect'>): SessionRefreshRepository {
  return createSqlAgentSessionRefreshRepository(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres')
}
