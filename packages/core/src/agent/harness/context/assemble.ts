
import type { Block,CanonicalHarnessContext,CanonicalMessage,CompactionResult,CurrentUser,EntryInput,FrozenProviderRequest,Json,PersistedHistoryRow,PrepareContextInput,PreparedContext,RagContext,RunIdentity,ToolCall,ToolResult } from '../contracts.js'
import { HarnessError,isEarlyExit } from '../contracts.js'
import { collapseConsumedImage,createToolResultCheckpoint,hasInitialInlineImage,restorePreparedContext,savePreparedContext } from '../history/attachment-refs.js'
import { appendCanonicalEvents,blocks,canonicalizeMessage,canonicalToolRound,copy,mediaTypes,MessageArea,portableSnapshot,redactToolRequestHeaders,refreshCanonicalToolSchemas } from '../history/canonical-history.js'
import { hasOnlyLegacyTimeContext,isInternalUserMessage,lastUserIndex,protectedMessageIds,restoreHistoryForRequest,userTextFromMessage,validateHistoryRows } from '../history/ordering.js'
import type { CanonicalContextPorts,ContextPort,ContextServices,PreparationPorts } from '../ports.js'
import { enforceProviderOverflow,shouldCompact } from './budget.js'
import { applyCompaction,compactContext } from './compaction.js'
import { assertRunCapabilities } from './prepare.js'

export function rawUserText(user: CurrentUser): string {
  if (user.message.role !== 'user' || isInternalUserMessage(user.message))
    return ''
  if (user.rawText !== undefined) {
    if (typeof user.rawText !== 'string')
      throw new Error('当前用户原文必须是字符串')
    return user.rawText
  }
  const unwrap = (text: string): string => {
    if (/^\s*\[system-reminder\][\s\S]*\[\/system-reminder\]\s*$/u.test(text))
      return ''
    return text.replace(/^\s*【消息时间】[^\n]*\n【消息正文】\n|^\s*【消息正文】\n/u, '')
  }
  return unwrap(userTextFromMessage(user.message))
}

export function currentRunQuery(input: Pick<PrepareContextInput, 'query' | 'currentUser' | 'currentUsers'>): string {
  if (input.query !== undefined) {
    if (typeof input.query !== 'string')
      throw new Error('本轮RAG查询必须是字符串')
    return input.query
  }
  // 批次与单条是两种入口，不能把同一当前用户再拼一次；相同正文的独立群消息不去重。
  if (input.currentUsers?.length)
    return input.currentUsers.map(rawUserText).filter(Boolean).join('\n')
  return input.currentUser ? rawUserText(input.currentUser) : ''
}

export function inlineMessageTime(content: Json, time?: string | null): Json {
  const value = (time ?? '').trim().replace(/^\[system-reminder\]\s*|\s*\[\/system-reminder\]$/g, '').replace(/^消息时间：/, '').trim()
  const prefix = value ? `【消息时间】${value}\n` : ''
  const wrapped = (text: string): boolean => text.trimStart().startsWith('【消息正文】')
    || (text.includes('【消息正文】') && (text.trimStart().startsWith('【消息时间】') || text.includes('【群消息】')))
  if (typeof content === 'string')
    return wrapped(content) ? prefix + content : `${prefix}【消息正文】\n${content}`
  if (Array.isArray(content)) {
    const first = blocks(content).find(block => block.type === 'text')
    if (first && wrapped(String(first.text ?? '')))
      return [...(prefix ? [{ type: 'text', text: prefix }] : []), ...copy(content)]
    return [{ type: 'text', text: `${prefix}【消息正文】\n` }, ...copy(content)]
  }
  return content && typeof content === 'object'
    ? [{ type: 'text', text: `${prefix}【消息正文】\n` }, copy(content)] : `${prefix}【消息正文】\n${content ?? ''}`
}

export function persistedStance(rows: readonly PersistedHistoryRow[], services: ContextServices): string | null {
  for (const row of [...rows].reverse())
    for (const block of blocks(row.contentJson).reverse())
      if (block.type === 'stance-context') {
        const stored = String(block.digest ?? '').trim()
        if (stored)
          return stored
        const text = String(block.text ?? '').replace(/^\[system-reminder\]\s*|\s*\[\/system-reminder\]$/g, '').trim()
        return text ? services.digest(text) : ''
      }
  return null
}

export function effectiveRunHistory(input: PrepareContextInput): {
  history: PersistedHistoryRow[]
  currentId: string | null
} {
  validateHistoryRows(input, input.history)
  const currentId = input.resumeInteraction ? null : input.currentUser?.persistedMessageId ?? null
  const history = input.history.filter(row => !hasOnlyLegacyTimeContext(row)
    && (input.currentUsersInHistory || currentId == null || row.id !== currentId))
  return { history, currentId }
}

/** 可与工具发现并行执行；与主prepare共享历史/当前水位规则，preparedRag不会再次召回。 */
export async function buildRunRagContext(input: PrepareContextInput, ports: PreparationPorts, signal?: AbortSignal): Promise<RagContext> {
  signal?.throwIfAborted()
  const { history, currentId } = effectiveRunHistory(input)
  if (input.entryKind === 'scheduled_task') {
    if (input.history.length || input.currentUsersInHistory || input.resumeInteraction)
      throw new HarnessError('invalid_state', '定时任务不能继承交互会话历史或交互等待')
    return { tail: [] }
  }
  const rag = input.preparedRag ?? await ports.buildRag({
    ownerId: input.ownerId, sessionId: input.sessionId,
    query: currentRunQuery(input), history: copy(history), beforeMessageId: currentId, snapshotText: input.snapshotText ?? ''
  }, signal)
  signal?.throwIfAborted()
  return rag
}

export async function prepareContext(input: PrepareContextInput, ports: PreparationPorts, signal?: AbortSignal): Promise<PreparedContext> {
  signal?.throwIfAborted()
  const { history } = effectiveRunHistory(input)
  const rag = await buildRunRagContext(input, ports, signal)
  const restored = history.map(row => ({
    row, message: restoreHistoryForRequest(row, {
      groupChat: input.groupChat, userTimezone: input.userTimezone,
      formatMessageTime: ports.formatMessageTime, allowHistoricalImages: input.allowHistoricalImages
    })
  })).filter((entry): entry is {
    row: PersistedHistoryRow
    message: CanonicalMessage
  } => entry.message != null)
  const area = new MessageArea(ports, restored.map(entry => entry.message))
  const prefix = copy([...input.fixedPrefix])
  if (input.systemInMessages && input.systemPrompt)
    prefix.unshift({ role: 'system', content: input.systemPrompt })
  area.configureRequest(prefix)
  const protectedIds = protectedMessageIds(history)
  const start = restored.findIndex(entry => protectedIds.has(entry.row.id))
  area.protectedHistoryStart = start >= 0 ? prefix.length + start : null
  const previous = persistedStance(input.history, ports) ?? input.previousStanceDigest ?? ''
  const stance = input.stance?.trim() ?? ''
  const stanceDigest = stance ? ports.digest(stance) : ''
  const entries: EntryInput[] = []
  if (stance && stanceDigest !== previous)
    entries.push({
      source: 'stance', persistencePolicy: 'commit_on_success',
      message: { role: 'user', content: [{ type: 'stance-context', digest: stanceDigest, text: `[system-reminder]\n${input.stance}\n[/system-reminder]` }] }
    })
  for (const message of rag.tail)
    entries.push({ message, source: 'rag', persistencePolicy: 'commit_on_success' })
  if (!input.resumeInteraction && !input.currentUsersInHistory) {
    const users = input.currentUsers?.length ? input.currentUsers : input.currentUser ? [input.currentUser] : []
    for (const user of users) {
      if (!['user', 'system'].includes(user.message.role))
        throw new Error('当前用户来源不能包含assistant或tool角色')
      if (user.message.role === 'system' || isInternalUserMessage(user.message)) {
        const reference = user.message.role === 'user' && blocks(user.message.content).some(block => block.type === 'knowledge-context' && block.scope === 'explicit-reference')
        entries.push({
          message: canonicalizeMessage(copy(user.message)), source: reference ? 'reference' : 'runtime',
          persistencePolicy: reference ? 'already_persisted' : 'request_only', ...(reference ? { persistedMessageId: user.persistedMessageId } : {})
        })
        continue
      }
      const message = canonicalizeMessage({ ...copy(user.message), content: inlineMessageTime(user.message.content, user.messageTime) })
      const values = blocks(message.content)
      const source = values.some(block => block.type === 'knowledge-context' && block.scope === 'explicit-reference') ? 'reference'
        : values.some(block => mediaTypes.has(block.type)) ? 'attachment' : 'user'
      entries.push({ message, source, persistencePolicy: input.entryKind === 'scheduled_task' ? 'request_only' : 'already_persisted', persistedMessageId: user.persistedMessageId })
    }
  }
  area.appendBatch(entries)
  if (input.latestToolSchemas?.length)
    refreshCanonicalToolSchemas(area, input.latestToolSchemas)
  if (input.extraReminder)
    area.setDynamicTail([{ role: 'user', content: `[system-reminder]\n${input.extraReminder}\n[/system-reminder]` }])
  return {
    area, rag: copy(rag), stanceToPersist: stanceDigest !== previous ? input.stance ?? null : null,
    protectedHistoryStart: area.protectedHistoryStart
  }
}

export function json(value: unknown): Json {
  return copy(portableSnapshot(value)) as Json
}

/** 将 Canonical/预算算法接到 Run 的持久状态转换；不在这里打开数据库或执行工具。 */
export function createCanonicalContextPort(ports: CanonicalContextPorts): ContextPort<CanonicalHarnessContext> {
  const requests = new Map<string, Promise<{
    prefix: CanonicalMessage[]
    dynamicTail: CanonicalMessage[]
  }>>()
  const mainRequests = new Map<string, {
    prepared: PreparedContext
    request: FrozenProviderRequest | null
  }>()
  const key = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
  function frozenRequest(state: CanonicalHarnessContext, prepared: PreparedContext) {
    const value = copy(ports.currentRequest(state.identity, {
      checkpointDigest: state.prepared.digest,
      modelIdentity: state.modelIdentity, accessScopeHash: state.accessScopeHash, materialized: prepared
    }))
    if (!value)
      return null
    if (value.sourceCheckpointDigest !== state.prepared.digest || value.accessScopeHash !== state.accessScopeHash)
      throw new Error('主请求快照的checkpoint或访问scope身份不匹配')
    const area = MessageArea.restore(ports, value.area)
    area.configureRequest(value.requestPrefix)
    area.setDynamicTail(value.dynamicTail)
    if (!area.matchesProjection(value.projection, state.modelIdentity))
      throw new Error('主请求投影与实际Canonical快照不匹配')
    area.protectedHistoryStart = prepared.area.protectedHistoryStart
    return { request: value, prepared: { ...prepared, area } }
  }
  function request(state: CanonicalHarnessContext, signal?: AbortSignal) {
    const id = key(state.identity)
    let pending = requests.get(id)
    if (!pending) {
      // 重启后由授权来源重建冻结快照；同进程的后续轮次不能重新生成动态前缀。
      pending = ports.prepareRequest(state.identity, signal).then(copy)
      requests.set(id, pending)
      void pending.catch(() => requests.delete(id))
    }
    return pending.then(copy)
  }
  async function restore(state: CanonicalHarnessContext, signal?: AbortSignal): Promise<PreparedContext> {
    return restorePreparedContext(state.prepared, state.identity, {
      digest: ports.digest, nextId: ports.nextId,
      prepareRequest: () => request(state, signal),
    }, ports.references, signal)
  }
  async function save(state: CanonicalHarnessContext, prepared: PreparedContext, signal?: AbortSignal): Promise<CanonicalHarnessContext> {
    prepared.protectedHistoryStart = prepared.area.protectedHistoryStart
    const checkpoint = await savePreparedContext(prepared, state.identity, ports.references, signal)
    let pendingRound = state.pendingRound
    if (pendingRound?.resultEntryId) {
      const message = checkpoint.area.entries.find((entry) => entry.entryId === pendingRound!.resultEntryId)?.message
      const stored = message ? blocks(message.content).filter((block) => block.type === 'tool_result') : []
      pendingRound = {
        ...pendingRound, dispatched: pendingRound.dispatched.map((result) => {
          const block = stored.find((item) => item.tool_call_id === result.callId)
          if (!block || !('content' in block))
            throw new Error('引用固化丢失已派发工具的结果身份')
          return { ...result, content: copy(block.content!) }
        })
      }
    }
    return { ...state, pendingRound, prepared: checkpoint }
  }
  async function toolResult(state: CanonicalHarnessContext, call: ToolCall, value: Json, round?: number, isError?: boolean): Promise<CanonicalHarnessContext> {
    const prepared = await restore(state)
    const pending = state.pendingRound
    if (!pending || round !== undefined && pending.round !== round
      || !pending.calls.some((item) => item.id === call.id && item.name === call.name))
      throw new Error('工具回执与本轮调用声明不匹配')
    const results = pending.dispatched.filter((item) => item.callId !== call.id)
    results.push({ callId: call.id, toolName: call.name, content: JSON.stringify(value), ...(isError ? { isError: true } : {}) })
    results.sort((left, right) => pending.calls.findIndex((item) => item.id === left.callId)
      - pending.calls.findIndex((item) => item.id === right.callId))
    const messages = canonicalToolRound({ text: pending.text, calls: pending.calls, dispatched: results })
    let assistantEntryId = pending.assistantEntryId, resultEntryId = pending.resultEntryId
    if (assistantEntryId && resultEntryId) {
      prepared.area.reviseEntry(assistantEntryId, messages[0]!, prepared.area.revision)
      prepared.area.reviseEntry(resultEntryId, messages[1]!, prepared.area.revision)
    }
    else {
      const entries = prepared.area.appendBatch(messages.map((message) => ({
        message,
        source: 'tool_round' as const, persistencePolicy: 'commit_on_success' as const, roundId: `round-${pending.round}`,
      })), { round: pending.round })
      assistantEntryId = entries[0]!.entryId
      resultEntryId = entries[1]!.entryId
    }
    return save({ ...state, pendingRound: { ...pending, dispatched: results, assistantEntryId, resultEntryId } }, prepared)
  }
  return {
    ...createToolResultCheckpoint(ports.references, { digest: ports.digest }),
    assertIdentity(identity, state) {
      if (state.capabilities !== null)
        assertRunCapabilities(state.capabilities)
      if (state.identity.ownerId !== identity.ownerId || state.identity.sessionId !== identity.sessionId
        || state.identity.runId !== identity.runId || state.prepared.ownerId !== identity.ownerId
        || state.prepared.sessionId !== identity.sessionId
        || typeof state.accessScopeHash !== 'string' || !state.accessScopeHash
        || state.sourceEffects !== null && (state.sourceEffects.sessionSnapshot.state.ownerId !== identity.ownerId
          || state.sourceEffects.sessionSnapshot.state.sessionId !== identity.sessionId
          || state.sourceEffects.sessionSnapshot.state.context?.access_scope_hash !== state.accessScopeHash)
        || state.providerCacheAnchor !== null && (state.providerCacheAnchor.ownerId !== identity.ownerId
          || state.providerCacheAnchor.sessionId !== identity.sessionId || state.providerCacheAnchor.modelIdentity !== state.modelIdentity))
        throw new HarnessError('not_found', '运行上下文不存在')
    },
    async prepare(identity, signal) {
      const received = await ports.load(identity, signal)
      if (isEarlyExit(received))
        return received
      const loaded = copy(received)
      if (loaded.capabilities)
        assertRunCapabilities(loaded.capabilities)
      const accessScopeHash = loaded.accessScopeHash ?? loaded.sourceEffects?.sessionSnapshot.state.context?.access_scope_hash
      if (typeof accessScopeHash !== 'string' || !accessScopeHash)
        throw new Error('上下文准备缺少可信访问scope绑定')
      if (loaded.input.ownerId !== identity.ownerId || loaded.input.sessionId !== identity.sessionId
        || !loaded.modelIdentity || !Number.isSafeInteger(loaded.contextWindow) || loaded.contextWindow < 1)
        throw new Error('准备上下文的身份或模型预算不匹配')
      // 在任何RAG/reminder/工具轮追加前固定真实current输入；之后不能盲取最后一条user消息。
      const current = loaded.input.currentUsers?.length ? loaded.input.currentUsers : loaded.input.currentUser ? [loaded.input.currentUser] : []
      const last = lastUserIndex(current.map((item) => item.message))
      const userRequest = loaded.replyContext?.userRequest ?? (last === null ? '' : current[last]!.rawText ?? userTextFromMessage(current[last]!.message))
      const locale = loaded.replyContext?.locale ?? loaded.sourceEffects?.sessionSnapshot.state.context?.locale ?? 'zh-CN'
      if (typeof userRequest !== 'string' || typeof locale !== 'string')
        throw new Error('回复策略来源必须是明确的当前用户正文与语言')
      const prepared = await prepareContext(loaded.input, { ...ports.preparation, digest: ports.digest, nextId: ports.nextId }, signal)
      requests.set(key(identity), Promise.resolve({ prefix: prepared.area.requestPrefix, dynamicTail: prepared.area.dynamicTail }))
      return {
        identity: copy(identity), modelIdentity: loaded.modelIdentity, accessScopeHash, contextWindow: loaded.contextWindow,
        capabilities: loaded.capabilities ? copy(loaded.capabilities) : null,
        replyContext: { userRequest, locale, decisionGuardEnabled: loaded.replyContext?.decisionGuardEnabled === true },
        prepared: await savePreparedContext(prepared, identity, ports.references, signal), compactions: [], continuationRef: null,
        pendingRound: null, failedCompactionInput: null, sourceEffects: loaded.sourceEffects ? copy(loaded.sourceEffects) : null,
        providerCacheAnchor: null, currentProviderInput: null
      }
    },
    async afterRound(state, result, round) {
      if (state.capabilities && result.calls.some(call => !state.capabilities!.toolNames.includes(call.name)))
        throw new HarnessError('invalid_state', '模型调用了本轮未开放的工具')
      const prepared = await restore(state)
      // 捕获的是模型实际读取的前缀，不能在追加回复后再把回复重复附加一次。
      const frozen = frozenRequest(state, prepared)
      mainRequests.set(key(state.identity), frozen ?? { prepared, request: null })
      if (result.consumedInitialMedia) {
        const effect = result.consumedInitialMedia
        if (round !== 1 || effect.expectedRevision !== prepared.area.revision || !Array.isArray(effect.entryIds)
          || effect.entryIds.some(id => typeof id !== 'string' || !id) || new Set(effect.entryIds).size !== effect.entryIds.length)
          throw new HarnessError('invalid_state', '初始图片消费的轮次、revision或身份无效')
        const entries = effect.entryIds.map(id => prepared.area.entries.find(entry => entry.entryId === id))
        if (entries.some(entry => !entry || !Array.isArray(entry.message.content) || !hasInitialInlineImage(entry.message.content)))
          throw new HarnessError('invalid_state', '初始图片消费不能修订其他消息')
        for (const entry of entries) prepared.area.reviseEntry(entry!.entryId, collapseConsumedImage(entry!.message), prepared.area.revision)
      }
      if (!result.calls.length && result.text)
        prepared.area.append({ role: 'assistant', content: result.text }, {
          source: 'tool_round', persistencePolicy: 'request_only', roundId: `round-${round}`,
        })
      let continuationRef = state.continuationRef
      if (result.continuation !== undefined) {
        continuationRef = await ports.stageContinuation({
          identity: state.identity, round,
          modelIdentity: state.modelIdentity, accessScopeHash: state.accessScopeHash, areaDigest: prepared.area.digest(), value: result.continuation
        })
        if (!/^[A-Za-z0-9:._-]{1,256}$/.test(continuationRef))
          throw new Error('推理续接记录ID无效')
      }
      let providerCacheAnchor = state.providerCacheAnchor
      if (result.cacheAnchor !== undefined && result.cacheAnchor !== null) {
        const metadata = json(result.cacheAnchor)
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
          || metadata.modelIdentity !== state.modelIdentity || !metadata.anchor || typeof metadata.anchor !== 'object' || Array.isArray(metadata.anchor))
          throw new Error('Provider缓存锚点模型身份无效')
        const anchor = metadata.anchor
        const keys = ['provider', 'api_format', 'model', 'strategy', 'baseline_digest'] as const
        if (Object.keys(metadata).some((name) => !['modelIdentity', 'anchor'].includes(name))
          || Object.keys(anchor).some((name) => !keys.includes(name as typeof keys[number]))
          || keys.some((name) => typeof anchor[name] !== 'string' || !anchor[name] || String(anchor[name]).length > 512))
          throw new Error('Provider缓存锚点仅允许稳定指纹元数据')
        providerCacheAnchor = {
          ownerId: state.identity.ownerId, sessionId: state.identity.sessionId,
          modelIdentity: state.modelIdentity, anchor: anchor as NonNullable<CanonicalHarnessContext['providerCacheAnchor']>['anchor']
        }
      }
      const currentProviderInput = result.contextInput ?? null
      if (currentProviderInput !== null && (!Number.isSafeInteger(currentProviderInput) || currentProviderInput < 0))
        throw new Error('Provider当前请求输入量无效')
      return save({
        ...state, continuationRef, providerCacheAnchor, currentProviderInput, pendingRound: result.calls.length ? {
          round, text: result.text, calls: result.calls.map((call) => ({
            id: call.id, name: call.name, input: redactToolRequestHeaders(json(call.input)),
            ...(call.parseError ? { parseError: call.parseError } : {}),
            ...('rawArguments' in call && typeof call.rawArguments === 'string' ? { rawArguments: String(redactToolRequestHeaders(call.rawArguments)) } : {}),
            ...('responsesItemId' in call && typeof call.responsesItemId === 'string' ? { responsesItemId: call.responsesItemId } : {}),
          })),
          dispatched: [], assistantEntryId: null, resultEntryId: null,
        } : null
      }, prepared)
    },
    async afterTool(state, call, result: ToolResult, round) {
      if (result.kind === 'unknown')
        throw new Error('未知工具结果不得写入 Canonical 历史')
      if (result.kind === 'completed' && result.executed === false && result.value !== null && typeof result.value === 'object'
        && 'status' in result.value && ['cancelled', 'deferred'].includes(String(result.value.status)))
        return state
      const value = result.kind === 'waiting'
        ? { pending: true, interaction_id: result.interaction.id, kind: result.interaction.kind }
        : json(result.value)
      const updated = await toolResult(state, call, value, round, result.kind === 'completed' && !result.successful)
      if (result.kind !== 'completed' || !result.canonicalEvents?.length)
        return updated
      const prepared = await restore(updated)
      const events = result.canonicalEvents.map((event): Block => {
        const value = json(event)
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string')
          throw new Error('工具事件必须是Canonical block')
        return value as Block
      })
      const pair = prepared.area.entries.find((entry) => entry.entryId === updated.pendingRound?.assistantEntryId)
      appendCanonicalEvents(prepared.area, events, { roundId: `round-${round}`, batchId: pair?.batchId ?? undefined })
      return save(updated, prepared)
    },
    async resumeInteraction(state, pending, resolution) {
      if (pending.id !== resolution.interactionId)
        throw new Error('交互回执与待处理请求不匹配')
      return toolResult(state, pending.toolCall, {
        status: resolution.status,
        value: pending.kind === 'credential' ? { status: resolution.status === 'answered' ? 'completed' : resolution.status }
          : resolution.status === 'confirmed' ? null : json(resolution.value),
        interaction_id: pending.id,
      })
    },
    async appendReminder(state, prompt) {
      const prepared = await restore(state)
      prepared.area.append({ role: 'user', content: prompt }, {
        source: 'agent_followup', persistencePolicy: 'request_only',
      })
      return save(state, prepared)
    },
    async recoverOverflow(state, attempt, signal) {
      if (attempt !== 1)
        return { context: state, applied: false }
      const prepared = await restore(state, signal)
      const entries = prepared.area.entries
      const anchor = entries.findLastIndex((entry) => ['user', 'reference', 'attachment'].includes(entry.source))
      const rounds = [...new Set(entries.filter((entry) => entry.source === 'tool_round').map((entry) => entry.roundId))]
      const keptRounds = new Set(rounds.slice(-10))
      const rolling = entries.findIndex((entry) => entry.roundId != null && keptRounds.has(entry.roundId))
      const result = enforceProviderOverflow(prepared.area, anchor < 0 ? {} : {
        anchorIndex: prepared.area.fixedPrefixSize + anchor,
        from: prepared.area.fixedPrefixSize + Math.max(anchor + 1, rolling),
        previousFrom: prepared.area.protectedHistoryStart,
      })
      if (result.changed)
        prepared.area.protectedHistoryStart = result.previousProtectedStartIndex ?? null
      return { context: result.changed ? await save(state, prepared, signal) : state, applied: result.changed }
    },
    async afterUsage(state, usage, signal) {
      if (!shouldCompact(usage.contextInput, state.contextWindow))
        return { context: state, applied: false }
      if (state.failedCompactionInput !== null && usage.contextInput! < state.failedCompactionInput + 8000)
        return { context: state, applied: false }
      const prepared = await restore(state, signal)
      const entries = prepared.area.entries
      const anchor = entries.findLastIndex((entry) => ['user', 'reference', 'attachment'].includes(entry.source))
      const rounds = [...new Set(entries.filter((entry) => entry.source === 'tool_round').map((entry) => entry.roundId))]
      // 压力压缩只保留最新完整轮；普通跨Run历史恢复的十轮窗口是另一条规则。
      const keptRounds = new Set(rounds.slice(-1))
      const rolling = entries.findIndex((entry) => entry.roundId != null && keptRounds.has(entry.roundId))
      let result: CompactionResult
      try {
        result = await compactContext(prepared.area, ports.compaction, {
          modelIdentity: state.modelIdentity, signal,
          projection: frozenRequest(state, prepared)?.request.projection,
          ...(anchor < 0 ? {} : {
            window: {
              anchorIndex: prepared.area.fixedPrefixSize + anchor,
              from: prepared.area.fixedPrefixSize + Math.max(anchor + 1, rolling),
              previousFrom: null,
            }
          }),
        })
      }
      catch (error) {
        if (signal.aborted)
          throw error
        try {
          ports.diagnoseCompactionFailure({
            identity: state.identity, revision: prepared.area.revision,
            contextInput: usage.contextInput!
          }, error)
        }
        catch { /* 诊断故障不改变原始压缩失败状态。 */ }
        return { context: { ...state, failedCompactionInput: usage.contextInput }, applied: false }
      }
      if (!result.changed)
        return { context: { ...state, failedCompactionInput: usage.contextInput }, applied: false }
      applyCompaction(prepared.area, result)
      const context = await save(state, prepared, signal)
      return {
        context: {
          ...context, failedCompactionInput: null, compactions: [...state.compactions, {
            id: `${state.identity.runId}:${context.prepared.area.revision}`,
            result: { ...result, messages: context.prepared.area.entries.map((entry) => copy(entry.message)) },
          }]
        }, applied: true
      }
    },
    async afterFinal(identity, state, outcome) {
      const main = mainRequests.get(key(identity))
      await ports.finalization.complete({
        identity, modelIdentity: state.modelIdentity,
        accessScopeHash: state.accessScopeHash,
        request: main?.prepared ?? null, projection: main?.request?.projection ?? null,
        requestSystemPrompt: main?.request?.systemPrompt ?? '', requestTools: main?.request?.tools ?? [],
        text: outcome.text, providerContextInput: state.currentProviderInput,
        providerCompacted: state.compactions.length > 0, hadTools: outcome.hadTools,
      })
    },
    async release(identity) {
      requests.delete(key(identity))
      mainRequests.delete(key(identity))
      await ports.releaseContinuations(identity)
    },
  }
}
