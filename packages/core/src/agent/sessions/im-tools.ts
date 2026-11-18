import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { RunIdentity } from '../models.js'
import type { AgentImToolPorts } from '../tools/im.js'

type GroupReads = Pick<NonNullable<AgentImToolPorts['group']>, 'speakers' | 'search'>
type OwnerBinding = NonNullable<AgentImToolPorts['ownerSession']>
type Backend = 'postgres' | 'sqlite'

function storedOwner(ownerId: string, backend: Backend) {
  const canonical = dataContext(ownerId).ownerId
  return backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
}

/** 由已验证的 IM 群范围读取同一 owner、平台、机器人、群的历史。 */
export function createSqlAgentGroupHistory<DB>(db: Kysely<DB>, backend: Backend): GroupReads {
  function scope(ownerId: string, group: Parameters<GroupReads['search']>[1]) {
    return sql`FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      WHERE s.user_id=${storedOwner(ownerId, backend)} AND s.source=${group.platform} AND s.bot_id=${group.botId}
        AND s.chat_type='group' AND s.chat_id=${group.chatId}`
  }
  return {
    async speakers(identity, group, signal) {
      signal.throwIfAborted()
      const result = await sql<{ id: string; name: string | null; created_at: Date | string | null }>`
        SELECT m.platform_user_id AS id,m.platform_user_name AS name,m.created_at
        ${scope(identity.ownerId, group)} AND m.role='user' AND m.platform_user_id IS NOT NULL
      `.execute(db)
      signal.throwIfAborted()
      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        lastSeen: row.created_at === null ? null : timestampSeconds(row.created_at),
      }))
    },
    async search(identity, group, query, signal) {
      signal.throwIfAborted()
      const terms = query.queries.map(term => {
        const pattern = `%${term}%`
        return backend === 'postgres' ? sql`m.content ILIKE ${pattern}` : sql`lower(m.content) LIKE lower(${pattern})`
      })
      const keywordFilter = terms.length ? sql`AND (${sql.join(terms, query.mode === 'AND' ? sql` AND ` : sql` OR `)})` : sql``
      const speakerFilter = query.speakerId ? sql`AND m.platform_user_id=${query.speakerId}` : sql``
      const result = await sql<Awaited<ReturnType<GroupReads['search']>>[number]>`
        SELECT m.role,m.content,m.platform_user_id,m.platform_user_name
        ${scope(identity.ownerId, group)} AND m.content_json IS NULL ${speakerFilter} ${keywordFilter}
        ORDER BY m.conversation_seq DESC LIMIT ${query.limit}
      `.execute(db)
      signal.throwIfAborted()
      return result.rows
    },
  }
}

function timestampSeconds(time: Date | string): number | null {
  const ms = time instanceof Date ? time.getTime() : Date.parse(
    /^\d{4}-\d\d-\d\d[ T][\d:.]+$/u.test(time) ? time.replace(' ', 'T') + 'Z' : time,
  )
  return Number.isFinite(ms) ? ms / 1000 : null
}

const ownerSessionTtlSeconds = 12 * 60 * 60
type PrivateOwner = Parameters<OwnerBinding['bind']>[1]

/** 兼容现有 IM 路由的 Redis 协议。带 Bot 的私聊限定到同一 Bot 键。 */
export function agentOwnerSessionKey(ownerId: string, scope: PrivateOwner): string | null {
  if (scope.role !== 'owner' || scope.chatType !== 'c2c') return null
  const parts = [scope.platform, scope.platformUserId, ...(scope.botId === undefined ? [] : [scope.botId])]
  if (parts.some(value => !value || /[:\s\p{Cc}]/u.test(value))) return null
  return [`im:owner-session:${dataContext(ownerId).ownerId}`, ...parts].join(':')
}

/** 写入和恢复路由共用 owner 与 Web 来源约束。 */
export function createSqlAgentOwnerSessionBindings<DB>(db: Kysely<DB>, backend: Backend, redis: {
  getBinding(key: string): Promise<string | null>
  setBinding(key: string, value: string, ttlSeconds: number, signal: AbortSignal): Promise<'bound' | 'unknown'>
}, privateOwner: (identity: RunIdentity, signal: AbortSignal, database: Kysely<DB>) => Promise<PrivateOwner | null>) {
  async function ownsWebSession(database: Kysely<DB>, owner: string, sessionId: number, lock = false) {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1 || sessionId > 2_147_483_647) return false
    const result = await sql<{ id: number }>`SELECT id FROM conversation_sessions
      WHERE id=${sessionId} AND user_id=${storedOwner(owner, backend)} AND (source IS NULL OR source='web')
      ${lock && backend === 'postgres' ? sql`FOR SHARE` : sql``}`.execute(database)
    return result.rows.length > 0
  }
  const bind: OwnerBinding['bind'] = async (identity, scope, sessionId, signal) => {
    signal.throwIfAborted()
    const key = agentOwnerSessionKey(identity.ownerId, scope)
    if (!key) return 'denied'
    let writing = false
    try {
      return await db.transaction().execute(async tx => {
        if (!await ownsWebSession(tx, identity.ownerId, sessionId, true)) return 'not_found'
        const current = await privateOwner(identity, signal, tx)
        signal.throwIfAborted()
        if (!current || agentOwnerSessionKey(identity.ownerId, current) !== key) return 'denied'
        writing = true
        return redis.setBinding(key, String(sessionId), ownerSessionTtlSeconds, signal)
      })
    } catch (error) {
      if (writing) return 'unknown'
      throw error
    }
  }
  return {
    bind,
    async readWebSession(ownerId: string, scope: PrivateOwner, signal: AbortSignal) {
      signal.throwIfAborted()
      const key = agentOwnerSessionKey(ownerId, scope)
      if (!key) return null
      signal.throwIfAborted()
      const raw = await redis.getBinding(key)
      signal.throwIfAborted()
      if (!raw || !/^[1-9]\d*$/u.test(raw)) return null
      const sessionId = Number(raw)
      const owned = await ownsWebSession(db, ownerId, sessionId)
      signal.throwIfAborted()
      return owned ? sessionId : null
    },
  }
}
