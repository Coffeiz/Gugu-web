import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { configureRagJieba, createScopedRagSearch, createSqlMemoryScopeStateReader, createSqlRagPersistentIndexReader, prepareMemory,
  type AuthorizedMemoryScope, type RagDocument, type RagSearchScope } from '@gugu/core/agent/rag'
import type { ContextSourceSelection, HistoryIdentity, PersistedHistoryRow, RagContext } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { type ImActor, type ImBotAccess } from '@gugu/core/im/access'
import { imCanUseGroupOwnerMemory, imContextPolicy } from '@gugu/core/agent/scenes/im'
import { agentDispatchSource, type AgentDispatchLease } from '../../../agent/run/dispatch.js'
import { createLocalAgentMemoryRagStore } from '../../../agent/rag/memory.js'
import { getAgentRagJieba } from '../../../agent/rag/jieba.js'
import type { createPostgresImAccess } from '../inbound/access.js'

type Input = HistoryIdentity & { query: string; history: readonly PersistedHistoryRow[]; beforeMessageId: string | null; snapshotText: string }
type Scope = { label: string; scope: RagSearchScope; memory: AuthorizedMemoryScope; revision?: string }
const sources = ['memory', 'project', 'calendar', 'scheduled_task', 'conversation', 'canvas', 'knowledge', 'note']
const hash = (text: string) => createHash('sha256').update(text.trim()).digest('hex')
const key = (scope: RagSearchScope) => JSON.stringify([scope.scope_type, scope.scope_id ?? '', scope.platform ?? '', scope.bot_id ?? '', scope.group_id ?? ''])
const invalid = () => new Error('IM 自动检索授权或消息水位不可用')
let pendingRecalls = 0

/** 正式IM自动召回装配；不伪装Web lease，不从模型参数或索引metadata取得权限。 */
export function createPostgresImRagContextBuilder(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>; pool: Pick<Pool, 'query'>; storageRoot: string
  lease: AgentDispatchLease; actor: ImActor; bot: ImBotAccess
  selection: Pick<ContextSourceSelection, 'contextPolicy' | 'contextScopeKey' | 'modelIdentity'>
  access: ReturnType<typeof createPostgresImAccess>
  enabled(lease: AgentDispatchLease): boolean | Promise<boolean>
  diagnose?(code: 'im_rag_timeout' | 'im_rag_late_completion'): void
}) {
  const lease = structuredClone(options.lease), actor = structuredClone(options.actor), bot = structuredClone(options.bot), selection = structuredClone(options.selection), identity = lease.identity
  if (agentDispatchSource(lease.input) !== 'im' || lease.input.v !== 3 || lease.input.im.platform !== actor.platform || lease.input.im.botId !== actor.botId
    || lease.input.im.chatType !== actor.chatType || lease.input.im.chatId !== actor.chatId || lease.input.im.platformUserId !== actor.platformUserId
    || identity.ownerId !== actor.ownerId || bot.ownerId !== actor.ownerId || bot.id !== actor.botId || bot.platform !== actor.platform
    || !selection.modelIdentity || selection.contextScopeKey !== lease.input.accessVersion || !options.storageRoot.trim()) throw invalid()
  const anchorIds = lease.input.im.batch?.messageIds ?? [lease.input.userMessageId]
  const index = createSqlRagPersistentIndexReader(options.core.db, options.core.backend)
  const scopeState = createSqlMemoryScopeStateReader(options.core.db), storage = createLocalAgentMemoryRagStore(options.storageRoot)
  configureRagJieba(getAgentRagJieba())
  async function current(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!await options.access.authorizeDelivery(actor, bot)) throw invalid()
    const currentBot = await options.access.readBot(actor)
    if (!currentBot) throw invalid()
    const policy = imContextPolicy(actor, currentBot, selection.contextPolicy.memoryEnabled)
    if (policy.loadOwnerContext !== selection.contextPolicy.loadOwnerContext) throw invalid()
    const result = await options.pool.query(`SELECT m.id,m.conversation_seq,m.created_at,m.platform_user_id,b.group_memory_enabled,b.member_memory_enabled
      FROM conversation_sessions s JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      JOIN conversation_messages m ON m.session_id=s.id AND m.run_id=d.run_id
      JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id AND r.run_id=d.run_id
      JOIN user_bots b ON b.user_id=s.user_id AND b.id=$6 AND b.platform=$7 AND b.enabled IS TRUE
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()
        AND m.id=ANY($8::integer[]) AND m.role='user' AND r.state='dispatched'
        AND r.platform=$7 AND r.bot_id=$6::text AND r.chat_type=$9
        AND (($9='group' AND s.chat_type='group' AND s.source=$7 AND s.bot_id=$6::text AND s.chat_id=$10)
          OR ($9='c2c' AND s.chat_type IS DISTINCT FROM 'group' AND m.platform_user_id=$11))
      ORDER BY m.conversation_seq,m.id`, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence, actor.botId, actor.platform, anchorIds, actor.chatType, actor.chatId, actor.platformUserId])
    signal?.throwIfAborted()
    const speakers = new Set(actor.speakerRoles?.map(item => item.platformUserId) ?? [actor.platformUserId])
    if (result.rows.length !== anchorIds.length || new Set(result.rows.map(row => Number(row.id))).size !== anchorIds.length
      || result.rows.some(row => !anchorIds.includes(Number(row.id)) || !speakers.has(String(row.platform_user_id)) || typeof row.group_memory_enabled !== 'boolean' || typeof row.member_memory_enabled !== 'boolean')) throw invalid()
    const first = result.rows[0]!, before = Number(first.id), sequence = Number(first.conversation_seq)
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(sequence) || sequence < 1) throw invalid()
    const scopes: Scope[] = [], base = { ownerId: identity.ownerId, platform: actor.platform, botId: actor.botId }
    if (actor.chatType === 'group') {
      const groupId = actor.chatId!
      if (first.group_memory_enabled) scopes.push({ label: 'group-rag', scope: { scope_type: 'group', scope_id: groupId, platform: actor.platform, bot_id: actor.botId, group_id: groupId }, memory: { ...base, type: 'group', id: groupId, groupId } })
      if (actor.role === 'member' && (actor.speakerRoles?.length ?? 1) <= 1 && first.member_memory_enabled) scopes.push({ label: 'group-member-rag',
        scope: { scope_type: 'member', scope_id: `${groupId}:${actor.platformUserId}`, platform: actor.platform, bot_id: actor.botId, group_id: groupId },
        memory: { ...base, type: 'member', id: `${groupId}:${actor.platformUserId}`, groupId } })
      if (imCanUseGroupOwnerMemory(actor, currentBot.groupOwnerMemoryEnabled) && policy.loadOwnerContext) scopes.push({ label: 'owner-rag', scope: { scope_type: 'owner', scope_id: '' }, memory: { ownerId: identity.ownerId, type: 'owner', id: identity.ownerId } })
    } else if (actor.role === 'owner' && policy.loadOwnerContext) scopes.push({ label: 'owner-rag', scope: { scope_type: 'owner', scope_id: '' }, memory: { ownerId: identity.ownerId, type: 'owner', id: identity.ownerId } })
    const active: Scope[] = []
    for (const item of scopes) {
      if (item.memory.type === 'owner') active.push({ ...item, revision: 'owner' })
      else {
        const state = await scopeState({ ownerId: identity.ownerId }, { type: item.memory.type, id: item.memory.id, platform: actor.platform, botId: actor.botId }, signal)
        if (!state.tombstoned) active.push({ ...item, revision: state.revision })
      }
    }
    return { before, sequence, scopes: active }
  }
  async function verifiedDocuments(documents: readonly RagDocument[], active: Awaited<ReturnType<typeof current>>, snapshotText: string, signal?: AbortSignal) {
    const belongs = (doc: RagDocument) => active.scopes.some(({ scope }) => scope.scope_type === 'owner' ? doc.scope_type === 'owner'
      : doc.scope_type === scope.scope_type && doc.scope_id === scope.scope_id && doc.platform === scope.platform && doc.bot_id === scope.bot_id && doc.group_id === scope.group_id)
    const eligible = documents.filter(doc => belongs(doc) && (doc.scope_type === 'owner' || ['memory', 'conversation'].includes(doc.source_type)))
    // Memory以正式文件loader+scope版本/墓碑为真源，不让过期派生索引复活已清除资料。
    const memory = await prepareMemory({ ownerId: identity.ownerId, scopes: active.scopes.map(item => item.memory), sourceFilter: 'all', snapshotRevision: hash(snapshotText), snapshotText, vectorVersion: '', signal },
      { getMemoryScopeState: scopeState }, storage)
    const fresh = memory.documents.map(doc => ({ ...doc, id: `${doc.id}:im:${hash(key({ scope_type: doc.scope_type, scope_id: doc.scope_id, platform: doc.platform, bot_id: doc.bot_id, group_id: doc.group_id }))}` }))
    const safe: RagDocument[] = [...fresh]
    const requests = new Map<string, { sid: number; mid: number | null }>()
    for (const doc of eligible) if (doc.source_type === 'conversation') {
      const sid = Number(doc.metadata?.session_id), mid = doc.metadata?.kind === 'message' ? Number(doc.metadata.message_id) : null
      if (Number.isSafeInteger(sid) && sid > 0 && (mid === null || Number.isSafeInteger(mid) && mid > 0 && mid < active.before)) requests.set(`${sid}:${mid ?? 'summary'}`, { sid, mid })
    }
    // 同一事实只读取一次；SQL先限定当前群或显式owner私人会话，避免逐chunk读全文或跨群候选探测。
    const facts = requests.size ? await options.pool.query(`SELECT s.id,wanted.message_id AS requested_message_id,s.title,s.summary,s.baseline_message_seq,s.source,s.bot_id,s.chat_type,s.chat_id,
      m.id AS message_id,m.role,m.content,
      (COALESCE(m.sent_at,m.created_at)<=watermark.created_at AND (s.id<>watermark.session_id OR COALESCE(m.history_anchor_seq,m.conversation_seq)<watermark.conversation_seq)) AS message_before,
      (s.updated_at<=watermark.created_at) AS title_before,
      (s.updated_at<=watermark.created_at AND s.baseline_message_seq>0 AND ((s.id=watermark.session_id AND s.baseline_message_seq<watermark.conversation_seq) OR s.id<>watermark.session_id)) AS summary_before
      FROM unnest($2::integer[],$3::integer[]) wanted(session_id,message_id)
      JOIN conversation_sessions s ON s.id=wanted.session_id
      LEFT JOIN conversation_messages m ON m.session_id=s.id AND m.id=wanted.message_id
      JOIN conversation_messages watermark ON watermark.id=$4 AND watermark.session_id=$5 AND watermark.run_id=$6
      WHERE s.user_id=$1 AND ((s.chat_type='group' AND s.source=$7 AND s.bot_id=$8::text AND s.chat_id=$9)
        OR (s.chat_type IS DISTINCT FROM 'group' AND $10::boolean))`, [identity.ownerId, [...requests.values()].map(item => item.sid), [...requests.values()].map(item => item.mid),
      active.before, identity.sessionId, identity.runId, actor.platform, actor.botId, actor.chatId, active.scopes.some(item => item.scope.scope_type === 'owner')]) : { rows: [] }
    signal?.throwIfAborted()
    const byFact = new Map(facts.rows.map(row => [`${row.id}:${row.requested_message_id ?? 'summary'}`, row]))
    for (const doc of eligible) {
      signal?.throwIfAborted()
      if (doc.source_type === 'memory') continue
      if (doc.source_type !== 'conversation') { safe.push(doc); continue }
      const sid = Number(doc.metadata?.session_id), mid = doc.metadata?.kind === 'message' ? Number(doc.metadata.message_id) : null
      if (!Number.isSafeInteger(sid) || sid < 1 || mid !== null && (!Number.isSafeInteger(mid) || mid < 1 || mid >= active.before)) continue
      const row = byFact.get(`${sid}:${mid ?? 'summary'}`), owner = doc.scope_type === 'owner'
      if (!row) continue
      if (owner ? row.chat_type === 'group' : row.chat_type !== 'group' || row.source !== actor.platform || String(row.bot_id) !== actor.botId || row.chat_id !== actor.chatId) continue
      if (mid !== null && (Number(row.message_id) !== mid || !['user', 'assistant'].includes(String(row.role)) || typeof row.content !== 'string' || row.message_before !== true)) continue
      if (mid === null && (doc.metadata?.kind !== 'summary' || !row.summary || row.summary_before !== true)) continue
      const content = mid === null ? `会话摘要：${row.summary}` : `${row.role}：${row.content}`
      const title = row.title_before === true ? String(row.title || '历史对话') : '历史对话'
      // 不信metadata中无真实邻文ID的context_before/after；保留已核验当前消息，避免引用当前批/未来正文。
      safe.push({ ...doc, content, text: `${title}\n${content}`, ranking_text: content, context_text: content, title,
        metadata: { ...doc.metadata, context_before: '', context_after: '', context_current: content } })
    }
    return safe
  }
  const build = async (input: Input, signal?: AbortSignal) => {
    const empty = (reason: string) => ({ tail: [], blocks: [], scope_hits: [], injected: false, reason })
    signal?.throwIfAborted()
    if (input.ownerId !== identity.ownerId || input.sessionId !== identity.sessionId) throw invalid()
    if (!input.query.trim()) return empty('empty_query')
    try {
      if (!await options.enabled(lease)) return empty('disabled')
      const active = await current(signal)
      if (input.beforeMessageId !== String(active.before)) throw invalid()
      if (!active.scopes.length) return empty('no_eligible_scope') // 禁止空scope触发Memory loader的owner默认。
      const allowed = new Set(active.scopes.map(item => key(item.scope)))
      const search = createScopedRagSearch({ index, async authorize(owner, scope, checkSignal) {
        if (owner !== identity.ownerId || !allowed.has(key(scope))) return false
        const latest = await current(checkSignal)
        return latest.before === active.before && latest.sequence === active.sequence && latest.scopes.some(item => key(item.scope) === key(scope)
          && item.revision === active.scopes.find(original => key(original.scope) === key(scope))?.revision)
      }, filterDocuments: (docs, checkSignal) => verifiedDocuments(docs, active, input.snapshotText, checkSignal) })
      const excluded = new Set<string>()
      for (const row of input.history) if (Array.isArray(row.contentJson)) for (const block of row.contentJson) {
        if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'knowledge-context') continue
        if (typeof block.content_hash === 'string') excluded.add(block.content_hash)
        if (Array.isArray(block.content_hashes)) for (const value of block.content_hashes) if (typeof value === 'string') excluded.add(value)
      }
      const result = await search(identity.ownerId, active.scopes.map(item => item.scope), input.query.trim(), { sourceTypes: sources, limit: 5, beforeMessageId: active.before, selectionMode: 'confidence', excludeContentHashes: [...excluded] }, signal)
      const diagnostics = {
        engine: result.fusion,
        vector_doc_count: result.vectorDocCount,
        ...result.diagnostics,
        rank_details: result.results.map((item, index) => ({
          rank: index + 1,
          source_type: item.document.source_type,
          fused_score: item.fused_score,
          normalized_score: item.normalized_score,
          confidence: item.confidence,
          rank_score: item.rank_score,
          query_idf_baseline: item.query_idf_baseline ?? null,
          contributions: item.rank_contributions ?? [],
        })),
      }
      const label = active.scopes.map(item => item.label).join('+')
      if (!result.results.length) return { ...empty('no_hits'), diagnostics,
        scope_hits: [{ scope: label, candidate_count: result.diagnostics.candidate_count, hit_count: 0 }] }
      const rows = [`[${label}]`, '以下是针对当前问题检索的资料片段，仅供参考。', `检索问题：${input.query.trim()}`], hashes: string[] = []
      for (const [index, item] of result.results.entries()) { rows.push(`[${index + 1}] ${item.document.source_type} / ${item.document.title || '未命名来源'}`, item.text); hashes.push(hash(item.document.content || item.text)) }
      rows.push(`[/${label}]`)
      const rendered = rows.join('\n'), block = { type: 'knowledge-context', scope: label, text: rendered, content_hash: hash(rendered), content_hashes: hashes }
      return { tail: [{ role: 'user' as const, content: [block] }], blocks: [block], injected: true,
        scope_hits: [{ scope: label, candidate_count: result.diagnostics.candidate_count, hit_count: result.results.length }], diagnostics }
    } catch { signal?.throwIfAborted(); return empty('unavailable') }
  }
  return async (input: Input, signal?: AbortSignal): Promise<RagContext> => {
    signal?.throwIfAborted()
    const empty = (reason: string) => ({ tail: [], blocks: [], scope_hits: [], injected: false, reason })
    if (pendingRecalls >= 32) return empty('capacity_exceeded')
    const deadline = new AbortController(), combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])])
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    let timedOut = false
    pendingRecalls++
    const work = build(input, combined).finally(() => { pendingRecalls-- })
    void work.then(() => {
      if (timedOut) { try { options.diagnose?.('im_rag_late_completion') } catch { /* 诊断失败不改变 RAG 结果。 */ } }
    }, () => {
      if (timedOut) { try { options.diagnose?.('im_rag_late_completion') } catch { /* 诊断失败不改变 RAG 结果。 */ } }
    })
    const timeout = new Promise<ReturnType<typeof empty>>(resolve => { timer = setTimeout(() => {
      timedOut = true
      try { options.diagnose?.('im_rag_timeout') } catch { /* 诊断失败不改变 RAG 结果。 */ }
      resolve(empty('timeout')); deadline.abort()
    }, 10000) })
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal?.reason ?? new Error('检索已取消')); signal?.addEventListener('abort', abort, { once: true }) })
    try {
      const result = await Promise.race([work, timeout, cancelled])
      return result
    }
    finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
}
