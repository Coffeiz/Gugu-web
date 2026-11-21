import type { RunIdentity } from '../agent/models.js'
import { createAgentRunToolPorts } from '../agent/run/tool-ports.js'
import type { ToolDefinition } from '../agent/tools/contracts.js'
import { createToolRegistry } from '../agent/tools/registry.js'
import type { ScheduledTaskExecutionPlan } from './run-now-read.js'
import type { AssertScheduledTaskLease } from './runner.js'

type ToolRegistry = Pick<ReturnType<typeof createToolRegistry>, 'capabilities' | 'tools'>

/** 历史任务可保存显式 MCP 授权。空列表只允许无需交互确认的服务器。 */
export function allowsScheduledMcpTool(names: readonly string[], tool: string, mode: string): boolean {
  if (!tool.startsWith('mcp_') || (mode !== 'auto' && mode !== 'confirm_all')) return false
  return names.length === 0 ? mode === 'auto' : names.includes(tool)
}

function createScheduledToolVisibility(names: ReadonlySet<string>, gates: Readonly<Record<string, () => Promise<boolean>>>) {
  async function available(name: string) {
    return names.has(name) && (!Object.hasOwn(gates, name) || await gates[name]!())
  }
  return {
    available,
    async filter(configured: readonly string[]) {
      const visible = await Promise.all(configured.map(available))
      return configured.filter((_, index) => visible[index])
    },
  }
}

/** 内置读取与单独授权的 MCP 端口共用此任务及运行身份。 */
export function createScheduledTaskRunToolPorts(options: {
  identity: RunIdentity
  task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'workspaceId'>
  assertLease: AssertScheduledTaskLease
  isCurrent(): Promise<boolean>
  isGroupScopeCurrent?(): Promise<boolean>
  isGroupMemoryCurrent?(): Promise<boolean>
  definitions: readonly ToolDefinition[]
  sendFile?: ToolDefinition
  email?: { tool: ToolDefinition; isAuthorized(): Promise<boolean> }
  mcp?: { names: readonly string[]; bind(base: ToolRegistry, isCurrent: (identity: RunIdentity) => Promise<boolean>): ToolRegistry }
}) {
  const { task, assertLease, isCurrent } = options
  const identity = Object.freeze({ ...options.identity })
  if (identity.ownerId !== task.ownerId || identity.sessionId !== `scheduled-task:${task.id}`)
    throw new Error('定时任务工具身份不匹配')
  const subject = Object.freeze({ kind: 'scheduled_task' as const, id: task.id })
  const selection = Object.freeze({ ownerId: identity.ownerId, subject, workspaceId: task.workspaceId === null ? null : String(task.workspaceId) })
  const definitions = options.definitions.filter(tool => tool.effect === 'read' && !tool.effectForInput && !tool.destructive && !tool.requiresInteraction)
  if (options.sendFile) {
    if (options.sendFile.definition.name !== 'send_file' || options.sendFile.destructive || options.sendFile.requiresInteraction)
      throw new Error('定时附件工具定义无效')
    definitions.push(options.sendFile)
  }
  const names = new Set(definitions.map(tool => tool.definition.name))
  const email = options.email
  if (email) {
    if (email.tool.definition.name !== 'send_email') throw new Error('定时邮件工具定义无效')
    names.add('send_email')
  }
  const configuredNames = new Set([...names, ...(options.mcp?.names ?? [])])
  const owns = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
    && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
  async function current(candidate: RunIdentity) {
    if (!owns(candidate)) return false
    await assertLease()
    return isCurrent()
  }
  const visibility = createScheduledToolVisibility(configuredNames, {
    send_email: async () => await email?.isAuthorized() === true,
    group_context_search: async () => await options.isGroupScopeCurrent?.() === true,
    search_memory: async () => await options.isGroupMemoryCurrent?.() === true,
  })
  const builtins = createToolRegistry({
    tools: definitions,
    preauthorizedDestructiveTool: email?.tool,
    async authorize(candidate, name) {
      return names.has(name) && await current(candidate) && await visibility.available(name)
    },
  })
  return createAgentRunToolPorts({
    identity, registry: options.mcp?.bind(builtins, current) ?? builtins,
    configurationMatches: config => config.source === 'scheduled_task' && config.identity.subject.kind === subject.kind
      && config.identity.subject.id === subject.id && config.identity.workspaceId === selection.workspaceId,
    preparation: {
      async configuration(candidate, signal) {
        signal.throwIfAborted()
        if (!await current(candidate)) throw new Error('定时任务工具授权已失效')
        signal.throwIfAborted()
        const toolNames = await visibility.filter([...configuredNames])
        return { identity: selection, source: 'scheduled_task', toolNames }
      },
      capabilities: {
        workspaceSupported: false,
        filterConfigured: visibility.filter,
        async shellPolicy() { return { allowed: false, needsConfirmation: false } },
        async shellState() { return null },
        appendShellProtocol(system) { return system },
        async catalog() { return null },
      },
      formatPrefix({ original }) { return original.fixedPrefix },
    },
  })
}
