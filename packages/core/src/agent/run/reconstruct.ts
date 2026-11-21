import { buildFixedRequestPrefix, placeToolReminder } from '../context/assemble.js'
import { contextAccessScopeHash, readSessionSnapshot } from '../context/prepare.js'
import type { CanonicalRunContext, ContextSourceSelection, RunCheckpoint, RunIdentity } from '../models.js'
import type { CanonicalContextPorts, ContextServices, ContextSourcePorts } from '../ports.js'
import type { ProviderRuntimeOptions } from '../providers/runtime.js'
import type { AgentProviderAuxiliaryPorts } from '../runtime.js'
import { AgentRunReconstructionVersionError, type AgentDispatchRuntimeLease, type AgentDispatchWorkerPorts } from './dispatch-worker.js'

export interface AgentRunBinding {
  selection: ContextSourceSelection
  resolve: ProviderRuntimeOptions['resolve']
  release(): void
}

type Selection = Awaited<ReturnType<AgentRunBinding['resolve']>>
type Runtime<L extends AgentDispatchRuntimeLease> = NonNullable<Awaited<ReturnType<AgentDispatchWorkerPorts<CanonicalRunContext, L>['reconstruct']>>> & {
  provider: AgentProviderAuxiliaryPorts
}

/** 从原 Run 的持久会话快照重建固定前缀，不读取当前会话的资料。 */
export function restoreAgentRequestPrefix(
  identity: RunIdentity,
  checkpoint: Pick<CanonicalRunContext, 'identity' | 'sourceEffects' | 'accessScopeHash' | 'capabilities'> & {
    prepared: Pick<CanonicalRunContext['prepared'], 'requestPrefixSize' | 'requestDigest'>
  },
  selection: ContextSourceSelection,
  ports: Pick<ContextServices, 'digest'> & { builder: Pick<ContextSourcePorts['builder'], 'buildRequest'> },
): CanonicalContextPorts['prepareRequest'] {
  const boundIdentity = { ...identity }
  const matches = (candidate: RunIdentity) => candidate.ownerId === boundIdentity.ownerId
    && candidate.sessionId === boundIdentity.sessionId && candidate.runId === boundIdentity.runId
  const state = checkpoint.sourceEffects?.sessionSnapshot.state
  if (!matches(checkpoint.identity) || !state?.context
    || state.ownerId !== boundIdentity.ownerId || state.sessionId !== boundIdentity.sessionId
    || state.context.access_scope_hash !== checkpoint.accessScopeHash)
    throw new AgentRunReconstructionVersionError('运行前缀的快照归属或访问范围不匹配')

  const prefix = buildFixedRequestPrefix(ports.builder.buildRequest(readSessionSnapshot(state), selection, { ...boundIdentity }))
  // 网页简介目录通过同一 Run 的冻结能力恢复，摘要仍绑定请求内容。
  const restored = placeToolReminder({ prefix, dynamicTail: [] }, checkpoint.capabilities?.toolReminder, checkpoint.prepared, ports.digest)
  if (checkpoint.prepared.requestPrefixSize !== restored.prefix.length || checkpoint.prepared.requestDigest !== ports.digest(restored))
    throw new AgentRunReconstructionVersionError('运行请求前缀已变化，无法恢复')
  return async (candidate, signal) => {
    signal?.throwIfAborted()
    if (!matches(candidate)) throw new AgentRunReconstructionVersionError('运行前缀的调用身份不匹配')
    return structuredClone(restored)
  }
}

/** Host 提供已验证的调度来源、拥有者限定的持久状态以及实际运行资源。 */
export function createAgentRunReconstructor<
  L extends AgentDispatchRuntimeLease & { input: { accessVersion: string; locale: string | null } },
  B extends AgentRunBinding,
  R extends {
    context: Pick<ContextServices, 'digest'>
    bindProvider?(provider: AgentProviderAuxiliaryPorts, selected: Selection): void | Promise<void>
  },
>(ports: {
  acceptsInput(input: L['input']): boolean
  hasAnchor(identity: RunIdentity, userMessageId: number): Promise<boolean>
  readCheckpoint(identity: RunIdentity): Promise<Pick<RunCheckpoint<CanonicalRunContext>, 'context'> | null>
  bind(lease: L, checkpoint: CanonicalRunContext | null): Promise<B | null>
  resources(lease: L, binding: B): Promise<R | null>
  createRuntime(lease: L, binding: B, resources: R, checkpoint: CanonicalRunContext | null): Runtime<L>
}): AgentDispatchWorkerPorts<CanonicalRunContext, L>['reconstruct'] {
  return async lease => {
    const { identity, input } = lease
    if (!ports.acceptsInput(input)) throw new AgentRunReconstructionVersionError('运行来源无法验证')
    if (!await ports.hasAnchor(identity, input.userMessageId)) throw new Error('运行消息锚点不存在')
    const checkpoint = await ports.readCheckpoint(identity)
    if ((lease.mode === 'resume') !== Boolean(checkpoint)) throw new Error('运行恢复状态不匹配')
    const savedContext = checkpoint?.context ?? null
    const binding = await ports.bind(lease, savedContext)
    if (!binding) return null

    let runtime: Runtime<L> | undefined
    let ownsBinding = true
    try {
      const { selection } = binding
      if (selection.contextScopeKey !== input.accessVersion || !selection.modelIdentity || (input.locale && selection.locale !== input.locale))
        throw new AgentRunReconstructionVersionError('运行授权或语言版本不匹配')
      if (savedContext && savedContext.modelIdentity !== selection.modelIdentity)
        throw new AgentRunReconstructionVersionError('运行模型身份不匹配')
      const resources = await ports.resources(lease, binding)
      if (!resources) return null
      const expected = contextAccessScopeHash(identity, selection, resources.context.digest)
      if (savedContext && savedContext.accessScopeHash !== expected)
        throw new AgentRunReconstructionVersionError('运行访问范围不匹配')
      const selected = await binding.resolve(identity, selection.modelIdentity, new AbortController().signal)
      if (selected.modelIdentity !== selection.modelIdentity || selected.accessScopeHash !== expected)
        throw new AgentRunReconstructionVersionError('Provider 访问范围不匹配')
      const instance = ports.createRuntime(lease, binding, resources, savedContext)
      runtime = instance
      await resources.bindProvider?.(instance.provider, selected)
      ownsBinding = false
      let closing: Promise<void> | undefined
      return {
        harness: instance.harness,
        cancellation: instance.cancellation,
        close() {
          closing ??= Promise.resolve().then(() => instance.close()).finally(() => binding.release())
          return closing
        },
      }
    } catch (error) {
      try { await runtime?.close() } catch { /* 保留原始装配错误。 */ }
      ownsBinding = false
      try { binding.release() } catch { /* 保留原始装配错误。 */ }
      throw error
    } finally {
      if (ownsBinding) binding.release()
    }
  }
}
