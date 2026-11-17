import type { PreparedToolDefinition, RunIdentity, ToolCall, ToolPlan, ToolPort, ToolResult } from '@gugu/core/agent'
import type { McpDirectoryTool } from '@gugu/core/mcp/tool-directory'
import type { createAgentToolRegistry } from './agent-tool-registry.js'

type Registry = Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities' | 'tools'>
type RuntimeDispatch = { result: string; executed?: boolean } | { error: string; executed?: boolean } | { uncertain: true }

export interface AgentMcpToolPortsOptions {
  directory(ownerId: string): Promise<readonly McpDirectoryTool[]>
  runtime: { dispatchForAgent(ownerId: string, serverId: string, name: string, args: unknown, signal?: AbortSignal): Promise<RuntimeDispatch> }
  authorize(identity: RunIdentity, name: string): Promise<boolean>
}

/** 将 owner-scoped MCP 声明接到同一 Harness ToolPort；远端调用状态不确定时禁止重放。 */
export function createMcpAgentToolPorts(options: {
  base: Registry
} & AgentMcpToolPortsOptions) {
  async function authorized(identity: RunIdentity, name: string): Promise<boolean> {
    try { return await options.authorize(identity, name) === true } catch { return false }
  }

  async function declared(ownerId: string): Promise<Map<string, McpDirectoryTool>> {
    const rows = await options.directory(ownerId), result = new Map<string, McpDirectoryTool>()
    for (const row of rows) {
      if (!row.name.startsWith('mcp_') || result.has(row.name)) continue
      result.set(row.name, row)
    }
    return result
  }

  function definition(tool: McpDirectoryTool): PreparedToolDefinition {
    return {
      name: tool.name,
      schema: {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      } as PreparedToolDefinition['schema'],
    }
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
      if (!await authorized(identity, call.name)) return { kind: 'completed', value: { error: '没有权限使用此工具' }, successful: false, mutated: false, executed: false }
      const tool = (await declared(identity.ownerId)).get(call.name)
      if (!tool) return { kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false }
      scope.signal.throwIfAborted()
      let outcome: RuntimeDispatch
      try { outcome = await options.runtime.dispatchForAgent(identity.ownerId, tool.server_id, tool.name, call.input, scope.signal) }
      catch {
        // tools/call 发起后无法证明远端未提交；Core Harness 必须保留 unknown 收据，不得自动重发。
        return { kind: 'unknown' }
      }
      if ('uncertain' in outcome) return { kind: 'unknown' }
      if ('error' in outcome) {
        const executed = outcome.executed !== false
        return { kind: 'completed', value: { error: outcome.error }, successful: false, mutated: executed, executed }
      }
      if (outcome.executed === false) return { kind: 'completed', value: { result: outcome.result }, successful: false, mutated: false, executed: false }
      return { kind: 'completed', value: { result: outcome.result }, successful: true, mutated: true, executed: true }
    },
    async reconcile(call, identity): Promise<ToolResult> {
      if (call.name.startsWith('mcp_')) return { kind: 'unknown' }
      return options.base.tools.reconcile(call, identity)
    },
  }

  return {
    async capabilities(identity: RunIdentity): Promise<PreparedToolDefinition[]> {
      identity = Object.freeze({ ...identity })
      const builtins = await options.base.capabilities(identity)
      const names = new Set(builtins.map(item => item.name))
      const dynamic: PreparedToolDefinition[] = []
      for (const tool of await declared(identity.ownerId)) {
        if (names.has(tool[0]) || !await authorized(identity, tool[0])) continue
        names.add(tool[0]); dynamic.push(definition(tool[1]))
      }
      return [...builtins, ...dynamic]
    },
    tools,
  }
}

