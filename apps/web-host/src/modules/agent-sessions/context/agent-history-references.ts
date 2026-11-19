import type { Pool } from 'pg'
import type { HistoryReaderPort, Json } from '@gugu/core/agent'
import { resolveAgentChatReferences } from './agent-references.js'

/** 旧历史仅在读取时补全引用块，不写回记录；每次均重新验证 owner 和对象权限。 */
export function withAgentHistoryReferences(pool: Pick<Pool, 'query'>, history: HistoryReaderPort): HistoryReaderPort {
  return {
    ...history,
    async hydrateReferences(identity, rows, signal) {
      signal?.throwIfAborted()
      if (rows.some(row => row.ownerId !== identity.ownerId || row.sessionId !== identity.sessionId || !/^[1-9]\d*$/.test(row.id))) throw new Error('历史身份不匹配')
      const candidates = rows.filter(row => row.role === 'user' && !(
        Array.isArray(row.contentJson) && row.contentJson.some(block => block !== null && typeof block === 'object' && !Array.isArray(block)
          && block.type === 'knowledge-context' && block.scope === 'explicit-reference')))
      if (!candidates.length) return [...rows]
      const query = await pool.query<{ id: string; references_json: unknown }>(`SELECT m.id::text,m.references_json FROM conversation_messages m
        JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.id=$2 AND m.role='user' AND m.id=ANY($3::int[])`,
      [identity.ownerId, identity.sessionId, candidates.map(row => row.id)])
      signal?.throwIfAborted()
      const refs = new Map(query.rows.map(row => [row.id, row.references_json]))
      if (candidates.some(row => !refs.has(row.id))) throw new Error('历史消息不存在')
      const cache = new Map<string, readonly unknown[] | null>()
      const hydrated = []
      for (const row of rows) {
        const value = refs.get(row.id)
        if (!Array.isArray(value) || !value.length) { hydrated.push(row); continue }
        const filtered = value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
        const key = JSON.stringify(filtered)
        let content = cache.get(key)
        if (content === undefined) {
          // 只缓存引用块，消息正文因每条消息不同而单独添加。
          content = await resolveAgentChatReferences(pool, identity.ownerId, { message: '', references: filtered })
          cache.set(key, content)
        }
        signal?.throwIfAborted()
        if (!content) { hydrated.push(row); continue }
        hydrated.push({ ...row, contentJson: [content[0] as Json, { type: 'text', text: typeof row.content === 'string' ? row.content : '' }] as Json })
      }
      return hydrated
    },
  }
}
