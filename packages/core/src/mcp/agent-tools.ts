import type { PreparedToolDefinition, RunIdentity, ToolCall, ToolPlan, ToolResult } from '../agent/models.js'
import type { ToolPort } from '../agent/ports.js'
import type { McpDirectoryTool, McpServiceSummary, McpToolLookup } from './tool-directory.js'

type Registry = { capabilities(identity: RunIdentity): Promise<PreparedToolDefinition[]>; tools: ToolPort }
type RuntimeDispatch = { result: string; executed?: boolean } | { error: string; executed?: boolean } | { uncertain: true }

export interface AgentMcpToolPortsOptions {
  services?(ownerId: string): Promise<readonly McpServiceSummary[]>
  directory(ownerId: string, lookup?: McpToolLookup): Promise<readonly McpDirectoryTool[]>
  runtime: { dispatchForAgent(ownerId: string, serverId: string, name: string, args: unknown, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<RuntimeDispatch> }
  authorize(identity: RunIdentity, name: string, signal?: AbortSignal): Promise<boolean>
  configured?(identity: RunIdentity, name: string, signal?: AbortSignal): Promise<boolean>
}

/** Web 与 Desktop 共用动态 MCP 声明、串行计划、授权和未知结果处理。 */
export function createMcpAgentToolPorts(options: AgentMcpToolPortsOptions & { base: Registry }) {
  async function allowed(identity: RunIdentity, name: string, signal?: AbortSignal) {
    try { return await options.configured?.(identity, name, signal) !== false && await options.authorize(identity, name, signal) === true }
    catch { return false }
  }
  async function declared(ownerId: string, lookup?: McpToolLookup) {
    const result = new Map<string, McpDirectoryTool>()
    for (const tool of await options.directory(ownerId, lookup))
      if (tool.name.startsWith('mcp_') && !result.has(tool.name)) result.set(tool.name, tool)
    return result
  }
  const tools: ToolPort = {
    async plan(calls, identity): Promise<ToolPlan> {
      if (calls.some(call => call.name.startsWith('mcp_'))) return { mode: 'serial' }
      return options.base.tools.plan ? options.base.tools.plan(calls, identity) : { mode: 'parallel', maxConcurrency: 5 }
    },
    async dispatch(call: ToolCall, scope): Promise<ToolResult> {
      if (!call.name.startsWith('mcp_')) return options.base.tools.dispatch(call, scope)
      const identity = Object.freeze({ ...scope.identity })
      scope.signal.throwIfAborted()
      if (!await allowed(identity, call.name, scope.signal))
        return { kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false }
      const tool = (await declared(identity.ownerId, options.services ? { names: [call.name] } : undefined)).get(call.name)
      if (!tool) return { kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false }
      scope.signal.throwIfAborted()
      let result: RuntimeDispatch
      try { result = await options.runtime.dispatchForAgent(identity.ownerId, tool.server_id, tool.name, call.input, scope.signal,
        options.services ? () => allowed(identity, call.name, scope.signal) : undefined) }
      catch { return { kind: 'unknown' } }
      if ('uncertain' in result) return { kind: 'unknown' }
      if ('error' in result) {
        const executed = result.executed !== false
        return { kind: 'completed', value: { error: result.error }, successful: false, mutated: executed, executed }
      }
      if (result.executed === false)
        return { kind: 'completed', value: { result: result.result }, successful: false, mutated: false, executed: false }
      return { kind: 'completed', value: { result: result.result }, successful: true, mutated: true, executed: true }
    },
    async reconcile(call, identity) {
      if (call.name.startsWith('mcp_')) return { kind: 'unknown' }
      return options.base.tools.reconcile(call, identity)
    },
  }
  return {
    async capabilities(identity: RunIdentity, lookup?: McpToolLookup): Promise<PreparedToolDefinition[]> {
      identity = Object.freeze({ ...identity })
      const builtins = await options.base.capabilities(identity)
      if (options.services && !lookup) return builtins
      const names = new Set(builtins.map(tool => tool.name))
      const dynamic: PreparedToolDefinition[] = []
      for (const [name, tool] of await declared(identity.ownerId, options.services ? lookup : undefined)) {
        if (names.has(name) || !await allowed(identity, name)) continue
        names.add(name)
        dynamic.push({ name, schema: { type: 'function', function: {
          name, description: tool.description, parameters: tool.input_schema,
        } } as PreparedToolDefinition['schema'] })
      }
      return options.services && lookup?.server ? dynamic : [...builtins, ...dynamic]
    },
    tools,
  }
}
