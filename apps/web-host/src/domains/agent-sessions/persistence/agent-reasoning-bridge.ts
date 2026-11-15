import type { PoolClient } from 'pg'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'
import type { ProviderRuntime } from '@gugu/core/providers'
import { commitReasoningState, loadReasoningState, type ReasoningIdentity } from './agent-reasoning-state-postgres.js'

/** Host 必须在首次授权选模与读取版本时固定此公开元数据，随 run 持久化；不可从请求正文取得。 */
export interface ResponsesReasoningBinding {
  identity: ReasoningIdentity
  runId: string
  modelIdentity: string
  accessScopeHash: string
  expectedVersion: number
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
