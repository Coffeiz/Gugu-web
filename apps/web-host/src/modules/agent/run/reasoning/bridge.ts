import type { PoolClient } from 'pg'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'
import type { ProviderRuntime } from '@gugu/core/providers'
import { commitReasoningState, loadReasoningState, type ReasoningIdentity } from './state.js'

/** Host 必须在首次授权选模与读取版本时固定此公开元数据，随 run 持久化；不可从请求正文取得。 */
export interface ProviderReasoningBinding {
  identity: ReasoningIdentity
  runId: string
  modelIdentity: string
  accessScopeHash: string
  expectedVersion: number
}
export type ResponsesReasoningBinding = ProviderReasoningBinding
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** 活动状态的协议白名单；私有wire只在加密侧表中恢复，不进入Canonical。 */
export function validatePrivateContinuation(value: unknown, binding: ProviderReasoningBinding): void {
  if (!object(value)) throw new Error('私有推理状态格式无效')
  const format = binding.identity.apiFormat
  const strings = (map: unknown) => object(map) && Object.entries(map).every(([id, item]) => !!id && typeof item === 'string')
  if (format === 'responses') {
    if (value.state_kind !== 'openai_responses_reasoning') throw new Error('私有推理状态格式无效')
    reasoningItems(value.reasoning_items)
  } else if (format === 'anthropic') {
    if (value.state_kind !== 'anthropic_thinking_blocks' || value.model_identity !== binding.modelIdentity
      || value.owner_id !== binding.identity.ownerId || value.session_id !== binding.identity.sessionId
      || value.access_scope_hash !== binding.accessScopeHash || value.provider !== binding.identity.provider)
      throw new Error('私有推理状态身份不匹配')
    anthropicPayload(value.payload)
  } else if (format === 'openai') {
    if (value.kind !== 'openai' || !strings(value.reasoningByCall)) throw new Error('私有推理状态格式无效')
  } else if (format === 'ollama') {
    if (value.protocol !== 'ollama' || !strings(value.thinkingByToolCallId) || !object(value.assistant)
      || value.assistant.role !== 'assistant' || typeof value.assistant.content !== 'string'
      || value.assistant.thinking !== undefined && typeof value.assistant.thinking !== 'string'
      || value.assistant.tool_calls !== undefined && !Array.isArray(value.assistant.tool_calls)) throw new Error('私有推理状态格式无效')
  } else throw new Error('私有推理状态协议无效')
}

function anthropicPayload(value: unknown): Record<string, unknown> {
  const blocks = (items: unknown, response = false) => Array.isArray(items) && items.every(item => object(item)
    && (response ? ['thinking', 'redacted_thinking', 'text', 'tool_use'] : ['thinking', 'redacted_thinking']).includes(String(item.type)))
  if (!object(value) || !object(value.history_thinking_by_tool_id)
    || Object.entries(value.history_thinking_by_tool_id).some(([id, items]) => !id || !blocks(items))
    || value.tail_blocks != null && !blocks(value.tail_blocks)
    || value.history_response_blocks_by_tool_id !== undefined && (!object(value.history_response_blocks_by_tool_id)
      || Object.entries(value.history_response_blocks_by_tool_id).some(([id, items]) => !id || !blocks(items, true)))
    || value.tail_response_blocks != null && !blocks(value.tail_response_blocks, true)) throw new Error('Anthropic 推理状态格式无效')
  return value
}

/** 与Python跨Run载荷一致，只发布签名thinking映射；完整响应块仅属于活动Run。 */
export async function commitStagedAnthropicReasoning(client: PoolClient, provider: Pick<ProviderRuntime, 'withStagedContinuation'>,
  context: CanonicalRunContext, binding: ProviderReasoningBinding, key: string, keyVersion: number): Promise<number> {
  if (binding.identity.apiFormat !== 'anthropic' || binding.runId !== context.identity.runId
    || binding.identity.ownerId !== context.identity.ownerId || binding.identity.sessionId !== context.identity.sessionId
    || binding.modelIdentity !== context.modelIdentity || binding.accessScopeHash !== context.accessScopeHash) throw new Error('推理状态运行身份不匹配')
  return provider.withStagedContinuation(context, async staged => {
    validatePrivateContinuation(staged.value, binding)
    if (!Number.isSafeInteger(staged.round) || staged.round < 1 || !staged.areaDigest) throw new Error('私有推理状态格式无效')
    const payload = anthropicPayload((staged.value as Record<string, unknown>).payload)
    return commitReasoningState(client, binding.identity, { expectedVersion: binding.expectedVersion,
      runId: context.identity.runId, roundId: `round-${staged.round}`, sequence: staged.round,
      stateKind: 'anthropic_thinking_blocks', value: { history_thinking_by_tool_id: payload.history_thinking_by_tool_id, tail_blocks: payload.tail_blocks ?? null } }, key, keyVersion)
  })
}

export async function stageLoadedAnthropicReasoning(client: PoolClient, provider: Pick<ProviderRuntime, 'stageContinuation'>,
  identity: RunIdentity, binding: ProviderReasoningBinding, areaDigest: string,
  keyForVersion: (version: number) => string): Promise<{ continuationRef: string | null; version: number; unavailableReason: string | null }> {
  if (binding.identity.apiFormat !== 'anthropic' || identity.ownerId !== binding.identity.ownerId
    || identity.sessionId !== binding.identity.sessionId || identity.runId !== binding.runId || !areaDigest) throw new Error('推理状态运行身份不匹配')
  const loaded = await loadReasoningState(client, binding.identity, 'continuation', keyForVersion)
  if (loaded.value === null) return { continuationRef: null, version: loaded.version, unavailableReason: loaded.unavailableReason }
  if (loaded.version !== binding.expectedVersion || loaded.stateKind !== 'anthropic_thinking_blocks') throw new Error('私有推理状态版本或格式无效')
  const payload = anthropicPayload(loaded.value)
  const value = { state_kind: 'anthropic_thinking_blocks', model_identity: binding.modelIdentity, owner_id: identity.ownerId,
    session_id: identity.sessionId, access_scope_hash: binding.accessScopeHash, provider: binding.identity.provider, payload }
  const continuationRef = await provider.stageContinuation({ identity, round: 0, modelIdentity: binding.modelIdentity,
    accessScopeHash: binding.accessScopeHash, areaDigest, value })
  return { continuationRef, version: loaded.version, unavailableReason: null }
}
function validateBinding(binding: ResponsesReasoningBinding, identity: RunIdentity, modelIdentity: string, scope: string): void {
  if (binding.identity.ownerId !== identity.ownerId || binding.identity.sessionId !== identity.sessionId
    || binding.runId !== identity.runId || binding.modelIdentity !== modelIdentity || binding.accessScopeHash !== scope
    || binding.identity.apiFormat !== 'responses' || !scope || !modelIdentity
    || !Number.isSafeInteger(binding.expectedVersion) || binding.expectedVersion < 0)
    throw new Error('推理状态运行身份不匹配')
}
function reasoningItems(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || item.type !== 'reasoning' || (item.status !== undefined && item.status !== null && item.status !== 'completed')))
    throw new Error('Responses 推理状态格式无效')
  return value as Record<string, unknown>[]
}

/** 必须由历史 writer 在同一事务内调用；只支持与 Python payload 已核实一致的 Responses。 */
export async function commitStagedResponsesReasoning(client: PoolClient, provider: Pick<ProviderRuntime, 'withStagedContinuation'>,
  context: CanonicalRunContext, binding: ResponsesReasoningBinding, key: string, keyVersion: number): Promise<number> {
  validateBinding(binding, context.identity, context.modelIdentity, context.accessScopeHash)
  return provider.withStagedContinuation(context, async staged => {
    const value = staged.value
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('state_kind' in value)
      || value.state_kind !== 'openai_responses_reasoning' || !('reasoning_items' in value)
      || !Number.isSafeInteger(staged.round) || staged.round < 1 || !staged.areaDigest)
      throw new Error('Responses 推理状态格式无效')
    const items = reasoningItems(value.reasoning_items)
    return commitReasoningState(client, binding.identity, { expectedVersion: binding.expectedVersion,
      runId: context.identity.runId, roundId: `round-${staged.round}`, sequence: staged.round,
      stateKind: 'openai_responses_reasoning', value: { reasoning_items: items } }, key, keyVersion)
  })
}

/** 只返回非敏感引用与版本；解密值只在临时作用域内注入 Provider，不进入 checkpoint。 */
export async function stageLoadedResponsesReasoning(client: PoolClient, provider: Pick<ProviderRuntime, 'stageContinuation'>,
  identity: RunIdentity, binding: ResponsesReasoningBinding, areaDigest: string,
  keyForVersion: (version: number) => string): Promise<{ continuationRef: string | null; version: number; unavailableReason: string | null }> {
  validateBinding(binding, identity, binding.modelIdentity, binding.accessScopeHash)
  if (!areaDigest) throw new Error('推理状态上下文指纹无效')
  const loaded = await loadReasoningState(client, binding.identity, 'continuation', keyForVersion)
  if (loaded.value === null) return { continuationRef: null, version: loaded.version, unavailableReason: loaded.unavailableReason }
  if (loaded.version !== binding.expectedVersion) throw new Error('推理状态版本已变化')
  if (loaded.stateKind !== 'openai_responses_reasoning' || !loaded.value || typeof loaded.value !== 'object'
    || Array.isArray(loaded.value) || !('reasoning_items' in loaded.value)) throw new Error('Responses 推理状态格式无效')
  const continuationRef = await provider.stageContinuation({ identity, round: 0, modelIdentity: binding.modelIdentity,
    accessScopeHash: binding.accessScopeHash, areaDigest, value: { state_kind: 'openai_responses_reasoning', reasoning_items: reasoningItems(loaded.value.reasoning_items) } })
  return { continuationRef, version: loaded.version, unavailableReason: null }
}
