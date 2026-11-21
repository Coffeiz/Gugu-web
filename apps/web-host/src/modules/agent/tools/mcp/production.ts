import type { RunIdentity } from '@gugu/core/agent'
import type { AgentMcpToolPortsOptions } from './ports.js'

/** 为 Web Run 注入真实 owner 目录与 MCP runtime，并在调用前复核当前允许目录。 */
export function createWebAgentMcpProductionPorts(options: Pick<AgentMcpToolPortsOptions, 'directory' | 'runtime' | 'services'>): AgentMcpToolPortsOptions {
  return {
    ...options,
    async authorize(identity: RunIdentity, name: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!name.startsWith('mcp_') || name.length > 256) return false
      if (options.services) return true // 共享工具端口负责按当前目录复核，Web Run 另行校验租约。
      const tools = await options.directory(identity.ownerId)
      signal?.throwIfAborted()
      return tools.some(tool => tool.name === name)
    },
  }
}
