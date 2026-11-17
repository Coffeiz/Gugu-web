import { contextAccessScopeHash } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, CanonicalRunPreparationPorts, ContextSourcePorts, ContextSourceSelection, CurrentTurnSources, RunIdentity, HistoryIdentity, ToolPort, ToolResult } from '@gugu/core/agent'
import type { ProviderRuntimeOptions } from '@gugu/core/providers'
import type { OwnedCurrentMessage } from './context/agent-context-source.js'
import { createPostgresCurrentTurnReader, createWebAgentSourceLoader } from './context/agent-context-source.js'
import { createPersistentAgentRuntime, type PersistentAgentRuntimeOptions } from './agent-persistent-runtime.js'
import { createPostgresAgentRunStore } from './persistence/agent-run-store-postgres.js'
import type { AgentDispatchLease } from './persistence/agent-run-dispatch-postgres.js'
import type { createAgentToolRegistry } from './tools/agent-tool-registry.js'
import { createMcpAgentToolPorts, type AgentMcpToolPortsOptions } from './tools/agent-mcp-tool-ports.js'

/** 不含密钥、配置版本或底层异常的可公开错误类型。 */
export class AgentReconstructionVersionError extends Error {}

export interface WebAgentBinding {
  selection: ContextSourceSelection
  resolve: ProviderRuntimeOptions['resolve']
  release(): void
}
export interface WebAgentReconstructionResources {
  /** 每个业务数据源均为真实服务；没有服务应返回 null，不得提供假空值。 */
  source: Omit<ContextSourcePorts, 'readSnapshot' | 'historyReader' | 'currentTurn' | 'select' | 'digest' | 'nextId' | 'data'> & { data: Omit<ContextSourcePorts['data'], 'loadImMemory'> }
  context: Omit<CanonicalContextPorts, 'load'>
  preparation: Omit<CanonicalRunPreparationPorts, 'discover'>
  /** 工具 schema 发现和运行时分派必须复用同一个授权注册器。 */
  toolRegistry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities' | 'tools'>
  /** MCP 目录、执行 runtime 与权限由 Host 按同一 lease/owner 装配；缺省时不暴露远端工具。 */
  mcp?: AgentMcpToolPortsOptions
  materialize(identity: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal): Promise<CurrentTurnSources>
  runtime: Omit<PersistentAgentRuntimeOptions['runtime'], 'tools'>
  executor: PersistentAgentRuntimeOptions['executor']
  provider: Omit<PersistentAgentRuntimeOptions['provider'], 'resolve'>
  interactionActivation?: PersistentAgentRuntimeOptions['interactionActivation']
}

/** 同一个租约绑定注册器同时提供 Provider schema 和 Harness 实际分派端口。 */
export function createWebAgentToolPorts(
  lease: Pick<AgentDispatchLease, 'identity'>,
  registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities' | 'tools'>,
  preparation: Omit<CanonicalRunPreparationPorts, 'discover'>,
  mcp?: AgentMcpToolPortsOptions,
): { tools: typeof registry.tools; preparation: CanonicalRunPreparationPorts } {
  const identity = Object.freeze({ ...lease.identity })
  const boundRegistry = mcp ? createMcpAgentToolPorts({ base: registry, ...mcp }) : registry
  const matchesLease = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
    && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
  const plan = boundRegistry.tools.plan
  const tools: ToolPort = {
    ...(plan ? { async plan(calls, candidate) {
      if (!matchesLease(candidate)) throw new AgentReconstructionVersionError('工具运行身份不匹配')
      return plan(calls, candidate)
    } } : {}),
    async dispatch(call, scope) {
      scope.signal.throwIfAborted()
      if (!matchesLease(scope.identity)) return {
        kind: 'completed', value: { error: '工具运行身份不匹配' }, successful: false, mutated: false, executed: false,
      } satisfies ToolResult
      return boundRegistry.tools.dispatch(call, scope)
    },
    async reconcile(call, candidate) {
      if (!matchesLease(candidate)) return { kind: 'unknown' }
      return boundRegistry.tools.reconcile(call, candidate)
    },
  }
  return {
    tools,
    preparation: {
      ...preparation,
      async discover(input, signal) {
        signal.throwIfAborted()
        if (input.identity.ownerId !== identity.ownerId || input.identity.subject.kind !== 'session'
          || input.identity.subject.id !== identity.sessionId) throw new AgentReconstructionVersionError('工具运行身份不匹配')
        const configured = new Set(input.toolNames)
        const definitions = await boundRegistry.capabilities(identity)
        signal.throwIfAborted()
        return definitions.filter(definition => configured.has(definition.name))
      },
    },
  }
}
export interface WebAgentReconstructorOptions {
  pool: PersistentAgentRuntimeOptions['pool']
  secretKey: string
  redis: PersistentAgentRuntimeOptions['redis']
  subscribe: PersistentAgentRuntimeOptions['subscribe']
  history: PersistentAgentRuntimeOptions['history']
  readReconstructionStatus(identity: RunIdentity): Promise<'unavailable' | 'version_conflict' | null>
  /** 已有模型身份只来自已认证解密的 checkpoint；版本发生变化应返回 null。 */
  bind(lease: AgentDispatchLease, checkpoint: CanonicalRunContext | null): Promise<WebAgentBinding | null>
  resources(lease: AgentDispatchLease, binding: WebAgentBinding): Promise<WebAgentReconstructionResources | null>
}

/** Web gateway 的请求来源已由调度载荷验证；历史会话来源不影响本次请求。 */
export function createWebImMemoryLoader(lease: AgentDispatchLease) {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new AgentReconstructionVersionError('运行来源无法验证')
  const { ownerId, sessionId } = lease.identity
  return async (identity: HistoryIdentity, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (identity.ownerId !== ownerId || identity.sessionId !== sessionId) throw new Error('运行身份不匹配')
    return {}
  }
}

/** 恢复只装配可信版本匹配的真实端口；缺失时保留排队，不重新选择不兼容模型。 */
export function createWebAgentReconstructor(options: WebAgentReconstructorOptions) {
  const store = createPostgresAgentRunStore<CanonicalRunContext>(options.pool, options.secretKey, options.history)
  return async (lease: AgentDispatchLease) => {
    const id = lease.identity
    if (lease.input.v !== 2 || lease.input.source !== 'web') throw new AgentReconstructionVersionError('运行来源无法验证')
    const anchor = await options.pool.query(`SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [id.ownerId, id.sessionId, lease.input.userMessageId])
    if (anchor.rowCount !== 1) throw new Error('运行消息锚点不存在')
    const checkpoint = await store.read(id)
    if ((lease.mode === 'resume') !== Boolean(checkpoint)) throw new Error('运行恢复状态不匹配')
    const binding = await options.bind(lease, checkpoint?.context ?? null)
    if (!binding) return null
    try {
      const resources = await options.resources(lease, binding)
      if (!resources) { binding.release(); return null }
      const selection = binding.selection
      if (selection.contextScopeKey !== lease.input.accessVersion || !selection.modelIdentity || (lease.input.locale && selection.locale !== lease.input.locale)) throw new AgentReconstructionVersionError('运行授权或语言版本不匹配')
      if (checkpoint?.context && checkpoint.context.modelIdentity !== selection.modelIdentity) throw new AgentReconstructionVersionError('运行模型身份不匹配')
      const expected = contextAccessScopeHash(id, selection, resources.context.digest)
      if (checkpoint?.context && checkpoint.context.accessScopeHash !== expected) throw new AgentReconstructionVersionError('运行访问范围不匹配')
      const selected = await binding.resolve(id, selection.modelIdentity, new AbortController().signal)
      if (selected.modelIdentity !== selection.modelIdentity || selected.accessScopeHash !== expected) throw new AgentReconstructionVersionError('Provider 访问范围不匹配')
      const source = createWebAgentSourceLoader(options.pool, { ...resources.source, data: { ...resources.source.data, loadImMemory: createWebImMemoryLoader(lease) }, digest: resources.context.digest, nextId: resources.context.nextId,
        select: async () => selection, currentTurn: createPostgresCurrentTurnReader(options.pool, String(lease.input.userMessageId), resources.materialize) })
      const toolPorts = createWebAgentToolPorts(lease, resources.toolRegistry, resources.preparation, resources.mcp)
      const instance = createPersistentAgentRuntime({ pool: options.pool, secretKey: options.secretKey, redis: options.redis, subscribe: options.subscribe, history: options.history,
        context: { ...resources.context, load: source.load }, runPreparation: toolPorts.preparation,
        runtime: { ...resources.runtime, tools: toolPorts.tools }, executor: resources.executor,
        provider: { ...resources.provider, resolve: binding.resolve }, interactionActivation: resources.interactionActivation,
        scheduling: { mode: 'dispatch', readReconstructionStatus: options.readReconstructionStatus, leaseFor: target => target.ownerId === id.ownerId && target.sessionId === id.sessionId && target.runId === id.runId ? lease : null } })
      let closed = false
      return { harness: instance.harness, cancellation: instance.cancellation, async close() { if (closed) return; closed = true; try { await instance.close() } finally { binding.release() } } }
    } catch (error) { binding.release(); throw error }
  }
}
