import { createOwnerToolRegistry, type OwnerToolOptions } from '../../tools/owner.js'
import { sceneAllowsBackgroundTool, sceneAllowsTool, selectScheduledAgentScene } from '../policy.js'
import { filterConfiguredAgentTools } from '../../tools/configuration.js'
import { createAgentMindReader } from '../../../mind/note-read.js'
import { createSqlMindCanvasReader } from '../../../mind/canvas-read.js'
import { createAgentCalendarReader } from '../../../calendar/application/event-read.js'
import { createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort } from '../../../calendar/read-store.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '../../../tasks/task-list.js'
import type { RunIdentity } from '../../models.js'
import { createAgentRunToolPorts } from '../../run/tool-ports.js'
import { createScheduledShell, type ScheduledShellBinding } from './shell.js'
import type { ToolDefinition } from '../../tools/contracts.js'
import { createSearchToolsTool } from '../../tools/meta/index.js'
import { createToolRegistry } from '../../tools/registry.js'
import type { ScheduledTaskExecutionPlan } from '../../../tasks/run-now-read.js'
import type { AssertScheduledTaskLease } from '@gugu/scheduler'

/** 使用主 Run 的工具定义与业务端口，宿主只注入环境能力。 */
export function createScheduledOwnerToolDefinitions(core: OwnerToolOptions['core'], time: NonNullable<OwnerToolOptions['time']>,
  resources: Partial<Omit<OwnerToolOptions, 'core' | 'time' | 'authorize'>> = {},
) {
  const { db, backend } = core
  const scheduledTasks = createScheduledTaskQueries(createKyselyScheduledTaskReader(db, backend),
    () => ({ workspaceSupported: backend === 'postgres', filesystemAuthorizationEnabled: false }))
  const catalog = createOwnerToolRegistry({
    core, time, authorize: async () => false,
    events: createKyselyCalendarReadPort(db, backend),
    calendar: createAgentCalendarReader(createKyselyCalendarAgentReadPort(db, backend)),
    notes: createAgentMindReader(db, backend),
    canvases: createSqlMindCanvasReader(db, backend),
    scheduledTasks: { list: (identity, signal) => scheduledTasks.agent(identity.ownerId, signal) },
    ...resources,
  })
  return catalog.definitions
}

type ToolRegistry = Pick<ReturnType<typeof createToolRegistry>, 'capabilities' | 'tools'>

/** 自动执行的 MCP 工具沿用服务器配置，需要确认的工具使用历史任务授权。 */
export function allowsScheduledMcpTool(names: readonly string[], tool: string, mode: string): boolean {
  if (!tool.startsWith('mcp_') || (mode !== 'auto' && mode !== 'confirm_all')) return false
  return mode === 'auto' || names.includes(tool)
}

function createScheduledToolVisibility(names: ReadonlySet<string>, gates: Readonly<Record<string, () => Promise<boolean>>>) {
  async function available(name: string) {
    return names.has(name) && (!Object.hasOwn(gates, name) || await gates[name]!())
  }
  return {
    async filter(configured: readonly string[]) {
      const visible = await Promise.all(configured.map(available))
      return configured.filter((_, index) => visible[index])
    },
  }
}

/** Web 与桌面共用工具筛选、任务身份及执行前复核。 */
export function createScheduledTaskRunToolPorts(options: {
  identity: RunIdentity
  task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'workspaceId' | 'groupScope'> & Partial<Pick<ScheduledTaskExecutionPlan, 'channels'>>
  assertLease: AssertScheduledTaskLease
  isCurrent(): Promise<boolean>
  isGroupScopeCurrent?(): Promise<boolean>
  isGroupMemoryCurrent?(): Promise<boolean>
  definitions: readonly ToolDefinition[]
  ownerDefinitions?: readonly ToolDefinition[]
  filterConfigured?(names: readonly string[]): readonly string[] | Promise<readonly string[]>
  shell?: ScheduledShellBinding
  core?: OwnerToolOptions['core']
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
  const scene = selectScheduledAgentScene(task.channels, Boolean(task.groupScope))
  const ownerDefinitions = task.groupScope
    ? options.ownerDefinitions?.filter(tool => tool.definition.name === 'get_current_time')
    : options.ownerDefinitions
  const definitions = [...(ownerDefinitions ?? []), ...options.definitions]
    .filter(tool => tool.definition.name !== 'search_tools' && sceneAllowsBackgroundTool(scene, tool,
      Boolean(task.groupScope), tool.definition.name === 'shell' && Boolean(options.shell) && !task.groupScope))
  if (options.sendFile) {
    if (options.sendFile.definition.name !== 'send_item' || options.sendFile.destructive || options.sendFile.requiresInteraction)
      throw new Error('定时附件工具定义无效')
    definitions.push(options.sendFile)
  }
  const names = new Set(['search_tools', ...definitions.map(tool => tool.definition.name)])
  const shell = !task.groupScope && options.shell
    ? createScheduledShell(options.shell, assertLease, isCurrent)
    : undefined
  if (shell) names.add('shell')
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
    shell: async () => await shell?.available() === true,
    send_email: async () => await email?.isAuthorized() === true,
    group_context_search: async () => await options.isGroupScopeCurrent?.() === true,
    search_memory: async () => await options.isGroupMemoryCurrent?.() === true,
  })
  async function filterConfigured(names: readonly string[]) {
    const known = filterConfiguredAgentTools(names)
    const permitted = new Set(await (options.filterConfigured?.(known) ?? known))
    // 停止当前周期任务由调度器按租约和投递结果控制，不属于主 Run 工具目录。
    return visibility.filter(names.filter(name => sceneAllowsTool(scene, name) && (name === 'stop_recurring' || permitted.has(name))))
  }
  const discovery = createSearchToolsTool(async candidate => {
    if (!await current(candidate)) return []
    const names = new Set(await filterConfigured([...configuredNames]))
    return (await registry.capabilities(candidate)).filter(definition => names.has(definition.name))
  })
  const builtins = createToolRegistry({
    tools: [...definitions, discovery],
    preauthorizedDestructiveTools: [...(email ? [email.tool] : []), ...(shell ? [shell.tool] : [])],
    async authorize(candidate, name) {
      return names.has(name) && await current(candidate) && (await filterConfigured([name])).includes(name)
    },
  })
  const registry: ToolRegistry = options.mcp?.bind(builtins, current) ?? builtins
  return createAgentRunToolPorts({
    identity, registry,
    configurationMatches: config => config.source === 'scheduled_task' && config.identity.subject.kind === subject.kind
      && config.identity.subject.id === subject.id && config.identity.workspaceId === selection.workspaceId,
    preparation: {
      async configuration(candidate, signal) {
        signal.throwIfAborted()
        if (!await current(candidate)) throw new Error('定时任务工具授权已失效')
        signal.throwIfAborted()
        const toolNames = await filterConfigured([...configuredNames])
        return { identity: selection, source: 'scheduled_task', toolNames }
      },
      capabilities: {
        workspaceSupported: false,
        filterConfigured,
        async shellPolicy() { return { allowed: await shell?.available() === true, needsConfirmation: false } },
        async shellState() { return await shell?.state() ?? null },
        appendShellProtocol(system) { return system },
        async catalog() { return null },
      },
      formatPrefix({ original }) { return original.fixedPrefix },
    },
  })
}
