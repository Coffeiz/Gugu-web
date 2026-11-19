import type { RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import type { McpDirectoryTool } from '@gugu/core/mcp/tool-directory'
import { allowsScheduledMcpTool, type createScheduledTaskRunToolPorts } from '@gugu/core/scheduled-task-run-now'
import { createKyselyScheduledTaskExecutionReader, type ScheduledTaskExecutionPlan } from '@gugu/core/scheduled-task-run-now-read'
import { createMcpAgentToolPorts } from '../../modules/agent-sessions/tools/agent-mcp-tool-ports.js'
import type { createMcpRuntime } from '../mcp/runtime.js'

export interface ScheduledMcpToolsOptions {
  directory(ownerId: string): Promise<readonly McpDirectoryTool[]>
  runtime: Pick<ReturnType<typeof createMcpRuntime>, 'dispatchForAgent'>
}

export function createScheduledMcpToolResources(core: SqlDataRuntime, options: ScheduledMcpToolsOptions, now: () => Date) {
  const configs = createMcpServerConfigLister(core.db, core.backend)
  const readTask = createKyselyScheduledTaskExecutionReader(core.db, core.backend)
  return async (task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'authorizedTools'>, identity: RunIdentity):
  Promise<Parameters<typeof createScheduledTaskRunToolPorts>[0]['mcp']> => {
    const expected = Object.freeze({ ...identity })
    const { id, ownerId } = task
    const initial = [...task.authorizedTools]
    let available: readonly McpDirectoryTool[]
    try {
      const [directory, servers] = await Promise.all([options.directory(ownerId), configs(ownerId)])
      const modes = new Map(servers.filter(row => row.enabled && row.transport === 'http').map(row => [row.id, row.confirm_mode]))
      available = directory.filter(tool => allowsScheduledMcpTool(initial, tool.name, modes.get(tool.server_id) ?? ''))
    } catch {
      // 与 Python 一致，MCP 发现失败只移除此轮的远端能力。
      return undefined
    }
    if (!available.length) return undefined
    const byName = new Map(available.map(tool => [tool.name, tool]))
    return {
      names: [...byName.keys()],
      bind(base, isCurrent) {
        // 冻结已选中的工具与服务器映射。每次外呼仍按数据库中的最新任务和服务器复核。
        return createMcpAgentToolPorts({
          base,
          async directory(candidate) { return candidate === ownerId ? available : [] },
          async authorize(identity, name) { return byName.has(name) && await isCurrent(identity) },
          runtime: {
            async dispatchForAgent(candidate, serverId, name, input, signal) {
              if (candidate !== ownerId || byName.get(name)?.server_id !== serverId)
                return { error: '当前定时任务无权调用该 MCP 工具', executed: false }
              return options.runtime.dispatchForAgent(ownerId, serverId, name, input, signal, async server => {
                const current = await readTask(ownerId, id, now().getTime())
                signal?.throwIfAborted()
                if (!('plan' in current) || !allowsScheduledMcpTool(initial, name, server.confirm_mode)) return false
                const names = current.plan.authorizedTools
                // 显式授权被撤销后不能在同一轮改走空列表的自动授权。
                return (!initial.length || names.includes(name)) && allowsScheduledMcpTool(names, name, server.confirm_mode)
                  && await isCurrent(expected)
              })
            },
          },
        })
      },
    }
  }
}
