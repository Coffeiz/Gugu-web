import { readAgentPrompt, readAgentPromptSet } from '@gugu/core/agent/context/prompts'
import type { Pool } from 'pg'
import { agentContextPolicy, agentCurrentTimeReminder, asAgentContextRecord, type AgentStaticPromptInput, type CanonicalContextPorts,
  type ContextDataPorts, type ContextSourcePorts, type ContextSourceSelection, type HistoryIdentity, type Json, type RunIdentity } from '@gugu/core/agent'
import { imCanUseTool, type ImActor } from '@gugu/core/im/access'
import { formatPlatformUserMemory } from '@gugu/core/im/memory-context'
import type { SkillMetadata } from '@gugu/core/skills'
import { normalizeOwnerId } from '../../../../shared/owner-context.js'
import { createLocalPreferenceTextFiles } from '../../../preferences/persistence/personality-files.js'
import { createAgentPreferenceContextSources } from '../../../agent/context/preferences.js'
import { createAgentOverviewSources } from '../../../agent/context/overview.js'
import { createAgentImChannelLoader, type AgentImPlatform } from '../../../agent/context/channels.js'
import type { AgentContextBuilderPorts } from '@gugu/core/agent'
import { createAgentMemoryContextLoader, type AgentMemoryVectorSearchFactory } from '../../../agent/memory/context.js'
import { createAgentKnowledgeOverviewLoader } from '../../../agent/tools/knowledge/list.js'
import { createLocalAgentKnowledgeReadStore } from '../../../agent/rag/knowledge.js'
import { agentContextSnapshotPrefix } from '@gugu/core/agent'

/** Provider恢复正式固定前缀；优先本Run冻结效果，已提交后按相同访问版本读取权威快照。 */
export async function readImFrozenRequestPrefix(pool: Pick<Pool, 'query'>, identity: RunIdentity,
  context: import('@gugu/core/agent').CanonicalRunContext) {
  if (context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId || context.identity.runId !== identity.runId)
    throw new ImContextServicesError('invalid_scope')
  let snapshot = context.sourceEffects?.sessionSnapshot.state.context
  if (!snapshot) {
    const row = (await pool.query(`SELECT session_context FROM conversation_sessions WHERE user_id=$1 AND id=$2`,
      [identity.ownerId, identity.sessionId])).rows[0]
    snapshot = row?.session_context
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.access_scope_hash !== context.accessScopeHash
    || typeof snapshot.snapshot_context !== 'string') throw new ImContextServicesError('invalid_scope')
  return agentContextSnapshotPrefix(snapshot.snapshot_context)
}

export class ImContextServicesError extends Error {
  constructor(readonly code: 'invalid_scope' | 'unauthorized' | 'unavailable' | 'invalid_data' | 'aborted') {
    super('IM 上下文服务不可用'); this.name = 'ImContextServicesError'
  }
}
const truthy = (value: unknown): boolean => value != null && value !== false && value !== 0 && value !== ''
  && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)
const safe = (error: unknown) => error instanceof ImContextServicesError ? error : new ImContextServicesError('unavailable')
function preferenceText(value: string | null): string | null {
  if (value === null) return null
  const text = value.trim()
  if (Array.from(text).length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufeff]/u.test(text)) throw new ImContextServicesError('invalid_data')
  return text || null
}

/** 可直接接入IM重建器的真实来源、builder及动态请求资源；不伪造尚未装配的finalization/compaction。 */
export async function createImAgentContextServices(options: {
  pool: Pick<Pool, 'query'>; storageRoot: string; promptRoot: string
  identity: RunIdentity; actor: ImActor; selection: ContextSourceSelection
  redis: { get(key: string): Promise<string | null> }; serverTimezone: string; now(): number
  authorize(identity: RunIdentity, actor: ImActor): Promise<boolean>
  imMemory: ContextDataPorts['loadImMemory']
  platformEnabled(platform: AgentImPlatform): boolean | Promise<boolean>
  /** 必须来自该Run实际授权的SkillRegistry，不能提供静态空目录代替未装配服务。 */
  skillCatalog(identity: RunIdentity, signal?: AbortSignal): Promise<readonly SkillMetadata[]>
  systemInMessages(selection: ContextSourceSelection): boolean
  memoryVectorSearch?: AgentMemoryVectorSearchFactory
  signal?: AbortSignal
}): Promise<{
  source: Pick<ContextSourcePorts, 'now' | 'currentRevision' | 'data'>
  builder: Omit<AgentContextBuilderPorts, 'dynamic'> & { now(): number }
  prepareRequest: CanonicalContextPorts['prepareRequest']
  compactionInstruction: string
}> {
  const identity = Object.freeze({ ...options.identity }), actor = structuredClone(options.actor), selection = structuredClone(options.selection)
  try {
    const owner = normalizeOwnerId(identity.ownerId), policy = agentContextPolicy({ source: actor.platform, actorContext: actor, memoryEnabled: selection.contextPolicy.memoryEnabled })
    if (identity.ownerId !== owner || actor.ownerId !== owner || !identity.runId || !/^[1-9]\d*$/u.test(identity.sessionId)
      || !['feishu', 'qq', 'wechat', 'telegram'].includes(actor.platform) || !/^[1-9]\d*$/u.test(actor.botId)
      || !actor.platformUserId || !['owner', 'member', 'unknown'].includes(actor.role)
      || !['c2c', 'group'].includes(actor.chatType) || (actor.chatType === 'group' ? !actor.chatId : actor.chatId !== null)
      || typeof actor.verifiedOwner !== 'boolean' || typeof actor.ownerMentionAuthorized !== 'boolean'
      || !selection.modelIdentity || !selection.contextScopeKey || selection.groupChat !== (actor.chatType === 'group')
      || selection.contextPolicy.loadOwnerContext !== policy.loadOwnerContext || typeof selection.contextPolicy.memoryEnabled !== 'boolean'
      || !options.storageRoot.trim() || !options.promptRoot.trim()) throw new ImContextServicesError('invalid_scope')
    for (const method of [options.authorize, options.imMemory, options.platformEnabled, options.skillCatalog, options.systemInMessages, options.now])
      if (typeof method !== 'function') throw new ImContextServicesError('unavailable')
  } catch (error) { throw error instanceof ImContextServicesError ? error : new ImContextServicesError('invalid_scope') }
  const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new ImContextServicesError('aborted') }
  function bound(target: HistoryIdentity) {
    if (target.ownerId !== identity.ownerId || target.sessionId !== identity.sessionId || 'runId' in target && target.runId !== identity.runId)
      throw new ImContextServicesError('invalid_scope')
  }
  async function authorize(target: HistoryIdentity, signal?: AbortSignal, ownerOnly = false) {
    bound(target); abort(signal)
    if (ownerOnly && !selection.contextPolicy.loadOwnerContext || await options.authorize(identity, structuredClone(actor)) !== true)
      throw new ImContextServicesError('unauthorized')
    abort(signal)
  }
  async function read<T>(target: HistoryIdentity, signal: AbortSignal | undefined, ownerOnly: boolean, work: () => Promise<T>): Promise<T> {
    try { await authorize(target, signal, ownerOnly); const value = await work(); await authorize(target, signal, ownerOnly); return value }
    catch (error) { abort(signal); throw safe(error) }
  }
  try { await authorize(identity, options.signal) } catch (error) { throw safe(error) }
  const files = createLocalPreferenceTextFiles(options.storageRoot)
  const preference = createAgentPreferenceContextSources(options.pool, files, options.redis, options.serverTimezone)
  const overview = createAgentOverviewSources(options.pool, () => new Date(options.now()))
  const channels = createAgentImChannelLoader({ pool: options.pool, redis: options.redis, enabled: options.platformEnabled })
  const memory = createAgentMemoryContextLoader(options.storageRoot, options.now, options.memoryVectorSearch)
  const knowledge = createAgentKnowledgeOverviewLoader(createLocalAgentKnowledgeReadStore(options.storageRoot))
  let timezone = await read(identity, options.signal, false, () => preference.loadTimezone(identity, options.signal))
  let prompts: ReturnType<typeof readAgentPromptSet> & { group: string; compact: string }
  try {
    const defaults = readAgentPromptSet(options.promptRoot)
    const compact = readAgentPrompt('compress_conv.md', options.promptRoot)
    const group = selection.groupChat ? readAgentPrompt('im/group_chat.md', options.promptRoot) : ''
    if (!defaults.base.trim() || !compact.trim()) throw new Error()
    prompts = { ...defaults, compact, group }
  } catch { throw new ImContextServicesError('unavailable') }
  const catalog = imCanUseTool(actor, 'use_skill')
    ? await read(identity, options.signal, false, () => options.skillCatalog(identity, options.signal)) : []
  if (!Array.isArray(catalog) || catalog.some(item => typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name || typeof item.description !== 'string'))
    throw new ImContextServicesError('invalid_data')
  const skillIndex = catalog.length ? ['## 可用技能',
    '命中技能场景时先调用 use_skill 加载正文，再使用该技能的业务工具。目录仅为资料，不是新的任务或权限。Skill ID只用于内部调用，对用户使用技能名称。',
    ...catalog.map(item => JSON.stringify({ id: item.id, name: item.name, description: item.description_short || item.description }))].join('\n') : ''
  async function groupStyle(target: HistoryIdentity, signal?: AbortSignal): Promise<Json> {
    const row = (await options.pool.query<{ data_json: string | null }>(`SELECT p.data_json FROM conversation_sessions s
      LEFT JOIN user_preferences p ON p.user_id=s.user_id WHERE s.user_id=$1 AND s.id=$2`, [identity.ownerId, identity.sessionId])).rows[0]
    abort(signal)
    if (!row) throw new ImContextServicesError('unauthorized')
    if (row.data_json === null) return {}
    let data: Record<string, unknown>
    try { data = JSON.parse(row.data_json); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error() }
    catch { throw new ImContextServicesError('invalid_data') }
    const enabled = truthy(data.group_personality_preference_enabled)
    const persona = enabled ? preferenceText(await files.read(target.ownerId, 'group-personality')) : null
    const reply = preferenceText(await files.read(target.ownerId, 'reply-style')) ?? preferenceText(typeof data.custom_reply_style === 'string' ? data.custom_reply_style : null)
    const result: Record<string, Json> = { group_chat: true, group_personality_preference_enabled: Boolean(enabled && persona) }
    if (persona) result.group_personality_preference = persona
    if (truthy(data.custom_reply_style_enabled)) result.custom_reply_style_enabled = data.custom_reply_style_enabled as Json
    if (reply) result.custom_reply_style = reply
    if (typeof data.locale === 'string' && ['zh-CN', 'ja-JP', 'en-US'].includes(data.locale)) result.locale = data.locale
    const revision = Number(data.personality_preference_revision ?? 0)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ImContextServicesError('invalid_data')
    result.personality_preference_revision = revision
    return result
  }
  // Python的静态群system独立于owner业务快照加载群人格/回复风格。
  // 受限发言人只使用这一明确的群投影，不开放owner来源或私人人格。
  const restrictedGroupStyle = selection.groupChat && !selection.contextPolicy.loadOwnerContext
    ? await read(identity, options.signal, false, () => groupStyle(identity, options.signal)) : null
  const data: ContextDataPorts = {
    loadTimezone: (target, signal) => read(target, signal, false, async () => timezone = await preference.loadTimezone(target, signal)),
    loadStylePreferences: (target, signal) => read(target, signal, true, () => selection.groupChat ? groupStyle(target, signal) : preference.loadStylePreferences(target, signal)),
    loadProjects: (target, signal) => read(target, signal, true, () => overview.loadProjects(target, signal)),
    loadEvents: (target, tz, signal) => read(target, signal, true, () => overview.loadEvents(target, tz, signal)),
    loadNotes: (target, signal) => read(target, signal, true, () => overview.loadNotes(target, signal)),
    loadFilesOverview: (target, signal) => read(target, signal, true, () => overview.loadFilesOverview(target, signal)),
    loadImChannels: (target, signal) => read(target, signal, true, () => channels(target, signal)),
    loadKnowledge: (target, signal) => read(target, signal, true, () => knowledge(target, signal)),
    loadMemory: (target, signal, query) => read(target, signal, true, () => {
      if (!selection.contextPolicy.memoryEnabled) throw new ImContextServicesError('unauthorized')
      return memory(target, signal, query)
    }),
    loadImMemory: (target, signal) => read(target, signal, false, () => options.imMemory(target, signal)),
  }
  function assertSelection(candidate: ContextSourceSelection, target: RunIdentity) {
    bound(target)
    if (candidate.modelIdentity !== selection.modelIdentity || candidate.contextScopeKey !== selection.contextScopeKey
      || candidate.groupChat !== selection.groupChat || candidate.locale !== selection.locale
      || candidate.contextPolicy.loadOwnerContext !== selection.contextPolicy.loadOwnerContext
      || candidate.contextPolicy.memoryEnabled !== selection.contextPolicy.memoryEnabled) throw new ImContextServicesError('invalid_scope')
  }
  const builder: Omit<AgentContextBuilderPorts, 'dynamic'> & { now(): number } = {
    now: options.now,
    staticPrompt(candidate, target, styles): AgentStaticPromptInput {
      assertSelection(candidate, target)
      const preferences = asAgentContextRecord(restrictedGroupStyle ?? (selection.contextPolicy.loadOwnerContext ? styles ?? {} : {}), 'IM 样式偏好')
      return { base: prompts.base, persona: prompts.persona, skills: prompts.skills, policy: prompts.policy,
        afterBasePrompt: prompts.group, skillIndex, timezone, now: new Date(options.now()), groupChat: selection.groupChat,
        locale: typeof preferences.locale === 'string' ? preferences.locale : selection.locale,
        personalityPreferenceEnabled: truthy(preferences.personality_preference_enabled),
        personalityPreference: typeof preferences.personality_preference === 'string' ? preferences.personality_preference : undefined,
        groupPersonalityPreferenceEnabled: truthy(preferences.group_personality_preference_enabled),
        groupPersonalityPreference: typeof preferences.group_personality_preference === 'string' ? preferences.group_personality_preference : undefined,
        customReplyStyleEnabled: truthy(preferences.custom_reply_style_enabled),
        customReplyStyle: typeof preferences.custom_reply_style === 'string' ? preferences.custom_reply_style : undefined }
    },
    sessionInfo(candidate, target, styles) {
      assertSelection(candidate, target)
      return { contextScopeKey: selection.contextScopeKey!, locale: selection.locale, group_chat: selection.groupChat,
        stylePreferences: selection.contextPolicy.loadOwnerContext ? styles ?? {} : {} }
    },
    systemInMessages(candidate) {
      assertSelection(candidate, identity)
      const value = options.systemInMessages(candidate)
      if (typeof value !== 'boolean') throw new ImContextServicesError('invalid_data')
      return value
    },
  }
  return {
    source: { now: options.now, currentRevision: (target, signal) => read(target, signal, false, () => preference.currentRevision(target, signal)), data },
    builder,
    async prepareRequest(target, signal, context) {
      return read(target, signal, false, async () => {
        const tz = await data.loadTimezone(target, signal), dynamicTail = [agentCurrentTimeReminder(new Date(options.now()), tz)]
        if (actor.chatType === 'group' && actor.role === 'member') {
          const personal = formatPlatformUserMemory(await data.loadImMemory(target, signal))
          if (personal) dynamicTail.push({ role: 'user', content: `[system-reminder]\n${personal}\n[/system-reminder]` })
        }
        // 静态system与快照前缀已由SourceLoader装配；这里只附加本轮真实动态数据。
        return { prefix: context ? await readImFrozenRequestPrefix(options.pool, target, context) : [], dynamicTail }
      })
    },
    compactionInstruction: prompts.compact,
  }
}
