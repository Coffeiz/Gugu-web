import { z } from 'zod'
import { normalizeGlobalSearchQueries } from '@gugu/search'
import { strip } from '../../shared/values.js'
import type { Json, RunIdentity, ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'

const emojis = {
  agree: 'THUMBSUP', good: 'THUMBSUP', love: 'HEART', thanks: 'THANKS',
  laugh: 'LAUGH', wow: 'WOW', sad: 'CRY', thinking: 'THINKING',
  celebrate: 'PARTY', ok: 'OK', done: 'DONE',
} as const
const moods = Object.keys(emojis) as Array<keyof typeof emojis>
type ReactionTarget = { platform: 'feishu'; channelId: string; messageId: string }
type PrivateOwner = { platform: string; platformUserId: string; botId?: string; role: 'owner'; chatType: 'c2c' }
type Group = { platform: 'qq' | 'feishu' | 'telegram'; botId: string; chatId: string }
type Scope<T> = (identity: RunIdentity, signal: AbortSignal) => Promise<T | null>

/** 授权解析器每次使用真实 Run 身份重验平台和目标。模型无法提供这些字段。 */
export interface AgentImToolPorts {
  reaction?: {
    target: Scope<ReactionTarget>
    react(identity: RunIdentity, target: ReactionTarget, emoji: typeof emojis[keyof typeof emojis], signal: AbortSignal): Promise<'sent' | 'rejected' | 'unknown'>
  }
  ownerSession?: {
    privateOwner: Scope<PrivateOwner>
    /** 写入前校验 owner 和 Web 来源。恢复时不重写已变更的绑定。 */
    bind(identity: RunIdentity, owner: PrivateOwner, sessionId: number, signal: AbortSignal): Promise<'bound' | 'not_found' | 'denied' | 'unknown'>
  }
  group?: {
    scope: Scope<Group>
    speakers(identity: RunIdentity, group: Group, signal: AbortSignal): Promise<readonly LiveSpeaker[]>
    members(identity: RunIdentity, group: Group, signal: AbortSignal): Promise<Readonly<Record<string, Member>>>
    search(identity: RunIdentity, group: Group, query: {
      queries: readonly string[]; mode: 'OR' | 'AND'; speakerId: string | null; limit: number
    }, signal: AbortSignal): Promise<readonly GroupMessage[]>
  }
}

interface LiveSpeaker { id: string; name: string | null; lastSeen: number | null }
interface Member { name?: string; aliases?: readonly string[]; nicknames?: readonly string[]; last_seen_at?: number }
interface GroupMessage { role: string; content: string | null; platform_user_id: string | null; platform_user_name: string | null }

function completed(value: Json, successful = true, mutated = false): ToolResult {
  return { kind: 'completed', successful, mutated, value }
}

function reactionTool(port: NonNullable<AgentImToolPorts['reaction']>): ToolDefinition {
  const schema = z.object({ mood: z.enum(moods) }).strict()
  return {
    definition: { name: 'react', schema: { type: 'function', function: {
      name: 'react', description: '给当前飞书消息添加表情回应。',
      parameters: { type: 'object', properties: { mood: { type: 'string', enum: moods } }, required: ['mood'], additionalProperties: false },
    } } },
    effect: 'write',
    validate: input => schema.safeParse(input),
    async execute(input, { identity, signal }) {
      signal.throwIfAborted()
      const target = await port.target(identity, signal)
      signal.throwIfAborted()
      if (target?.platform !== 'feishu' || !target.channelId || !target.messageId)
        return completed({ ok: false, message: '当前不在飞书对话里，没法加表情回应（仅 IM 可用）。' }, false)
      const { mood } = input as z.infer<typeof schema>
      const result = await port.react(identity, target, emojis[mood], signal)
      if (result === 'unknown') return { kind: 'unknown' }
      if (result === 'rejected')
        return completed({ ok: false, message: '加表情没成功（可能缺 im:message_reaction 权限），跳过即可，别重试。' }, false)
      return completed({ ok: true, message: `已给用户这条消息加了「${mood}」表情。` }, true, true)
    },
  }
}

function bindSessionTool(port: NonNullable<AgentImToolPorts['ownerSession']>): ToolDefinition {
  const schema = z.object({ session_id: z.number().int().safe() }).strict()
  return {
    definition: { name: 'bind_web_session', schema: { type: 'function', function: {
      name: 'bind_web_session', description: '将当前 owner 私聊绑定到属于自己的 Web 对话。',
      parameters: { type: 'object', properties: { session_id: { type: 'integer' } }, required: ['session_id'], additionalProperties: false },
    } } },
    effect: 'write',
    validate: input => schema.safeParse(input),
    async execute(input, { identity, signal }) {
      signal.throwIfAborted()
      const owner = await port.privateOwner(identity, signal)
      signal.throwIfAborted()
      if (owner?.role !== 'owner' || owner.chatType !== 'c2c' || !owner.platform || !owner.platformUserId)
        return completed({ error: '只有绑定账号的私聊可以绑定网页会话' }, false)
      const { session_id } = input as z.infer<typeof schema>
      if (!session_id) return completed({ error: '需要提供 session_id' }, false)
      const result = await port.bind(identity, owner, session_id, signal)
      if (result === 'unknown') return { kind: 'unknown' }
      if (result === 'denied') return completed({ error: '只有绑定账号的私聊可以绑定网页会话' }, false)
      if (result === 'not_found') return completed({ error: '网页会话不存在、不属于你，或不是 Web 会话' }, false)
      return completed({ bound: true, session_id, message: '已绑定，之后可以在这里继续这段网页对话' }, true, true)
    },
  }
}

async function resolveSpeaker(speaker: string, rows: readonly LiveSpeaker[], loadMembers: () => Promise<Readonly<Record<string, Member>>>): Promise<{ id: string } | { failure: Json }> {
  const live = rows.filter(row => row.id)
  if (live.some(row => row.id === speaker)) return { id: speaker } as const
  const members = await loadMembers()
  if (Object.hasOwn(members, speaker)) return { id: speaker } as const

  const lastSeen = new Map<string, number>()
  for (const row of live)
    lastSeen.set(row.id, Math.max(lastSeen.get(row.id) ?? 0, row.lastSeen ?? 0))

  for (const exact of [true, false]) {
    const hits = new Map<string, { matched_by: string; matched_text: string }>()
    const matches = (value: string) => value && (exact ? value === speaker : value.includes(speaker) || speaker.includes(value))
    const add = (id: string, field: string, value: string) => {
      if (matches(value) && !hits.has(id)) hits.set(id, { matched_by: field, matched_text: value })
    }
    for (const row of live) if (row.name) add(row.id, 'name', row.name)
    for (const field of ['aliases', 'nicknames'] as const)
      for (const [id, member] of Object.entries(members))
        for (const value of member[field] ?? []) add(id, field, value)
    if (hits.size === 1) return { id: hits.keys().next().value! } as const
    if (hits.size > 1) {
      const candidates = [...hits].map(([id, hit]) => {
        const member = Object.hasOwn(members, id) ? members[id] : undefined
        return {
          platform_user_id: id, ...hit,
          name: member?.name || (hit.matched_by === 'name' ? hit.matched_text : ''),
          last_seen_at: member?.last_seen_at || lastSeen.get(id) || null,
        }
      })
      candidates.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0))
      return { failure: { ambiguous: true, candidates: candidates.slice(0, 5) } } as const
    }
  }
  return { failure: { error: `没有找到叫 ${speaker} 的群成员` } } as const
}

function groupSearchTool(port: NonNullable<AgentImToolPorts['group']>): ToolDefinition {
  const schema = z.object({
    query: z.string().optional(), keyword: z.string().optional(), queries: z.array(z.string()).optional(),
    mode: z.enum(['OR', 'AND']).optional(), speaker: z.string().optional(), limit: z.number().int().safe().optional(),
  }).strict()
  return {
    definition: { name: 'group_context_search', schema: { type: 'function', function: {
      name: 'group_context_search', description: '搜索当前 QQ、飞书或 Telegram 群的短期消息，可按发言人筛选。',
      parameters: { type: 'object', properties: {
        query: { type: 'string' }, keyword: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['OR', 'AND'] }, speaker: { type: 'string' }, limit: { type: 'integer' },
      }, additionalProperties: false },
    } } },
    effect: 'read',
    strictArrayFields: ['queries'],
    validate: input => schema.safeParse(input),
    async execute(input, { identity, signal }) {
      signal.throwIfAborted()
      const scope = await port.scope(identity, signal)
      signal.throwIfAborted()
      if (!scope?.chatId || !scope.botId || !['qq', 'feishu', 'telegram'].includes(scope.platform))
        return completed({ error: '当前不在群聊上下文中，不能使用群聊搜索' }, false)
      const args = input as z.infer<typeof schema>
      const keyword = strip(args.query || args.keyword || '')
      const queries = normalizeGlobalSearchQueries(keyword, args.queries ?? [])
      const mode = args.mode ?? 'OR'
      const speaker = strip(args.speaker ?? '')
      let speakerId: string | null = null
      if (speaker) {
        const live = await port.speakers(identity, scope, signal)
        signal.throwIfAborted()
        const resolved = await resolveSpeaker(speaker, live, () => port.members(identity, scope, signal))
        signal.throwIfAborted()
        if ('failure' in resolved) return completed(resolved.failure, false)
        speakerId = resolved.id
      }
      const rows = await port.search(identity, scope, { queries, mode, speakerId, limit: Math.max(1, Math.min(args.limit || 10, 30)) }, signal)
      signal.throwIfAborted()
      const messages = [...rows].reverse().flatMap(row => row.content ? [{
        role: row.role === 'user' ? '用户' : '咕咕',
        content: [...row.content].slice(0, 1000).join(''),
        ...(row.role === 'user' ? { platform_user_id: row.platform_user_id, platform_user_name: row.platform_user_name } : {}),
      }] : [])
      return completed({ keyword, queries, mode, speaker, speaker_id: speakerId, messages })
    },
  }
}

export function createAgentImTools(ports: AgentImToolPorts): ToolDefinition[] {
  return [
    ...(ports.reaction ? [reactionTool(ports.reaction)] : []),
    ...(ports.ownerSession ? [bindSessionTool(ports.ownerSession)] : []),
    ...(ports.group ? [groupSearchTool(ports.group)] : []),
  ]
}
