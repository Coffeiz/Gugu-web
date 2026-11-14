import type { CanonicalAreaSnapshot,CanonicalMessage,Capsule,Digests,HistoryIdentity,Json,MessageEntry,PendingInteraction,PortableValue,PreparedContext,PreparedContextCheckpoint,ScopeMarker,ToolCall,ToolResult,ToolResultCheckpointScope } from '../contracts.js'
import { HarnessError,ToolResultCheckpointUnavailable } from '../contracts.js'
import { sameToolResultControl,snapshotToolResult } from './canonical-history.js'

import type { ContextReferenceCodec,ContextServices,RunCoordination } from '../ports.js'

import { blocks,copy,mediaTypes,MessageArea,portableSnapshot,snapshotToolCall,stableJson } from './canonical-history.js'

/** 只看真实内容块与工具结果内容；工具参数中的同名业务对象不能当作图片消费。 */
export function hasInitialInlineImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInitialInlineImage)
  if (!value || typeof value !== 'object') return false
  const block = value as Record<string, unknown>
  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | null
    return !!source && source.type === 'base64' && !!source.data
  }
  if (block.type === 'image_url') {
    const url = typeof block.image_url === 'string' ? block.image_url : (block.image_url as Record<string, unknown> | null)?.url
    return typeof url === 'string' && url.startsWith('data:')
  }
  return block.type === 'tool_result' && hasInitialInlineImage(block.content)
}

/** 配对工具结果保留原事件，只把其中已消费图片换成占位，不能破坏工具历史配对。 */
export function collapseConsumedImage(message: CanonicalMessage): CanonicalMessage {
  const result = copy(message)
  if (!Array.isArray(result.content)) return result
  const content = blocks(result.content)
  if (!content.some(block => ['tool_result', 'tool_call', 'tool_use'].includes(block.type))) {
    result.content = content.filter(block => block.type === 'text' && block.text).map(block => String(block.text)).join('\n') || '[图片已查看]'
    return result
  }
  const replace = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(replace)
    if (!value || typeof value !== 'object') return value
    if (hasInitialInlineImage(value) && ['image', 'image_url'].includes(String(value.type))) return { type: 'text', text: '[图片已查看]' }
    return value
  }
  result.content = content.map(block => block.type === 'tool_result' ? { ...block, content: replace(block.content ?? null) } : block)
  return result
}

/** 对端口输出再做协议无关检查，不接受媒体载荷或私有推理偷偷进入持久化。 */
export function assertDurableCanonical(value: Json): void {
  visitDurableCanonical(value, true)
}

export function isTemporaryMediaUrl(value: string): boolean {
  return /^(?:data:|blob:)/iu.test(value) || /^https?:\/\//iu.test(value)
    && /[?&](?:token|access_token|api_key|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-oss-signature|x-oss-credential|expires|se)=/iu.test(value)
}

export function visitDurableCanonical(value: Json, decodeToolContent: boolean): void {
  if (!value || typeof value !== 'object')
    return
  if (Array.isArray(value)) {
    for (const item of value)
      visitDurableCanonical(item, decodeToolContent)
    return
  }
  const type = typeof value.type === 'string' ? value.type : ''
  if (mediaTypes.has(type) || ['thinking', 'redacted_thinking', 'reasoning_content'].includes(type))
    throw new Error('持久化上下文必须使用授权的稳定引用，不能包含媒体载荷或私有推理')
  if (type === 'attachment_ref') {
    if (typeof value.attach_id !== 'string' || !value.attach_id || Object.keys(value).some(key => !['type', 'attach_id', 'kind', 'mime', 'ext', 'title', 'name', 'size_bytes'].includes(key)))
      throw new Error('附件稳定引用字段无效')
  }
  for (const [key, item] of Object.entries(value)) {
    // Schema是可信registry的字段定义，不应把属性名signature/type=image误判成真实Provider载荷。
    if (type === 'tool-schema' && key === 'schema')
      continue
    if (['provider_image_content', 'reasoning_content', 'api_key', 'access_token', 'confirmation_grant', 'execution_grant'].includes(key)
      || key === 'signature' && !!type)
      throw new Error('上下文checkpoint包含非持久化材料')
    if (typeof item === 'string' && (['signed_url', 'signedUrl', 'temporary_url', 'temporaryUrl', 'temp_url', 'tempUrl'].includes(key)
      || ['url', 'image_url', 'video_url', 'audio_url', 'download_url', 'downloadUrl'].includes(key) && isTemporaryMediaUrl(item)))
      throw new Error('临时媒体URL必须先固化为授权稳定引用')
    if (type === 'tool_result' && key === 'content') {
      if (typeof item === 'string' && isTemporaryMediaUrl(item))
        throw new Error('临时媒体URL必须先固化为授权稳定引用')
      // 只在明确的工具结果边界解一次JSON对象/数组。read_file正文等普通字符串不做递归猜测。
      if (decodeToolContent && typeof item === 'string' && /^[\s]*[\[{]/u.test(item)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(item)
        }
        catch {
          parsed = null
        }
        if (parsed && typeof parsed === 'object')
          visitDurableCanonical(parsed as Json, false)
      }
      else
        visitDurableCanonical(item, false)
    }
    else
      visitDurableCanonical(item, decodeToolContent)
  }
}

export function rebuildSnapshot(snapshot: CanonicalAreaSnapshot, entries: MessageEntry[], services: ContextServices): CanonicalAreaSnapshot {
  const base = {
    entries, revision: snapshot.revision,
    digest: services.digest(entries.map(entry => ({ sequence: entry.sequence, message: entry.message }))), batches: copy(snapshot.batches)
  }
  return { ...base, checkpointDigest: services.digest(base) }
}

export function codecMessage(message: CanonicalMessage, expected: CanonicalMessage): CanonicalMessage {
  const normalized = copy(portableSnapshot(message)) as Json
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized) || typeof normalized.role !== 'string' || !('content' in normalized))
    throw new Error('引用编解码返回了无效Canonical消息')
  const result = normalized as CanonicalMessage
  if (stableJson({ ...result, content: null }) !== stableJson({ ...expected, content: null }))
    throw new Error('引用编解码不能修改Canonical角色或消息元数据')
  const identity = (value: CanonicalMessage): Json[] => blocks(value.content).flatMap<Json>(block => block.type === 'tool_call'
    ? [{ type: block.type, id: block.id ?? null, name: block.name ?? null, responses_item_id: block.responses_item_id ?? null }]
    : block.type === 'tool_result' ? [{ type: block.type, tool_call_id: block.tool_call_id ?? null, tool_use_id: block.tool_use_id ?? null, tool_name: block.tool_name ?? null }] : [])
  if (stableJson(identity(result)) !== stableJson(identity(expected)))
    throw new Error('引用编解码不能修改工具调用或回执身份')
  return result
}

export async function savePreparedContext(prepared: PreparedContext, identity: HistoryIdentity, codec: ContextReferenceCodec, signal?: AbortSignal): Promise<PreparedContextCheckpoint> {
  const original = prepared.area.snapshot(), entries: MessageEntry[] = []
  for (const entry of original.entries) {
    signal?.throwIfAborted()
    const message = codecMessage(await codec.dehydrate(copy(entry), identity, signal), entry.message)
    signal?.throwIfAborted()
    assertDurableCanonical(message)
    entries.push({ ...copy(entry), message: copy(message) })
  }
  // 异步引用固化期间ledger若变化，不能产生跨revision的混合checkpoint。
  if (prepared.area.revision !== original.revision || prepared.area.digest() !== original.digest)
    throw new Error('引用固化期间上下文已变化')
  const rebuilt = rebuildSnapshot(original, entries, prepared.area.services)
  MessageArea.restore(prepared.area.services, rebuilt)
  const state = {
    ...identity, schemaVersion: 1 as const, area: rebuilt,
    protectedHistoryStart: prepared.area.protectedHistoryStart, requestPrefixSize: prepared.area.fixedPrefixSize, stanceToPersist: prepared.stanceToPersist
  }
  return { ...state, digest: prepared.area.services.digest(state) }
}

export async function restorePreparedContext(checkpoint: PreparedContextCheckpoint, identity: HistoryIdentity, ports: ContextServices & {
  prepareRequest(identity: HistoryIdentity, signal?: AbortSignal): Promise<{
    prefix: CanonicalMessage[]
    dynamicTail: CanonicalMessage[]
  }>
}, codec: ContextReferenceCodec, signal?: AbortSignal): Promise<PreparedContext> {
  if (checkpoint.schemaVersion !== 1 || checkpoint.ownerId !== identity.ownerId || checkpoint.sessionId !== identity.sessionId)
    throw new Error('上下文checkpoint版本或归属不匹配')
  const { digest, ...state } = checkpoint
  if (ports.digest(state) !== digest)
    throw new Error('上下文checkpoint指纹不匹配')
  if (!Number.isSafeInteger(checkpoint.requestPrefixSize) || checkpoint.requestPrefixSize < 0 || checkpoint.protectedHistoryStart != null
    && (!Number.isSafeInteger(checkpoint.protectedHistoryStart) || checkpoint.protectedHistoryStart < checkpoint.requestPrefixSize
      || checkpoint.protectedHistoryStart > checkpoint.requestPrefixSize + checkpoint.area.entries.length))
    throw new Error('上下文保护边界无效')
  // 先验证持久形状与指纹，再调用任何附件或授权端口。
  MessageArea.restore(ports, checkpoint.area)
  for (const entry of checkpoint.area.entries)
    assertDurableCanonical(entry.message)
  const entries: MessageEntry[] = []
  for (const entry of checkpoint.area.entries) {
    signal?.throwIfAborted()
    const message = codecMessage(await codec.hydrate(copy(entry), identity, signal), entry.message)
    signal?.throwIfAborted()
    entries.push({ ...copy(entry), message })
  }
  const area = MessageArea.restore(ports, rebuildSnapshot(checkpoint.area, entries, ports))
  const request = await ports.prepareRequest(identity, signal)
  signal?.throwIfAborted()
  area.configureRequest(request.prefix)
  area.setDynamicTail(request.dynamicTail)
  const protectedStart = checkpoint.protectedHistoryStart == null ? null : checkpoint.protectedHistoryStart - checkpoint.requestPrefixSize + request.prefix.length
  area.protectedHistoryStart = protectedStart
  return {
    area, rag: { tail: area.entries.filter(entry => entry.source === 'rag').map(entry => entry.message) },
    stanceToPersist: checkpoint.stanceToPersist, protectedHistoryStart: protectedStart
  }
}

export function json(value: unknown): Json { return copy(portableSnapshot(value)) as Json }

export function object(value: unknown, allowed: readonly string[], optionalUndefined: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('工具回执必须是普通JSON对象')
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error('工具回执不能包含Symbol字段')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name))
      throw new Error('工具回执包含未声明字段')
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!
    if (!('value' in descriptor))
      throw new Error('工具回执不能包含访问器')
    if (descriptor.value === undefined && optionalUndefined.includes(name))
      continue
    result[name] = descriptor.value
  }
  return result
}

export function normalizeScope(scope: ToolResultCheckpointScope, services: Digests): {
  marker: ScopeMarker
  call: ToolCall
} {
  const identity = object(scope.identity, ['ownerId', 'sessionId', 'runId'])
  if (['ownerId', 'sessionId', 'runId'].some(name => typeof identity[name] !== 'string' || !identity[name]))
    throw new Error('工具结果检查点身份无效')
  if (!Number.isSafeInteger(scope.round) || scope.round < 1)
    throw new Error('工具结果检查点轮次无效')
  const rawCall = object(scope.call, ['id', 'name', 'input', 'rawArguments', 'responsesItemId', 'parseError'], ['rawArguments', 'responsesItemId', 'parseError'])
  const call = snapshotToolCall(rawCall as unknown as ToolCall)
  return {
    marker: {
      ownerId: String(identity.ownerId), sessionId: String(identity.sessionId), runId: String(identity.runId), round: scope.round,
      callId: call.id, toolName: call.name, callDigest: services.digest(call)
    }, call
  }
}

export function normalizeResult(result: ToolResult, call: ToolCall): ToolResult {
  const raw = object(result, ['kind', 'value', 'successful', 'mutated', 'artifact', 'executed', 'canonicalEvents', 'interaction'], ['artifact', 'executed', 'canonicalEvents'])
  if (raw.kind === 'unknown') {
    if (Object.keys(raw).length !== 1)
      throw new Error('未知结果不能携带未确认的业务值')
    return { kind: 'unknown' }
  }
  if (raw.kind === 'waiting') {
    if (Object.keys(raw).some(name => !['kind', 'interaction'].includes(name)))
      throw new Error('等待结果不能伪装成已完成回执')
    const pending = object(raw.interaction, ['id', 'kind', 'toolCall', 'afterConfirmation'], ['afterConfirmation'])
    if (typeof pending.id !== 'string' || !pending.id || !['question', 'confirmation', 'credential'].includes(String(pending.kind))
      || pending.afterConfirmation !== undefined && typeof pending.afterConfirmation !== 'boolean')
      throw new Error('等待交互控制字段无效')
    const pendingCall = object(pending.toolCall, ['id', 'name', 'input', 'rawArguments', 'responsesItemId', 'parseError'], ['rawArguments', 'responsesItemId', 'parseError'])
    if (stableJson(snapshotToolCall(pendingCall as unknown as ToolCall)) !== stableJson(call))
      throw new Error('等待交互不属于原工具调用')
    return {
      kind: 'waiting', interaction: {
        id: pending.id, kind: pending.kind as PendingInteraction['kind'], toolCall: call,
        ...(pending.afterConfirmation === undefined ? {} : { afterConfirmation: pending.afterConfirmation })
      }
    }
  }
  if (raw.kind !== 'completed' || 'interaction' in raw || !('value' in raw) || typeof raw.successful !== 'boolean' || typeof raw.mutated !== 'boolean'
    || raw.executed !== undefined && typeof raw.executed !== 'boolean' || raw.canonicalEvents !== undefined && !Array.isArray(raw.canonicalEvents))
    throw new Error('工具完成回执形状无效')
  return {
    kind: 'completed', value: json(raw.value), successful: raw.successful, mutated: raw.mutated,
    ...(raw.executed === undefined ? {} : { executed: raw.executed }), ...(raw.artifact === undefined ? {} : { artifact: json(raw.artifact) }),
    ...(raw.canonicalEvents === undefined ? {} : { canonicalEvents: (raw.canonicalEvents as unknown[]).map(json) })
  }
}

export function controls(result: Extract<ToolResult, {
  kind: 'completed'
}>): Json {
  return {
    kind: result.kind, successful: result.successful, mutated: result.mutated,
    ...(result.executed === undefined ? {} : { executed: result.executed }),
    ...(result.canonicalEvents === undefined ? {} : { canonicalEvents: result.canonicalEvents.map(json) })
  }
}

export function assertPayloadDurable(value: Json, callId: string): void {
  assertDurableCanonical({ type: 'tool_result', tool_call_id: callId, content: value })
}

export function envelope(marker: ScopeMarker, payload: Json, controlDigest: string): MessageEntry {
  return {
    entryId: `tool-result:${marker.runId}:${marker.round}:${marker.callId}`, sequence: 0, revision: 0,
    source: 'tool_round', persistencePolicy: 'request_only', roundId: `round-${marker.round}`, persistedMessageId: null,
    message: {
      role: 'user', _tool_result_checkpoint: { ...marker, controlDigest },
      content: [{ type: 'tool_result', tool_call_id: marker.callId, tool_name: marker.toolName, content: payload }]
    }
  }
}

export function extractEnvelope(message: CanonicalMessage, expected: MessageEntry): {
  value: Json
  artifact?: Json
} {
  const normalized = json(message)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized) || !Array.isArray(normalized.content) || normalized.content.length !== 1)
    throw new Error('引用编解码改变了工具结果封套')
  const block = normalized.content[0]
  if (!block || typeof block !== 'object' || Array.isArray(block) || !('content' in block))
    throw new Error('引用编解码丢失了工具结果载荷')
  const withoutPayload = { ...normalized, content: [{ ...block, content: null }] }
  const expectedBlock = (expected.message.content as Json[])[0] as Record<string, Json>
  const expectedWithoutPayload = { ...expected.message, content: [{ ...expectedBlock, content: null }] }
  if (stableJson(withoutPayload) !== stableJson(expectedWithoutPayload))
    throw new Error('引用编解码改变了owner、Run、轮次或工具身份')
  const payload = block.content
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('value' in payload) || Object.keys(payload).some(key => !['value', 'artifact'].includes(key)))
    throw new Error('引用编解码改变了工具值/制品形状')
  return { value: payload.value!, ...('artifact' in payload ? { artifact: payload.artifact! } : {}) }
}

export function uncompletedDurable(result: Exclude<ToolResult, {
  kind: 'completed'
}>, marker: ScopeMarker): ToolResult {
  // 等待交互没有可替换的value/artifact，控制字段只能深快照；存在未固化媒体时拒绝。
  assertDurableCanonical({ type: 'tool_result', tool_call_id: marker.callId, content: json(result) })
  if (result.kind === 'waiting') {
    assertPayloadDurable(json(result.interaction.toolCall.input), marker.callId)
    if (result.interaction.toolCall.rawArguments !== undefined)
      assertPayloadDurable(result.interaction.toolCall.rawArguments, marker.callId)
  }
  return copy(result)
}

export async function checkpointToolResult(scope: ToolResultCheckpointScope, result: ToolResult, codec: ContextReferenceCodec, services: Digests, signal?: AbortSignal): Promise<ToolResult> {
  signal?.throwIfAborted()
  const { marker, call } = normalizeScope(scope, services), normalized = normalizeResult(result, call)
  if (normalized.kind !== 'completed')
    return uncompletedDurable(normalized, marker)
  const control = controls(normalized), controlDigest = services.digest(control)
  assertDurableCanonical(control)
  for (const event of normalized.canonicalEvents ?? []) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !['tool-schema', 'skill-schema', 'tool-discovery'].includes(String((event as Record<string, unknown>).type)))
      throw new Error('工具结果包含非法Canonical声明')
  }
  const payload: Json = { value: json(normalized.value), ...(normalized.artifact === undefined ? {} : { artifact: json(normalized.artifact) }) }
  const entry = envelope(marker, payload, controlDigest)
  const dehydrated = await codec.dehydrate(copy(entry), copy(scope.identity), signal)
  signal?.throwIfAborted()
  const restored = extractEnvelope(dehydrated, entry)
  if (('artifact' in restored) !== (normalized.artifact !== undefined))
    throw new Error('引用固化不能添加或删除制品字段')
  assertDurableCanonical(dehydrated)
  assertPayloadDurable(restored.value, marker.callId)
  if (restored.artifact !== undefined)
    assertPayloadDurable(restored.artifact, marker.callId)
  if (typeof restored.artifact === 'string' && isTemporaryMediaUrl(restored.artifact))
    throw new Error('临时制品URL必须先固化为授权稳定引用')
  const capsule: Capsule = {
    type: 'harness-tool-result-checkpoint', schemaVersion: 1, scope: marker, controlDigest,
    payloadDigest: services.digest(restored), payload: restored.value
  }
  return { ...normalized, value: json(capsule), ...(restored.artifact === undefined ? {} : { artifact: restored.artifact }) }
}

export async function restoreToolResult(scope: ToolResultCheckpointScope, result: ToolResult, codec: ContextReferenceCodec, services: Digests, signal?: AbortSignal): Promise<ToolResult> {
  signal?.throwIfAborted()
  const { marker, call } = normalizeScope(scope, services), normalized = normalizeResult(result, call)
  if (normalized.kind !== 'completed')
    return uncompletedDurable(normalized, marker)
  const candidate = normalized.value
  const raw = object(candidate, ['type', 'schemaVersion', 'scope', 'controlDigest', 'payloadDigest', 'payload'])
  if (raw.type !== 'harness-tool-result-checkpoint' || raw.schemaVersion !== 1 || stableJson(json(raw.scope)) !== stableJson(marker))
    throw new Error('工具结果检查点归属、Run、轮次或调用不匹配')
  const controlDigest = services.digest(controls(normalized))
  if (raw.controlDigest !== controlDigest)
    throw new Error('工具结果检查点控制字段已变化')
  const payload: Json = { value: json(raw.payload), ...(normalized.artifact === undefined ? {} : { artifact: json(normalized.artifact) }) }
  if (raw.payloadDigest !== services.digest(payload))
    throw new Error('工具结果检查点载荷指纹不匹配')
  const entry = envelope(marker, payload, controlDigest)
  assertDurableCanonical(entry.message)
  assertPayloadDurable(json(raw.payload), marker.callId)
  if (normalized.artifact !== undefined)
    assertPayloadDurable(json(normalized.artifact), marker.callId)
  if (typeof normalized.artifact === 'string' && isTemporaryMediaUrl(normalized.artifact))
    throw new Error('临时制品URL必须先固化为授权稳定引用')
  const hydrated = await codec.hydrate(copy(entry), copy(scope.identity), signal)
  signal?.throwIfAborted()
  const decoded = extractEnvelope(hydrated, entry)
  if (('artifact' in decoded) !== (normalized.artifact !== undefined))
    throw new Error('引用恢复不能添加或删除制品字段')
  return { ...normalized, value: decoded.value, ...(decoded.artifact === undefined ? {} : { artifact: decoded.artifact }) }
}

export function createToolResultCheckpoint(codec: ContextReferenceCodec, services: Digests): {
  checkpointToolResult(scope: ToolResultCheckpointScope, result: ToolResult, signal?: AbortSignal): Promise<ToolResult>
  restoreToolResult(scope: ToolResultCheckpointScope, result: ToolResult, signal?: AbortSignal): Promise<ToolResult>
} {
  return {
    checkpointToolResult: (scope, result, signal) => checkpointToolResult(scope, result, codec, services, signal),
    restoreToolResult: (scope, result, signal) => restoreToolResult(scope, result, codec, services, signal)
  }
}

export async function encodeResultForRun<C>(scope: RunCoordination<C>, call: ToolCall, result: ToolResult, round = scope.state!.round): Promise<ToolResult> {
  const normalized = snapshotToolResult(result, call)
  // 已得到的回执是事实；取消执行不能取消其安全固化，否则会丢掉已完成兄弟结果。
  const encoded = snapshotToolResult(await scope.ports.context.checkpointToolResult({ identity: scope.identity, round, call }, normalized), call)
  if (!sameToolResultControl(normalized, encoded))
    throw new HarnessError('invalid_state', '工具结果Codec改变了执行状态')
  if (encoded.kind === 'completed') {
    assertDurableCanonical({ type: 'tool_result', content: portableSnapshot(encoded.value) as Json })
    if (encoded.artifact !== undefined)
      normalizePersistentArtifact(encoded.artifact)
  }
  return encoded
}

export async function hydrateResultForRun<C>(scope: RunCoordination<C>, call: ToolCall, result: ToolResult): Promise<ToolResult> {
  const hydrated = snapshotToolResult(await scope.ports.context.restoreToolResult({ identity: scope.identity, round: scope.state!.round, call }, result), call)
  if (!sameToolResultControl(result, hydrated))
    throw new HarnessError('invalid_state', '工具结果Codec改变了执行状态')
  return hydrated
}

export async function cacheResultForRun<C>(scope: RunCoordination<C>, call: ToolCall, result: ToolResult, replay = false): Promise<ToolResult> {
  const snapshot = snapshotToolResult(result, call)
  if (snapshot.kind === 'waiting' && scope.state!.toolResults.some((item) => item.callId !== call.id && item.result.kind === 'waiting' && item.result.interaction.id === snapshot.interaction.id))
    throw new HarnessError('invalid_state', '交互请求身份重复')
  let encoded: ToolResult
  try {
    encoded = await scope.encodeResult(call, snapshot)
  }
  catch (error) {
    if (snapshot.kind === 'completed' && snapshot.executed !== false)
      throw new ToolResultCheckpointUnavailable({ callId: call.id, successful: snapshot.successful, mutated: snapshot.mutated })
    throw error
  }
  await scope.commit({
    toolResults: [...scope.state!.toolResults.filter((item) => item.callId !== call.id), { callId: call.id, result: encoded }],
    ...(replay ? { replayResultReady: true } : {}),
    inflightCall: scope.state!.inflightCall?.id === call.id ? null : scope.state!.inflightCall,
    inflightCalls: scope.state!.inflightCalls.filter((item) => item.id !== call.id),
    mutated: scope.state!.mutated || (snapshot.kind === 'completed' && snapshot.mutated),
  })
  return snapshot
}



/** 用户制品卡只保存FS/附件稳定引用；Provider当前媒体正文只走结果hydrate，不能混入卡片。 */
export function normalizePersistentArtifact(value: unknown): PortableValue {
  const artifact = portableSnapshot(value)
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    throw new HarnessError('invalid_state', '工具制品必须是引用卡片')
  const card = artifact as Readonly<Record<string, PortableValue>>
  assertDurableCanonical({ type: 'tool_result', content: artifact as unknown as Json })
  if (card.kind === 'link_buttons') {
    if (Object.keys(card).some((key) => !['kind', 'message', 'buttons'].includes(key)) || typeof card.message !== 'string' || !card.message.trim() || [...card.message].length > 2000 || !Array.isArray(card.buttons) || card.buttons.length < 1 || card.buttons.length > 5)
      throw new HarnessError('invalid_state', '链接按钮制品形状无效')
    const ids = new Set<string>()
    const blocked = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'filesystem', 'about', 'chrome', 'chrome-extension', 'resource', 'view-source'])
    for (const button of card.buttons) {
      if (!button || typeof button !== 'object' || Array.isArray(button))
        throw new HarnessError('invalid_state', '链接按钮格式无效')
      const item = button as Readonly<Record<string, PortableValue>>
      if (Object.keys(item).some((key) => !['id', 'label', 'url'].includes(key)) || typeof item.id !== 'string' || !item.id || [...item.id].length > 64 || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || [...item.label].length > 40 || typeof item.url !== 'string' || !item.url.trim() || [...item.url].length > 2048 || /[\x00-\x1f\x7f]/.test(card.message + item.label + item.url))
        throw new HarnessError('invalid_state', '链接按钮字段无效')
      ids.add(item.id)
      const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(item.url)
      if (!scheme || blocked.has(scheme[1]!.toLowerCase()) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(item.url))
        throw new HarnessError('invalid_state', '链接按钮URL不安全')
    }
    return artifact
  }
  const fields = new Set(['type', 'attach_id', 'file_id', 'id', 'rootId', 'root_id', 'relativePath', 'relative_path', 'kind', 'mime', 'ext', 'title', 'name', 'size_bytes', 'sizeBytes', 'img_width', 'img_height', 'duration'])
  if (Object.entries(card).some(([key, item]) => !fields.has(key) || item !== null && !['string', 'number', 'boolean'].includes(typeof item)))
    throw new HarnessError('invalid_state', '文件制品只能包含稳定引用及展示元数据')
  if (card.type === 'attachment_ref' || card.attach_id || card.file_id || card.id
    || ((card.rootId || card.root_id) && (card.relativePath || card.relative_path)))
    return artifact
  throw new HarnessError('invalid_state', '工具制品缺少稳定FS或附件引用')
}
