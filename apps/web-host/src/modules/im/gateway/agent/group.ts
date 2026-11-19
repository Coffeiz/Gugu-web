import type { RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { resolveGroupSpeaker, type GroupContextSearchPort, type GroupContextSearchRequest, type GroupMember, type GroupSpeakerRow } from '@gugu/core/tools'
import { createLocalImMemoryMaintenanceStorage, imMemoryMaintenanceScopeFileKey } from '../../../admin/memory-apply.js'

type Row = Record<string, unknown>
export interface GroupContextQuery { query(sql: string, values: unknown[]): Promise<{ rows: Row[] }> }
export class ImGroupContextError extends Error {
  constructor(readonly code: 'invalid_scope' | 'unauthorized' | 'unavailable' | 'invalid_data') { super('当前群上下文读取不可用'); this.name = 'ImGroupContextError' }
}
export function createPostgresImGroupContextSearch(options: {
  pool: GroupContextQuery; storageRoot: string; identity: RunIdentity; actor: ImActor; beforeMessageId: number
  /** 必须结合当前Run绑定与当前Bot/账户/工具权限复核；不接受模型或平台body声明。 */
  authorize(identity: RunIdentity, actor: ImActor, signal: AbortSignal): Promise<boolean>
  isTombstoned(scope: Parameters<typeof imMemoryMaintenanceScopeFileKey>[0]): Promise<boolean>
}): GroupContextSearchPort {
  const identity = Object.freeze({ ...options.identity }), actor = structuredClone(options.actor)
  if (identity.ownerId !== actor.ownerId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity.ownerId)
    || !/^[1-9]\d*$/.test(identity.sessionId) || !identity.runId || !/^[1-9]\d*$/.test(actor.botId)
    || !['qq', 'feishu', 'telegram'].includes(actor.platform) || actor.chatType !== 'group' || !actor.chatId
    || actor.chatId.length > 256 || /[\r\n\0]/.test(actor.chatId) || !actor.platformUserId || actor.platformUserId.length > 256 || /[\r\n\0]/.test(actor.platformUserId)
    || typeof options.storageRoot !== 'string' || !options.storageRoot.trim()
    || !Number.isSafeInteger(options.beforeMessageId) || options.beforeMessageId < 1)
    throw new ImGroupContextError('invalid_scope')
  const before = options.beforeMessageId
  const memoryScope = { owner_user_id: identity.ownerId, platform: actor.platform, bot_id: actor.botId, scope_type: 'group' as const, scope_id: actor.chatId }
  const membersKey = imMemoryMaintenanceScopeFileKey(memoryScope, 'members.json')
  const storage = createLocalImMemoryMaintenanceStorage(options.storageRoot)
  async function authorize(target: RunIdentity, signal: AbortSignal) {
    signal.throwIfAborted()
    if (target.ownerId !== identity.ownerId || target.sessionId !== identity.sessionId || target.runId !== identity.runId
      || !await options.authorize(identity, structuredClone(actor), signal)) throw new ImGroupContextError('unauthorized')
    signal.throwIfAborted()
  }
  async function retained(search?: { request: GroupContextSearchRequest; speakerId: string | null }): Promise<Row[]> {
    // 真实当前Run用户消息锚点与完整群scope共同限定水位；ID只用于定位，不把全局ID误当会话顺序。
    const projection = search
      ? 'm.id,m.session_id,m.conversation_seq,m.role,m.content,m.content_json,m.platform_user_id,m.platform_user_name'
      : 'm.id,m.session_id,m.conversation_seq,m.role,m.platform_user_id,m.platform_user_name,m.created_at'
    const selection = search ? `SELECT r.*,a.id AS anchor_id FROM anchor a LEFT JOIN LATERAL (
      SELECT r.* FROM retained r WHERE r.session_id=a.session_id AND r.conversation_seq<a.conversation_seq
        AND r.content_json IS NULL AND ($8::text IS NULL OR r.platform_user_id=$8)
        AND (cardinality($9::text[])=0 OR CASE WHEN $10='AND' THEN
          NOT EXISTS (SELECT 1 FROM unnest($9::text[]) q WHERE COALESCE(r.content,'') NOT ILIKE '%' || q || '%')
        ELSE EXISTS (SELECT 1 FROM unnest($9::text[]) q WHERE COALESCE(r.content,'') ILIKE '%' || q || '%') END)
      ORDER BY r.conversation_seq DESC,r.id DESC LIMIT $11
    ) r ON TRUE ORDER BY r.conversation_seq DESC,r.id DESC`
      : `SELECT max(r.id) AS id,r.session_id,'user' AS role,r.platform_user_id,r.platform_user_name,max(r.created_at) AS created_at,a.id AS anchor_id
      FROM anchor a LEFT JOIN retained r ON r.session_id=a.session_id AND r.conversation_seq<a.conversation_seq
        AND r.role='user' AND r.platform_user_id IS NOT NULL
      GROUP BY a.id,r.session_id,r.platform_user_id,r.platform_user_name ORDER BY max(r.created_at) DESC`
    const result = await options.pool.query(`WITH anchor AS (
      SELECT m.id,m.session_id,m.conversation_seq FROM conversation_messages m
      JOIN conversation_sessions s ON s.id=m.session_id
      JOIN user_bots b ON b.id::text=s.bot_id AND b.user_id=s.user_id
      JOIN users u ON u.id=b.user_id
      WHERE m.id=$1 AND m.run_id=$2 AND m.role='user' AND s.id=$3 AND s.user_id=$4::uuid
        AND s.source=$5 AND s.bot_id=$6 AND s.chat_type='group' AND s.chat_id=$7
        AND b.platform=$5 AND b.enabled IS TRUE AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
    ), retained AS (
      SELECT ${projection}
      FROM conversation_messages m JOIN anchor a ON a.session_id=m.session_id
    ) ${selection}`, [before, identity.runId, identity.sessionId, identity.ownerId, actor.platform, actor.botId, actor.chatId,
      ...(search ? [search.speakerId, search.request.queries, search.request.mode, search.request.limit] : [])])
    if (!result.rows.length) throw new ImGroupContextError('unauthorized')
    for (const row of result.rows) if (Number(row.anchor_id) !== before || row.id !== null && String(row.session_id) !== identity.sessionId) throw new ImGroupContextError('invalid_data')
    return result.rows.filter(row => row.id !== null)
  }
  async function members(signal: AbortSignal): Promise<Record<string, GroupMember>> {
    signal.throwIfAborted()
    if (await options.isTombstoned(memoryScope)) return {}
    const text = await storage.read(membersKey)
    signal.throwIfAborted()
    if (!text) return {}
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new ImGroupContextError('invalid_data') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ImGroupContextError('invalid_data')
    const value = (parsed as Row).members
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImGroupContextError('invalid_data')
    const entries = Object.entries(value)
    for (const [id, member] of entries) {
      if (!id || !member || typeof member !== 'object' || Array.isArray(member)) throw new ImGroupContextError('invalid_data')
      const item = member as Row
      if (item.name != null && typeof item.name !== 'string'
        || item.last_seen_at != null && (typeof item.last_seen_at !== 'number' || !Number.isFinite(item.last_seen_at))
        || ['aliases', 'nicknames'].some(field => item[field] != null && (!Array.isArray(item[field]) || item[field].some(value => typeof value !== 'string'))))
        throw new ImGroupContextError('invalid_data')
    }
    if (await options.isTombstoned(memoryScope)) return {}
    return value as Record<string, GroupMember>
  }
  return { async search(target, request: GroupContextSearchRequest, signal) {
    try {
      await authorize(target, signal)
      if (!Array.isArray(request.queries) || request.queries.length > 8 || request.queries.some(value => typeof value !== 'string' || [...value].length > 64)
        || !['AND', 'OR'].includes(request.mode) || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 30 || typeof request.speaker !== 'string')
        throw new ImGroupContextError('invalid_data')
      let speakerId: string | null = null
      if (request.speaker) {
        const rows = await retained()
        signal.throwIfAborted()
        const index: GroupSpeakerRow[] = rows.filter(row => row.role === 'user' && row.platform_user_id).map(row => ({ platformUserId: String(row.platform_user_id),
          name: typeof row.platform_user_name === 'string' ? row.platform_user_name : null,
          lastSeenAt: row.created_at instanceof Date ? row.created_at.getTime() / 1000 : typeof row.created_at === 'string' ? Date.parse(row.created_at) / 1000 : null }))
        const resolved = await resolveGroupSpeaker(request.speaker, index, () => members(signal))
        if (!('platform_user_id' in resolved)) { await authorize(target, signal); return resolved }
        speakerId = resolved.platform_user_id
      }
      // 关键词沿用真实PostgreSQL ILIKE及原有%/_/反斜线语义，不以JS子串匹配冒充数据库查询。
      const matches = (await retained({ request, speakerId })).reverse().filter(row => row.content).map(row => ({ role: row.role === 'user' ? '用户' : '咕咕', content: [...String(row.content)].slice(0, 1000).join(''),
          ...(row.role === 'user' ? { platform_user_id: row.platform_user_id, platform_user_name: row.platform_user_name } : {}) }))
      await authorize(target, signal)
      return { keyword: request.keyword, queries: request.queries, mode: request.mode, speaker: request.speaker, speaker_id: speakerId, messages: matches }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ImGroupContextError) throw error
      throw new ImGroupContextError('unavailable')
    }
  } }
}
