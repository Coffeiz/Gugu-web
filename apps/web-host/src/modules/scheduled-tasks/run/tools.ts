import type { RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createScheduledTaskGroupMemoryAuthorizer, createScheduledTaskGroupScopeVerifier, createScheduledTaskRunToolPorts, createScheduledOwnerToolDefinitions, allowsScheduledMcpTool } from '@gugu/core/agent/scenes/task'
import { createKyselyScheduledTaskRunNowReader, hasScheduledEmailAuthorization, type ScheduledTaskExecutionPlan, createKyselyScheduledTaskExecutionReader } from '@gugu/core/tasks/execution-read'
import { createAgentSkillRuntimePorts, createBuiltinSkillMetadataReader, createFileSkillDefinitions, isUserSkillBundleEnabled, withFileSkillMetadata, type BuiltinSkillDefinition } from '@gugu/core/skills'
import { createSkillManagementReadTools, createUseSkillTool, type AgentEmailAutomationClaim, type ToolDefinition } from '@gugu/core/tools'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import type { McpDirectoryTool } from '@gugu/core/mcp/tool-directory'
import { createMcpAgentToolPorts } from '../../agent/tools/mcp/ports.js'
import type { createMcpRuntime } from '../../mcp/runtime.js'

type RunOptions = Pick<Parameters<typeof createScheduledTaskRunToolPorts>[0], 'identity' | 'assertLease'>
  & { task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'workspaceId' | 'authorizedTools' | 'groupScope' | 'name' | 'payload'> & Partial<Pick<ScheduledTaskExecutionPlan, 'channels'>> }

export function createWebScheduledTaskToolResources(options: {
  core: SqlDataRuntime
  now(): Date
  timezone(identity: RunIdentity): Promise<string>
  ownerResources?: Parameters<typeof createScheduledOwnerToolDefinitions>[2]
  filterConfigured?(names: readonly string[]): readonly string[] | Promise<readonly string[]>
  mcp?: ScheduledMcpToolsOptions
  email?(claim: AgentEmailAutomationClaim, assertLease: RunOptions['assertLease']): ToolDefinition
  skillCatalog?: { builtins: readonly BuiltinSkillDefinition[]; fingerprint(ownerId: string): string; dataRoot?: string }
}) {
  const { core, now, timezone } = options
  const { db, backend } = core
  const readOwned = createKyselyScheduledTaskRunNowReader(db, backend)
  const verifyGroup = createScheduledTaskGroupScopeVerifier(db, backend)
  const verifyGroupMemory = createScheduledTaskGroupMemoryAuthorizer(db, backend)
  const definitions = createScheduledOwnerToolDefinitions(core, { now, timezone }, options.ownerResources)
  const skillCatalog = options.skillCatalog
  const builtinSkillMetadata = skillCatalog ? createBuiltinSkillMetadataReader(skillCatalog.builtins) : undefined
  const skillMetadata = skillCatalog?.dataRoot && builtinSkillMetadata ? withFileSkillMetadata({
    dataRoot: skillCatalog.dataRoot, list: builtinSkillMetadata, mapPath: () => undefined,
  }) : builtinSkillMetadata
  const bindMcp = options.mcp && createScheduledMcpToolResources(core, options.mcp, now)
  return async (run: RunOptions & {
    additionalReadTools?: readonly ToolDefinition[]
    shell?: Parameters<typeof createScheduledTaskRunToolPorts>[0]['shell']
    sendFile?(isCurrent: () => Promise<boolean>): ToolDefinition
  }) => {
    const { task } = run
    const { id, ownerId } = task
    async function isCurrent() {
      const current = await readOwned(ownerId, id)
      return current?.enabled === true && (current.scheduleKind === 'once' || current.endAt === null || current.endAt > now().getTime())
    }
    const enabled = [...(run.additionalReadTools ?? [])]
    if ((skillCatalog && skillMetadata) || bindMcp) {
      if (run.identity.ownerId !== ownerId || run.identity.sessionId !== `scheduled-task:${id}`)
        throw new Error('定时任务工具身份不匹配')
      await run.assertLease()
      if (!await isCurrent()) throw new Error('定时任务工具授权已失效')
    }
    if (skillCatalog && skillMetadata) {
      const isFileSkillEnabled = skillCatalog.dataRoot
        ? (owner: string, slug: string, source?: 'user' | 'clawhub') => isUserSkillBundleEnabled(skillCatalog.dataRoot!, owner, slug, source) : undefined
      const fileSkills = skillCatalog.dataRoot && isFileSkillEnabled ? (await createFileSkillDefinitions({
        dataRoot: skillCatalog.dataRoot, ownerId, mapPath: () => undefined,
        isEnabled: isFileSkillEnabled,
      })).definitions : []
      const skills = await createAgentSkillRuntimePorts({
        ...skillCatalog, ownerId, fileSkills, isFileSkillEnabled,
      })
      enabled.push(createUseSkillTool(skills), ...createSkillManagementReadTools(skillMetadata))
    }
    const email = options.email && task.authorizedTools.includes('send_email') ? {
      tool: options.email(async (tx, candidate, signal) => {
        if (candidate.ownerId !== ownerId || candidate.sessionId !== `scheduled-task:${id}` || candidate.runId !== run.identity.runId)
          return false
        signal.throwIfAborted()
        await run.assertLease()
        if (!await hasScheduledEmailAuthorization(tx, backend, task, now().getTime(), true)) return false
        await run.assertLease()
        return true
      }, run.assertLease),
      isAuthorized: () => hasScheduledEmailAuthorization(db, backend, task, now().getTime()),
    } : undefined
    return createScheduledTaskRunToolPorts({
      identity: run.identity, task, assertLease: run.assertLease, ownerDefinitions: definitions, definitions: enabled, isCurrent, filterConfigured: options.filterConfigured,
      core, email, shell: run.shell,
      isGroupScopeCurrent: async () => Boolean(await verifyGroup(task)),
      isGroupMemoryCurrent: async () => Boolean(await verifyGroupMemory(task)),
      mcp: await bindMcp?.(task, run.identity),
    })
  }
}

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
    const requiredTaskGrant = new Set<string>()
    let available: readonly McpDirectoryTool[]
    try {
      const [directory, servers] = await Promise.all([options.directory(ownerId), configs(ownerId)])
      const modes = new Map(servers.filter(row => row.enabled && row.transport === 'http').map(row => [row.id, row.confirm_mode]))
      available = directory.filter(tool => allowsScheduledMcpTool(initial, tool.name, modes.get(tool.server_id) ?? ''))
      for (const tool of available) {
        if (modes.get(tool.server_id) === 'confirm_all') requiredTaskGrant.add(tool.name)
      }
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
                return (!requiredTaskGrant.has(name) || names.includes(name)) && allowsScheduledMcpTool(names, name, server.confirm_mode)
                  && await isCurrent(expected)
              })
            },
          },
        })
      },
    }
  }
}
