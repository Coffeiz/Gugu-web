import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../../contracts/index.js'
import type { Block, HistoryIdentity } from '../../models.js'
import type { HistoryImageReaderPort } from '../../ports.js'

const maxBytes = 8 * 1024 * 1024
const maxCandidates = 48
function scope(identity: HistoryIdentity, ids: readonly string[]): { owner: string; session: string; ids: string[] } {
  const owner = dataContext(identity.ownerId).ownerId
  if (!/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId)) ||
      !Array.isArray(ids) || ids.length > maxCandidates || ids.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new CoreError('invalid_request', '历史图片身份无效')
  return { owner, session: identity.sessionId, ids: [...new Set(ids)] }
}

/** 读取授权的用户消息快照；所有大字段都在数据库复核总大小后才传输。 */
export function createSqlPostgresHistoryImages(db: Kysely<any>): HistoryImageReaderPort {
  return {
    async readSizes(identity, candidateIds, signal) {
      signal?.throwIfAborted()
      const { owner, session, ids } = scope(identity, candidateIds)
      if (!ids.length) return new Map()
      try {
        const result = await sql<{ id: string; bytes: number }>`SELECT m.id::text AS id, octet_length(m.provider_image_content::text) AS bytes
          FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
          WHERE s.user_id=${owner} AND s.id=${session} AND m.role='user' AND m.id::text = ANY(${ids}::text[])
            AND m.provider_image_content IS NOT NULL`.execute(db)
        return new Map(result.rows.map(row => [row.id, Number(row.bytes)]))
      } finally { signal?.throwIfAborted() }
    },
    async readPayloads(identity, selectedIds, signal) {
      signal?.throwIfAborted()
      const { owner, session, ids } = scope(identity, selectedIds)
      if (!ids.length) return new Map()
      try {
        const result = await sql<{ id: string | null; oversized: boolean; payload: unknown }>`WITH candidates AS MATERIALIZED (
          SELECT m.id,m.provider_image_content,octet_length(m.provider_image_content::text) AS bytes
          FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
          WHERE s.user_id=${owner} AND s.id=${session} AND m.role='user' AND m.id::text = ANY(${ids}::text[])
            AND m.provider_image_content IS NOT NULL
        ), budget AS (SELECT COALESCE(SUM(bytes),0)>${maxBytes} AS oversized FROM candidates)
        SELECT candidates.id::text AS id,budget.oversized,
          CASE WHEN budget.oversized THEN NULL ELSE candidates.provider_image_content END AS payload
        FROM budget LEFT JOIN candidates ON TRUE`.execute(db)
        if (result.rows[0]?.oversized) throw new CoreError('storage_error', '历史图片快照超过读取上限')
        const payloads = new Map<string, readonly Block[]>()
        for (const row of result.rows) if (row.id !== null && Array.isArray(row.payload)) payloads.set(row.id, row.payload as Block[])
        return payloads
      } finally { signal?.throwIfAborted() }
    },
  }
}

/** 借用连接池，不管理其生命周期。 */
export function createPostgresHistoryImages(pool: Pick<Pool, 'query' | 'connect'>): HistoryImageReaderPort {
  return createSqlPostgresHistoryImages(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }))
}
