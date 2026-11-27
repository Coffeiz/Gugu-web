import { sql, type Kysely } from 'kysely'
import { resolveGroupSpeaker, type GroupContextSearchPort } from '../agent/tools/im/group-context.js'
import type { RunIdentity } from '../agent/models.js'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'

/** 搜索范围由已登记 Run 的群会话和入站消息序号决定。 */
export function createDesktopGroupContextSearch(db: Kysely<Database>,
  authorize: (identity: RunIdentity) => Promise<boolean>, scheduledConnection?: string): GroupContextSearchPort {
  return {
    async search(identity, request, signal) {
      signal.throwIfAborted()
      if (!await authorize(identity)) return { error: '群消息搜索未授权' }
      const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
      const session = Number(identity.sessionId)
      if (!scheduledConnection && (!Number.isSafeInteger(session) || session < 1)) return { error: '群会话无效' }
      const queries = request.queries.filter(Boolean)
      const matches = queries.length
        ? sql`AND (${sql.join(queries.map(query => sql`instr(lower(m.content),lower(${query}))>0`),
          request.mode === 'AND' ? sql` AND ` : sql` OR `)})`
        : sql``
      const history = scheduledConnection ? sql`
        FROM desktop_im_sessions im
        JOIN conversation_sessions s ON s.id=im.session_id AND s.user_id=im.owner_id AND s.chat_type='group'
        JOIN conversation_messages m ON m.session_id=s.id AND m.canonical_batch_id IS NULL
        WHERE im.owner_id=${owner} AND im.connection_id=${scheduledConnection}`
        : sql`
        FROM agent_run_admissions r
        JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
          AND s.chat_type='group' AND s.active_run_id=r.run_id
        JOIN desktop_im_sessions im ON im.session_id=s.id AND im.owner_id=s.user_id
        JOIN conversation_messages anchor ON anchor.id=r.user_message_id AND anchor.session_id=s.id
        JOIN conversation_messages m ON m.session_id=s.id AND m.conversation_seq<anchor.conversation_seq
          AND m.canonical_batch_id IS NULL
        WHERE r.user_id=${owner} AND r.session_id=${session} AND r.run_id=${identity.runId}`
      let speakerFilter = sql``
      if (request.speaker) {
        const { rows: speakers } = await sql<{ platformUserId: string; name: string | null; lastSeenAt: number | null }>`
          SELECT m.platform_user_id AS platformUserId, m.platform_user_name AS name,
            MAX(unixepoch(m.created_at))*1000 AS lastSeenAt
          ${history}
          AND m.role='user' AND m.platform_user_id IS NOT NULL
          GROUP BY m.platform_user_id,m.platform_user_name
          ORDER BY lastSeenAt DESC LIMIT 1000`.execute(db)
        signal.throwIfAborted()
        if (!await authorize(identity)) return { error: '群消息搜索未授权' }
        const resolved = await resolveGroupSpeaker(request.speaker, speakers, async () => ({}))
        if (!('platform_user_id' in resolved)) return resolved
        speakerFilter = sql`AND m.platform_user_id=${resolved.platform_user_id}`
      }
      const { rows } = await sql<{ role: string; text: string; created_at: string; platform_user_name: string | null }>`
        SELECT m.role,substr(m.content,1,1000) AS text,m.created_at,m.platform_user_name
        ${history}
          AND m.role IN ('user','assistant') AND length(trim(m.content))>0 ${matches} ${speakerFilter}
        ORDER BY m.conversation_seq DESC LIMIT ${Math.max(1, Math.min(request.limit, 30))}`.execute(db)
      signal.throwIfAborted()
      if (!await authorize(identity)) return { error: '群消息搜索未授权' }
      return { messages: rows }
    },
  }
}
