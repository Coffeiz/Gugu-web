import { z } from 'zod'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import { normalizeGlobalSearchQueries } from '@gugu/search'

export interface GroupContextSearchRequest { keyword: string; queries: string[]; mode: 'OR' | 'AND'; limit: number; speaker: string }
export interface GroupContextSearchPort {
  /** Host绑定当前Run的真实群与消息水位，必须在读取前后复核当前权限。 */
  search(identity: RunIdentity, request: GroupContextSearchRequest, signal: AbortSignal): Promise<Record<string, unknown>>
}
export interface GroupSpeakerRow { platformUserId: string; name: string | null; lastSeenAt: number | null }
export interface GroupMember { name?: string | null; aliases?: readonly string[] | null; nicknames?: readonly string[] | null; last_seen_at?: number | null }
export type GroupSpeakerResolution = { platform_user_id: string } | { error: string } | { ambiguous: true; candidates: Array<{
  platform_user_id: string; matched_by: string; matched_text: string; name: string; last_seen_at: number | null
}> }

/** 精确alias与实时名字一起判断，禁止唯一模糊名字抢先选中错误成员。 */
export async function resolveGroupSpeaker(speaker: string, rows: readonly GroupSpeakerRow[], loadMembers: () => Promise<Record<string, GroupMember>>): Promise<GroupSpeakerResolution> {
  speaker = speaker.trim()
  if (!speaker) return { error: 'speaker 不能为空' }
  const liveIds = new Set<string>(), names = new Map<string, Set<string>>(), seen = new Map<string, number>()
  for (const row of rows) {
    if (!row.platformUserId) continue
    liveIds.add(row.platformUserId)
    if (row.name) { const ids = names.get(row.name) ?? new Set(); ids.add(row.platformUserId); names.set(row.name, ids) }
    if (row.lastSeenAt !== null && row.lastSeenAt > (seen.get(row.platformUserId) ?? 0)) seen.set(row.platformUserId, row.lastSeenAt)
  }
  if (liveIds.has(speaker)) return { platform_user_id: speaker }
  const members = new Map(Object.entries(await loadMembers()))
  if (members.has(speaker)) return { platform_user_id: speaker }
  for (const exact of [true, false]) {
    const hits = new Map<string, { by: string; text: string }>()
    const match = (value: string) => exact ? value === speaker : speaker.includes(value) || value.includes(speaker)
    for (const [name, ids] of names) if (match(name)) for (const id of ids) if (!hits.has(id)) hits.set(id, { by: 'name', text: name })
    for (const field of ['aliases', 'nicknames'] as const) for (const [id, member] of members) for (const value of member[field] ?? []) {
      if (value && match(value)) { if (!hits.has(id)) hits.set(id, { by: field, text: value }); break }
    }
    if (hits.size === 1) return { platform_user_id: hits.keys().next().value! }
    if (hits.size > 1) return { ambiguous: true, candidates: [...hits].map(([id, hit]) => ({ platform_user_id: id, matched_by: hit.by,
      matched_text: hit.text, name: members.get(id)?.name || (hit.by === 'name' ? hit.text : ''), last_seen_at: members.get(id)?.last_seen_at || seen.get(id) || null,
    })).sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)).slice(0, 5) }
  }
  return { error: `没有找到叫 ${speaker} 的群成员` }
}

export function createGroupContextSearchTool(port: GroupContextSearchPort): ToolDefinition {
  const schema = z.object({ query: z.string().optional(), keyword: z.string().optional(), queries: z.array(z.string()).optional(),
    mode: z.string().optional(), speaker: z.string().optional(), limit: z.number().int().safe().optional() }).strict()
  return { definition: { name: 'group_context_search', schema: { type: 'function', function: { name: 'group_context_search',
    description: '只搜索当前 QQ、飞书或 Telegram 群消息，可按关键词或发言人筛选；不会读取其他群、私聊或网页历史。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, keyword: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['OR', 'AND'] }, speaker: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false },
  } } }, effect: 'read', strictArrayFields: ['queries'], validate: input => schema.safeParse(input),
  async execute(input, scope) {
    const args = input as z.infer<typeof schema>, keyword = (args.query || args.keyword || '').trim()
    const value = await port.search(scope.identity, { keyword, queries: normalizeGlobalSearchQueries(keyword, args.queries ?? []),
      mode: args.mode?.toUpperCase() === 'AND' ? 'AND' : 'OR', limit: Math.max(1, Math.min(args.limit || 10, 30)), speaker: args.speaker?.trim() ?? '' }, scope.signal)
    scope.signal.throwIfAborted()
    return { kind: 'completed', successful: !('error' in value) && !('ambiguous' in value), mutated: false, value }
  } }
}
