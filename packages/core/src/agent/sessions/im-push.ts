import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { databaseTime, integer, nowUtc, type Clock } from '../../data/codec.js'
import { normalizePersistentArtifact } from '../context/history/attachment-refs.js'

export type ImPushPeer = {
  platform: 'qq' | 'feishu' | 'wechat' | 'telegram'
  botId: string
  chatType: 'group' | 'c2c'
  recipient: string
}

interface PushInput {
  ownerId: string
  peer: ImPushPeer
  boundSessionId: number | null
  title: string
  text: string
  artifacts?: readonly unknown[]
}

/** 只有明确的 owner 私聊绑定或匹配当前 IM 作用域的会话可接收主动推送。 */
export function createSqlImPushWriter<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite', now: Clock = nowUtc) {
  return async ({ ownerId, peer, boundSessionId, title, text, artifacts = [] }: PushInput): Promise<number> => {
    const owner = dataContext(ownerId).ownerId
    const storedOwner = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    const { platform, botId, chatType, recipient } = peer
    if (![botId, recipient].every(value => value.trim() === value && value.length > 0 && value.length <= 128)
      || !['qq', 'feishu', 'wechat', 'telegram'].includes(platform)
      || (chatType !== 'group' && chatType !== 'c2c')) throw new TypeError('IM 推送作用域无效')
    const group = chatType === 'group'
    const files = artifacts.flatMap(artifact => {
      if (!artifact || typeof artifact !== 'object' || (!('file_path' in artifact) && !('attach_id' in artifact))) return []
      try { return [normalizePersistentArtifact(artifact)] } catch { return [] }
    })
    const scope = sql`source=${platform} AND bot_id=${botId} AND
      ${group ? sql`chat_type='group' AND chat_id=${recipient}` : sql`chat_id IS NULL AND
        (chat_type='c2c' OR chat_type IS NULL) AND platform_user_id=${recipient}`}`
    const lockRow = backend === 'postgres' ? sql`FOR UPDATE` : sql``
    return db.transaction().execute(async tx => {
      if (backend === 'postgres') {
        const key = JSON.stringify(['im-push', owner, platform, botId, chatType, recipient])
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(tx)
      }
      const boundScope = group ? scope : sql`(${scope}) OR ((source IS NULL OR source='web') AND chat_id IS NULL)`
      const bound = boundSessionId === null ? undefined : (await sql<{ id: number }>`
        SELECT id FROM conversation_sessions WHERE user_id=${storedOwner} AND id=${boundSessionId}
          AND (${boundScope}) ${lockRow}`.execute(tx)).rows[0]
      const existing = bound ?? (await sql<{ id: number }>`
        SELECT id FROM conversation_sessions WHERE user_id=${storedOwner} AND (${scope})
        ORDER BY updated_at DESC,id DESC LIMIT 1 ${lockRow}`.execute(tx)).rows[0]
      const time = databaseTime(now(), backend)
      const session = existing ?? (await sql<{ id: number }>`
        INSERT INTO conversation_sessions (user_id,title,title_locked,summary,source,bot_id,chat_id,platform_user_id,
          chat_type,context_epoch,baseline_message_seq,last_message_seq,execution_state,pending_message_count,created_at,updated_at)
        VALUES (${storedOwner},${[...title].slice(0, 50).join('') || '主动消息'},FALSE,'',${platform},${botId},
          ${group ? recipient : null},${group ? null : recipient},${chatType},1,0,0,'idle',0,${time},${time})
        RETURNING id`.execute(tx)).rows[0]
      const sessionId = integer(session?.id)
      // 与 Python ORM 和普通 Agent 写入使用同一行上的消息序号分配。
      const { rows: [sequence] } = await sql<{ last_message_seq: number | string }>`
        UPDATE conversation_sessions SET last_message_seq=last_message_seq+1,updated_at=${time}
        WHERE id=${sessionId} AND user_id=${storedOwner} RETURNING last_message_seq`.execute(tx)
      await sql`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at,sent_at,files)
        VALUES (${sessionId},${integer(sequence?.last_message_seq)},'assistant',${`⏰ ${title}\n\n${text}`},${time},${time},
          ${files.length ? JSON.stringify(files) : null})`.execute(tx)
      return sessionId
    })
  }
}
