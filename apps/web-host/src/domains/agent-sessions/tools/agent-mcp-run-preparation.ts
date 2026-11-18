import type { CanonicalRunPreparationPorts, RunIdentity } from '@gugu/core/agent'
import type { AgentMcpToolPortsOptions } from './agent-mcp-tool-ports.js'

type Configuration = Awaited<ReturnType<CanonicalRunPreparationPorts['configuration']>>

/**
 * Web MCP schema 必须进入与 Harness discovery 相同的 owner/session 配置快照。
 * 目录仅提供该 owner 当前已启用、已发现且通过白名单的工具名；执行时仍由
 * createWebAgentToolPorts 重新验证配置与授权。
 */
export function createWebAgentMcpRunPreparation(
  base: Pick<CanonicalRunPreparationPorts, 'configuration'>,
  mcp?: Pick<AgentMcpToolPortsOptions, 'directory'>,
): CanonicalRunPreparationPorts['configuration'] {
  return async (identity: RunIdentity, signal: AbortSignal): Promise<Configuration> => {
    signal.throwIfAborted()
    const configuration = await base.configuration(identity, signal)
    signal.throwIfAborted()
    if (configuration.source !== 'web') throw new Error('Web 运行来源无效')
    if (configuration.identity.ownerId !== identity.ownerId
      || configuration.identity.subject.kind !== 'session'
      || configuration.identity.subject.id !== identity.sessionId)
      throw new Error('运行身份不匹配')
    if (!mcp) return configuration

    const directory = await mcp.directory(identity.ownerId)
    signal.throwIfAborted()
    const names = new Set<string>()
    for (const tool of directory) {
      if (typeof tool.name === 'string' && tool.name.startsWith('mcp_') && tool.name.length <= 256)
        names.add(tool.name)
    }
    return { ...configuration, toolNames: [...new Set([...configuration.toolNames, ...names])] }
  }
}
