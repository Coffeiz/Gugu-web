import type { RunIdentity } from '@gugu/core/agent'
import type { AgentMcpToolPortsOptions } from './agent-mcp-tool-ports.js'

/** 为 Web Run 注入真实 owner 目录与 MCP runtime，并在调用前复核当前允许目录。 */
export function createWebAgentMcpProductionPorts(options: Pick<AgentMcpToolPortsOptions, 'directory' | 'runtime'>): AgentMcpToolPortsOptions {
  return {
    ...options,
    async authorize(identity: RunIdentity, name: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!name.startsWith('mcp_') || name.length > 256) return false
      const tools = await options.directory(identity.ownerId)
      signal?.throwIfAborted()
      return tools.some(tool => tool.name === name)
    },
  }
}
