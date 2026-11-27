import type { McpToolLookup } from '../../mcp/tool-directory.js'
import { canonicalAgentToolName } from '../tools/configuration.js'
import type { PreparedToolDefinition, RunIdentity, ToolResult } from '../models.js'
import type { CanonicalRunPreparationPorts, ToolPort } from '../ports.js'
import { AgentRunReconstructionVersionError } from './dispatch-worker.js'
import { resolveCallTool } from '../tools/meta/call-adapter.js'

type AgentRunConfiguration = Awaited<ReturnType<CanonicalRunPreparationPorts['configuration']>>

/** 将 Host 注册器固定到一个可信 Run；来源/主体等平台策略由 Host 校验。 */
export function createAgentRunToolPorts(options: {
  identity: RunIdentity
  registry: {
    capabilities(identity: RunIdentity, lookup?: McpToolLookup): Promise<readonly PreparedToolDefinition[]>
    tools: ToolPort
  }
  lazyMcp?: boolean
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
    const configured = new Set(configuration.toolNames.map(canonicalAgentToolName).filter(name => names.includes(name)))
    const definitions = await options.registry.capabilities(identity)
    signal.throwIfAborted()
    return definitions.filter(definition => configured.has(definition.name))
  }
  async function discoverRelatedTools(signal: AbortSignal, lookup?: McpToolLookup) {
    const configuration = await options.preparation.configuration(identity, signal)
    const builtins = await configuredDefinitions(signal, configuration)
    if (!options.lazyMcp || !lookup || (!lookup.server && lookup.names && !lookup.names.some(name => name.startsWith('mcp_')))) return builtins
    if (!builtins.some(tool => tool.name === 'call_tool') || !builtins.some(tool => tool.name === 'search_tools')) return builtins
    const dynamic = (await options.registry.capabilities(identity, lookup)).filter(tool => tool.name.startsWith('mcp_'))
    signal.throwIfAborted()
    return lookup.server ? dynamic : [...builtins, ...dynamic]
  }
  async function mayForward(name: string, signal: AbortSignal) {
    const permitted = new Set((await discoverRelatedTools(signal, name.startsWith('mcp_') ? { names: [name] } : undefined)).map(definition => definition.name))
    return permitted.has('call_tool') && permitted.has(canonicalAgentToolName(name))
  }
  const unavailable = options.registry.tools.unavailableTool
  const tools: ToolPort = {
    ...(unavailable ? { unavailableTool: unavailable } : {}),
    async resolveCall(call, candidate, signal) {
      if (!matchesRun(candidate)) return { error: '工具运行身份不匹配' }
      const target = resolveCallTool(call)
      if ('error' in target || call.name !== 'call_tool') return target
      if (!await mayForward(target.call.name, signal))
        return unavailable?.(target.call.name) ?? { error: '工具不存在或未开放' }
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
        kind: 'completed', value: unavailable?.(call.name) ?? { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false,
      }
      return options.registry.tools.dispatch(call, { ...scope, discoverRelatedTools: lookup => discoverRelatedTools(scope.signal, lookup) })
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
      async discover(input, signal, preparedConfiguration) {
        signal.throwIfAborted()
        if (input.identity.ownerId !== identity.ownerId) throw new AgentRunReconstructionVersionError('工具运行身份不匹配')
        const configuration = preparedConfiguration ?? await options.preparation.configuration(identity, signal)
        signal.throwIfAborted()
        if (configuration.identity.ownerId !== input.identity.ownerId
          || configuration.identity.subject.kind !== input.identity.subject.kind
          || configuration.identity.subject.id !== input.identity.subject.id
          || configuration.identity.workspaceId !== input.identity.workspaceId)
          throw new AgentRunReconstructionVersionError('工具运行身份不匹配')
        const configured = new Set(input.toolNames.map(canonicalAgentToolName))
        const definitions = await configuredDefinitions(signal, configuration)
        return definitions.filter(definition => configured.has(definition.name))
      },
    },
  }
}
