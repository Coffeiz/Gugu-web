import type { PreparedToolDefinition, RunIdentity, ToolResult } from '../models.js'
import type { CanonicalRunPreparationPorts, ToolPort } from '../ports.js'
import { AgentRunReconstructionVersionError } from './dispatch-worker.js'
import { resolveCallTool } from '../tools/call-adapter.js'

type AgentRunConfiguration = Awaited<ReturnType<CanonicalRunPreparationPorts['configuration']>>

/** 将 Host 注册器固定到一个可信 Run；来源/主体等平台策略由 Host 校验。 */
export function createAgentRunToolPorts(options: {
  identity: RunIdentity
  registry: {
    capabilities(identity: RunIdentity): Promise<readonly PreparedToolDefinition[]>
    tools: ToolPort
  }
  preparation: Omit<CanonicalRunPreparationPorts, 'discover'>
  configurationMatches(configuration: AgentRunConfiguration, identity: RunIdentity): boolean | Promise<boolean>
}): { tools: ToolPort; preparation: CanonicalRunPreparationPorts } {
  const identity = Object.freeze({ ...options.identity })
  const matchesRun = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
    && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
  const plan = options.registry.tools.plan
  async function configuredDefinitions(signal: AbortSignal, configuration: AgentRunConfiguration) {
    if (configuration.identity.ownerId !== identity.ownerId || !await options.configurationMatches(configuration, identity))
      throw new AgentRunReconstructionVersionError('工具运行配置不匹配')
    const names = await options.preparation.capabilities.filterConfigured(configuration.toolNames, configuration.identity, signal)
    const configured = new Set(configuration.toolNames.filter(name => names.includes(name)))
    const definitions = await options.registry.capabilities(identity)
    signal.throwIfAborted()
    return definitions.filter(definition => configured.has(definition.name))
  }
  async function discoverRelatedTools(signal: AbortSignal) {
    const configuration = await options.preparation.configuration(identity, signal)
    return configuredDefinitions(signal, configuration)
  }
  async function mayForward(name: string, signal: AbortSignal) {
    const permitted = new Set((await discoverRelatedTools(signal)).map(definition => definition.name))
    return permitted.has('call_tool') && permitted.has(name)
  }
  const tools: ToolPort = {
    async resolveCall(call, candidate, signal) {
      if (!matchesRun(candidate)) return { error: '工具运行身份不匹配' }
      const target = resolveCallTool(call)
      if ('error' in target || call.name !== 'call_tool') return target
      if (!await mayForward(target.call.name, signal))
        return { error: '工具不存在或未开放' }
      return { call: { ...target.call, adapter: 'call_tool' } }
    },
    ...(plan ? { async plan(calls, candidate) {
      if (!matchesRun(candidate)) throw new AgentRunReconstructionVersionError('工具运行身份不匹配')
      return plan(calls, candidate)
    } } : {}),
    async dispatch(call, scope) {
      scope.signal.throwIfAborted()
      if (!matchesRun(scope.identity)) return {
        kind: 'completed', value: { error: '工具运行身份不匹配' }, successful: false, mutated: false, executed: false,
      } satisfies ToolResult
      if (call.adapter === 'call_tool' && !await mayForward(call.name, scope.signal)) return {
        kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false,
      }
      return options.registry.tools.dispatch(call, { ...scope, discoverRelatedTools: () => discoverRelatedTools(scope.signal) })
    },
    async reconcile(call, candidate) {
      if (!matchesRun(candidate)) return { kind: 'unknown' }
      if (call.adapter === 'call_tool' && !await mayForward(call.name, new AbortController().signal)) return { kind: 'unknown' }
      return options.registry.tools.reconcile(call, candidate)
    },
  }
  return {
    tools,
    preparation: {
      ...options.preparation,
      async discover(input, signal) {
        signal.throwIfAborted()
        if (input.identity.ownerId !== identity.ownerId) throw new AgentRunReconstructionVersionError('工具运行身份不匹配')
        const configuration = await options.preparation.configuration(identity, signal)
        signal.throwIfAborted()
        if (configuration.identity.ownerId !== input.identity.ownerId
          || configuration.identity.subject.kind !== input.identity.subject.kind
          || configuration.identity.subject.id !== input.identity.subject.id
          || configuration.identity.workspaceId !== input.identity.workspaceId)
          throw new AgentRunReconstructionVersionError('工具运行身份不匹配')
        const configured = new Set(input.toolNames)
        const definitions = await configuredDefinitions(signal, configuration)
        return definitions.filter(definition => configured.has(definition.name))
      },
    },
  }
}
