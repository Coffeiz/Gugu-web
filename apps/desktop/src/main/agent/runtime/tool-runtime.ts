import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { PreparedToolDefinition, RunIdentity } from '#core-source/agent/models.js'
import type { ToolPort } from '#core-source/agent/ports.js'
import type { ToolDefinition } from '#core-source/agent/tools/contracts.js'
import type { BuiltinSkillDefinition } from '#core-source/agent/skills/builtin.js'
import type { McpToolLookup } from '#core-source/mcp/tool-directory.js'
import type { createDesktopMcpCrypto } from '#core-source/mcp/desktop-crypto.js'
import type { createOwnerToolRegistry } from '#core-source/agent/tools/owner.js'
import { createNodeProviderTransport, desktopTransportOptions, type NodeProviderTransportOptions } from '#core-source/agent/providers/transport/node.js'
import { createDesktopMcpAgentRuntime } from '#core-source/mcp/desktop-agent-runtime.js'
import { createMcpAgentToolPorts } from '#core-source/mcp/agent-tools.js'
import { createToolRegistry } from '#core-source/agent/tools/registry.js'
import { createSkillRegistry } from '#core-source/agent/skills/registry.js'
import { createSearchToolsTool, createUseSkillTool } from '#core-source/agent/tools/meta.js'
import { createTimeTool, type ToolClock } from '#core-source/agent/tools/time.js'
import { createCallToolAdapter, rejectAdapterCall, resolveCallTool } from '#core-source/agent/tools/call-adapter.js'
import { createGroupContextSearchTool } from '#core-source/agent/tools/group-context.js'
import { createDesktopGroupContextSearch } from '#core-source/im/desktop-group-context.js'
import { desktopImGroupRunEvent } from '#core-source/im/desktop-inbox.js'
import { createHttpGetTool, type HttpGetPort } from '#core-source/agent/tools/web.js'
import { imCanUseTool, imSkillToolsAvailable, imUnavailableTool } from '#core-source/agent/scenes/im/index.js'
import { canonicalAgentToolName } from '#core-source/agent/index.js'

export function createDesktopToolRuntime(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  sessionId: number
  interactive: boolean
  imSession: boolean
  imChatType: string | undefined
  groupChat: boolean
  registry: ReturnType<typeof createOwnerToolRegistry>
  mcpCrypto: ReturnType<typeof createDesktopMcpCrypto>
  resolveProxy: NodeProviderTransportOptions['resolveProxy']
  authorize: (identity: RunIdentity) => Promise<boolean>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  configuredAgentTools: (names: readonly string[], signal?: AbortSignal) => Promise<string[]>
  desktopPrivateImOwner: (identity: RunIdentity, signal?: AbortSignal) => Promise<Parameters<typeof imCanUseTool>[0] | null>
  sceneBuiltins: BuiltinSkillDefinition[]
  agentClock: ToolClock
  groupScheduleList: ToolDefinition
  scheduleWrites: readonly ToolDefinition[]
  scheduleImTarget: (identity: RunIdentity) => Promise<unknown>
  researchAvailable: unknown
  imageSearchAvailable: unknown
  deepResearch: ToolDefinition
  similarImageSearch: ToolDefinition
  webSearch: ToolDefinition | undefined
  httpGet: HttpGetPort
  sendFile: ToolDefinition | undefined
  delegationTools: () => readonly ToolDefinition[]
}) {
  const { db, ownerId, sessionId, interactive, imSession, imChatType, groupChat, registry, mcpCrypto,
    resolveProxy, authorize, hostRequest, configuredAgentTools, desktopPrivateImOwner, sceneBuiltins, agentClock,
    groupScheduleList, scheduleWrites, scheduleImTarget, researchAvailable, imageSearchAvailable, deepResearch,
    similarImageSearch, webSearch, httpGet, sendFile, delegationTools } = options
  // 可用性只决定是否开放新调用。已有调用的收据查询保留原工具的参数校验与运行授权。
  const recoveryTools = [
    ...(researchAvailable === true ? [] : [deepResearch]),
    ...(imageSearchAvailable === true ? [] : [similarImageSearch]),
  ]
  const unavailableSearch = new Set(recoveryTools.map(tool => tool.definition.name))
  const searchRecovery = createToolRegistry({ tools: recoveryTools, authorize }).tools
  const mcpRuntime = createDesktopMcpAgentRuntime(db, ownerId, mcpCrypto, {
    transport: () => createNodeProviderTransport({ ...desktopTransportOptions(false, resolveProxy),
      connectTimeoutMs: 10_000, writeTimeoutMs: 10_000 }),
    builtinNames: async () => new Set(registry.catalog().map(tool => tool.name)),
  })
  const mcpTools = createMcpAgentToolPorts({
    base: registry,
    directory: mcpRuntime.directory,
    services: mcpRuntime.services,
    runtime: mcpRuntime,
    configured: async (_identity, name) => (await configuredAgentTools([name])).length === 1,
    async authorize(identity, _name, signal) {
      signal?.throwIfAborted()
      return identity.ownerId === ownerId && identity.sessionId === String(sessionId) && await authorize(identity)
    },
  })
  async function authorizeGroupTool(identity: RunIdentity, name: string) {
    if (!await authorize(identity)) return false
    const receipt = await desktopImGroupRunEvent(db, identity)
    return receipt !== null && await hostRequest('agent.im.authorizeGroupTool', { ...receipt, name }) === true
  }
  const groupSkillRegistry = createSkillRegistry({
    skills: sceneBuiltins,
    async authorize(identity, id) {
      const skill = sceneBuiltins.find(candidate => candidate.id === id)
      if (!skill || !await authorizeGroupTool(identity, 'use_skill')) return false
      const available = new Set((await configuredTools(identity)).map(tool => tool.name))
      return available.has('use_skill') && imSkillToolsAvailable(skill, available)
    },
  })
  const groupTools = groupChat ? createToolRegistry({
    unavailableTool: imUnavailableTool,
    tools: [
      createTimeTool(agentClock), createCallToolAdapter(), createSearchToolsTool(identity => configuredTools(identity)),
      createUseSkillTool({ skills: groupSkillRegistry, async origin() { return { source: 'builtin' } } }),
      groupScheduleList, ...scheduleWrites,
      createGroupContextSearchTool(createDesktopGroupContextSearch(db, identity => authorizeGroupTool(identity, 'group_context_search'))),
      ...(webSearch ? [webSearch] : []),
      ...(imageSearchAvailable === true ? [similarImageSearch] : []),
      createHttpGetTool(httpGet),
      ...(sendFile ? [sendFile] : []),
    ],
    async authorize(identity, name) {
      if (!(await configuredAgentTools([name])).length || !await authorizeGroupTool(identity, name)) return false
      if (['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task'].includes(name))
        return Boolean(await scheduleImTarget(identity))
      return true
    },
  }) : undefined
  const delegation = (imSession ? (imChatType ?? 'c2c') === 'c2c' : interactive) ? createToolRegistry({
    tools: delegationTools(), authorize,
  }) : undefined
  const delegationNames = new Set(delegation?.catalog().map(tool => tool.name))
  async function configuredTools(identity: RunIdentity, lookup?: McpToolLookup): Promise<PreparedToolDefinition[]> {
    if (groupTools) return groupTools.capabilities(identity)
    const actor = imSession ? await desktopPrivateImOwner(identity) : null
    if (imSession && !actor) return []
    const definitions = [...await mcpTools.capabilities(identity, lookup),
      ...(lookup || !delegation ? [] : await delegation.capabilities(identity))]
    const allowed = new Set(await configuredAgentTools(definitions.map(tool => tool.name).filter(name => !actor || imCanUseTool(actor, name))))
    return definitions.filter(tool => allowed.has(tool.name))
  }
  async function mayForward(name: string, identity: RunIdentity, signal?: AbortSignal) {
    const allowed = new Set((await configuredTools(identity, name.startsWith('mcp_') ? { names: [name] } : undefined)).map(tool => tool.name))
    signal?.throwIfAborted()
    return allowed.has('call_tool') && allowed.has(canonicalAgentToolName(name))
  }
  const tools: ToolPort = {
    ...(groupTools?.tools ?? mcpTools.tools),
    ...(imSession ? { unavailableTool: imUnavailableTool } : {}),
    async resolveCall(call, identity, signal) {
      const target = resolveCallTool(call)
      if ('error' in target) return target
      if (!await mayForward(target.call.name, identity, signal))
        return imSession ? imUnavailableTool(target.call.name) : { error: '工具不存在或未开放' }
      return { call: { ...target.call, adapter: 'call_tool' } }
    },
    async dispatch(call, scope) {
      if (imSession && !groupTools) {
        const actor = await desktopPrivateImOwner(scope.identity, scope.signal)
        if (!actor || !imCanUseTool(actor, call.name)) {
          const rejection = imUnavailableTool(call.name)
          return rejectAdapterCall(rejection.error, rejection.error_code)
        }
      }
      if (groupTools) return groupTools.tools.dispatch(call, {
        ...scope, discoverRelatedTools: () => configuredTools(scope.identity),
      })
      if (delegation && delegationNames.has(call.name)) {
        if (!(await configuredAgentTools([call.name], scope.signal)).length) return rejectAdapterCall('工具不存在或未开放')
        return delegation.tools.dispatch(call, scope)
      }
      if (call.adapter === 'call_tool' && !await mayForward(call.name, scope.identity, scope.signal))
        return rejectAdapterCall('工具不存在或未开放')
      return mcpTools.tools.dispatch(call, {
        ...scope, discoverRelatedTools: lookup => configuredTools(scope.identity, lookup),
      })
    },
    async reconcile(call, identity) {
      if (imSession && !groupTools) {
        const actor = await desktopPrivateImOwner(identity)
        if (!actor || !imCanUseTool(actor, call.name)) return { kind: 'unknown' }
      }
      if (groupTools) return groupTools.tools.reconcile(call, identity)
      if (delegation && delegationNames.has(call.name)) return delegation.tools.reconcile(call, identity)
      if (unavailableSearch.has(call.name)) {
        if (call.adapter === 'call_tool' && !await mayForward('call_tool', identity)) return { kind: 'unknown' }
        return searchRecovery.reconcile(call, identity)
      }
      if (call.adapter === 'call_tool' && !await mayForward(call.name, identity)) return { kind: 'unknown' }
      return mcpTools.tools.reconcile(call, identity)
    },
  }
  return { tools, mcpRuntime, groupTools, groupSkillRegistry, delegation, configuredTools }
}
