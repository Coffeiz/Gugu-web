import { MemorySearchAccessError, type RunIdentity } from '@gugu/core/agent'
import type { AuthorizedMemoryScope, MemorySearchScope } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'

export interface TrustedAgentImMemoryContext {
  platform: string
  chatType: string
  chatId: string
  channelId: string
  role: string
  platformUserId: string
}

type StoredScopeRow = { scope_type: string; scope_id: string; platform: string; bot_id: string }
interface ScopeQuery {
  select(columns: readonly string[]): ScopeQuery
  where(column: string, operator: '=', value: string): ScopeQuery
  orderBy(column: string): ScopeQuery
  limit(value: number): ScopeQuery
  execute(): Promise<StoredScopeRow[]>
}

const imPlatforms = new Set(['qq', 'feishu', 'wechat'])

type ImContextRow = {
  platform: string | null
  chat_type: string | null
  chat_id: string | null
  channel_id: string | null
  owner_platform_user_id: string | null
  platform_user_id: string | null
  inbound_message_id: string | null
}

/**
 * 从当前 owner 的会话和本次 Run 的入站消息恢复可信 IM 身份。
 * 缺少当前消息、Bot 绑定或消息发送者时拒绝 IM scope，不能退回 owner scope。
 */
export function createPostgresAgentImMemoryContextReader(pool: Pick<Pool, 'query'>) {
  return async (identity: RunIdentity, signal: AbortSignal): Promise<TrustedAgentImMemoryContext | null> => {
    signal.throwIfAborted()
    const ownerId = normalizeOwnerId(identity.ownerId)
    if (!/^[1-9]\d*$/u.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId)) || !identity.runId.trim()) {
      throw new MemorySearchAccessError('记忆检索上下文不可用')
    }
    const result = await pool.query<ImContextRow>(`SELECT s.source AS platform,s.chat_type,s.chat_id,
        b.bot_platform_user_id AS channel_id,b.owner_platform_user_id,m.platform_user_id,m.id::text AS inbound_message_id
      FROM conversation_sessions s
      LEFT JOIN LATERAL (
        SELECT bot_platform_user_id,owner_platform_user_id FROM user_bots
        WHERE user_id=s.user_id AND platform=s.source AND id::text=s.bot_id
        ORDER BY id LIMIT 1
      ) b ON TRUE
      LEFT JOIN LATERAL (
        SELECT id,platform_user_id FROM conversation_messages
        WHERE session_id=s.id AND role='user' AND (run_id=$3 OR run_id IS NULL)
        ORDER BY conversation_seq DESC,id DESC LIMIT 1
      ) m ON TRUE
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3`, [ownerId, identity.sessionId, identity.runId])
    signal.throwIfAborted()

    const row = result.rows[0]
    if (!row) throw new MemorySearchAccessError('记忆检索上下文不可用')
    if (!imPlatforms.has(row.platform ?? '')) return null
    if (!row.chat_type || !row.channel_id || !row.owner_platform_user_id || !row.platform_user_id || !row.inbound_message_id
      || (row.chat_type === 'group' && !row.chat_id)) {
      throw new MemorySearchAccessError('记忆检索上下文不可用')
    }
    return {
      platform: row.platform!,
      chatType: row.chat_type,
      chatId: row.chat_id ?? '',
      channelId: row.channel_id,
      role: row.owner_platform_user_id === row.platform_user_id ? 'owner' : 'member',
      platformUserId: row.platform_user_id,
    }
  }
}

/**
 * 复刻 Python resolve_memory_query_scopes：IM 上下文必须来自可信 Host，
 * 跨群范围只能从当前 owner 的 reflection cursor 推导，模型不能提交群/成员 ID。
 */
export function createPostgresAgentMemoryScopeResolver(db: unknown, options: {
  context(identity: RunIdentity, signal: AbortSignal): Promise<TrustedAgentImMemoryContext | null>
}) {
  async function storedScopes(input: {
    identity: RunIdentity
    platform?: string
    botId?: string
    excludeGroupId?: string
    memberId?: string
    limit: number
    signal: AbortSignal
  }): Promise<AuthorizedMemoryScope[]> {
    input.signal.throwIfAborted()
    const queryLimit = input.memberId ? Math.min(input.limit * 3, 40) : input.limit
    let query = (db as { selectFrom(table: string): ScopeQuery }).selectFrom('memory_reflection_cursors')
      .select(['scope_type', 'scope_id', 'platform', 'bot_id'])
      .where('owner_user_id', '=', input.identity.ownerId)
      .where('scope_type', '=', input.memberId ? 'platform-user' : 'group')
    if (input.platform) query = query.where('platform', '=', input.platform)
    if (input.botId) query = query.where('bot_id', '=', input.botId)
    const rows = await query.orderBy('id').limit(queryLimit).execute()
    input.signal.throwIfAborted()
    const scopes: AuthorizedMemoryScope[] = []
    for (const row of rows) {
      if (row.scope_type === 'group') {
        if (row.scope_id && row.scope_id !== input.excludeGroupId) {
          scopes.push({ ownerId: input.identity.ownerId, type: 'group', id: row.scope_id,
            platform: row.platform, botId: row.bot_id, groupId: row.scope_id })
        }
      } else if (row.scope_type === 'platform-user' && input.memberId) {
        const [groupId, memberId] = row.scope_id.split(/:(.*)/su, 2)
        if (groupId && memberId === input.memberId && groupId !== input.excludeGroupId) {
          scopes.push({ ownerId: input.identity.ownerId, type: 'member', id: `${groupId}:${memberId}`,
            platform: row.platform, botId: row.bot_id, groupId })
          if (scopes.length >= input.limit) break
        }
      }
    }
    return scopes
  }

  return async (identity: RunIdentity, requested: MemorySearchScope, signal: AbortSignal): Promise<AuthorizedMemoryScope[]> => {
    signal.throwIfAborted()
    const im = await options.context(identity, signal)
    signal.throwIfAborted()
    const owner: AuthorizedMemoryScope = { ownerId: identity.ownerId, type: 'owner', id: identity.ownerId }
    if (!im) return [owner]
    const platform = String(im.platform || '')
    const chatType = String(im.chatType || '')
    const chatId = String(im.chatId || '')
    const botId = String(im.channelId || '')
    const role = String(im.role || '')
    const memberId = String(im.platformUserId || '')
    const isIm = imPlatforms.has(platform)
    const isGroup = isIm && chatType === 'group' && !!(chatId && botId)

    if (requested === 'private_memory') {
      if (isIm && (role !== 'owner' || chatType === 'group')) throw new MemorySearchAccessError('当前会话不能读取 owner 私人记忆')
      return [owner]
    }
    if (!isIm) return [owner]
    if (requested === 'current_group' && !isGroup) throw new TypeError('current_group 只能在群聊中使用')

    if (role === 'owner' && !isGroup) {
      if (requested === 'auto' || requested === 'all_my_groups') {
        return [owner, ...await storedScopes({ identity, platform: platform || undefined, botId: botId || undefined,
          limit: 3, signal })]
      }
      return [owner]
    }
    if (!isGroup && role === 'member' && memberId) {
      if (requested === 'auto' || requested === 'all_my_groups') {
        return storedScopes({ identity, platform, botId, memberId, limit: 3, signal })
      }
      throw new TypeError('current_group 只能在群聊中使用')
    }
    if (isGroup) {
      const current: AuthorizedMemoryScope[] = [{ ownerId: identity.ownerId, type: 'group', id: chatId,
        platform, botId, groupId: chatId }]
      if (role === 'member') current.push({ ownerId: identity.ownerId, type: 'member', id: `${chatId}:${memberId}`,
        platform, botId, groupId: chatId })
      if (requested === 'all_my_groups') {
        current.push(...await storedScopes({ identity, platform, botId, excludeGroupId: chatId,
          ...(role === 'member' && memberId ? { memberId } : {}), limit: 2, signal }))
      }
      return current
    }
    throw new MemorySearchAccessError('当前身份没有可用的记忆召回范围')
  }
}
