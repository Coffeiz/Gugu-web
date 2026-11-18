import type { RunIdentity } from '@gugu/core/agent'
import { createAgentCalendarReader, createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort } from '@gugu/core/calendar'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createScheduledTaskGroupScopeVerifier, createScheduledTaskRunToolPorts } from '@gugu/core/scheduled-task-run-now'
import { createKyselyScheduledTaskRunNowReader, hasScheduledEmailAuthorization, type ScheduledTaskExecutionPlan } from '@gugu/core/scheduled-task-run-now-read'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createSkillMetadataReader, type BuiltinSkillDefinition } from '@gugu/core/skills'
import { createUserSkillReader } from '@gugu/core/agent/skills/user-body'
import { createWebAgentSkillProductionPorts } from '../../domains/agent-sessions/tools/agent-skill-production-ports.js'
import { createClientTools, createListEventsTool, createListProjectsTool, createListScheduledTasksTool,
  createSkillManagementReadTools, createTimeTool, createUpcomingTool, createUseSkillTool,
  type AgentEmailAutomationClaim, type ToolDefinition } from '@gugu/core/tools'
import { createScheduledMcpToolResources, type ScheduledMcpToolsOptions } from './mcp-tools.js'

type RunOptions = Pick<Parameters<typeof createScheduledTaskRunToolPorts>[0], 'identity' | 'assertLease'>
  & { task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'workspaceId' | 'authorizedTools' | 'groupScope' | 'name' | 'payload'> }

export function createWebScheduledTaskToolResources(options: {
  core: SqlDataRuntime
  now(): Date
  timezone(identity: RunIdentity): Promise<string>
  mcp?: ScheduledMcpToolsOptions
  email?(claim: AgentEmailAutomationClaim, assertLease: RunOptions['assertLease']): ToolDefinition
  skillCatalog?: { builtins: readonly BuiltinSkillDefinition[]; fingerprint(ownerId: string): string }
}) {
  const { core, now, timezone } = options
  const { db, backend } = core
  const readOwned = createKyselyScheduledTaskRunNowReader(db, backend)
  const verifyGroup = createScheduledTaskGroupScopeVerifier(db, backend)
  const calendar = createKyselyCalendarReadPort(db, backend)
  const tasks = createScheduledTaskQueries(createKyselyScheduledTaskReader(db, backend),
    () => ({ workspaceSupported: backend === 'postgres', filesystemAuthorizationEnabled: false }))
  const definitions = [
    createTimeTool({ now, timezone }),
    createListEventsTool(createAgentCalendarReader(createKyselyCalendarAgentReadPort(db, backend))),
    createUpcomingTool({ core, events: calendar, time: { now, timezone } }),
    createListProjectsTool(core),
    createListScheduledTasksTool({ list: (identity, signal) => tasks.agent(identity.ownerId, signal) }),
    ...createClientTools(core).filter(tool => tool.effect === 'read'),
  ]
  const skillCatalog = options.skillCatalog
  const skillMetadata = skillCatalog ? createSkillMetadataReader(db, backend, skillCatalog.builtins) : undefined
  const readSkill = createUserSkillReader(db, backend)
  const bindMcp = options.mcp && createScheduledMcpToolResources(core, options.mcp, now)
  return async (run: RunOptions & {
    additionalReadTools?: readonly ToolDefinition[]
    sendFile?(isCurrent: () => Promise<boolean>): ToolDefinition
  }) => {
    const { task } = run
    const { id, ownerId } = task
    async function isCurrent() {
      const current = await readOwned(ownerId, id)
      return current?.enabled === true && (current.scheduleKind === 'once' || current.endAt === null || current.endAt > now().getTime())
    }
    const enabled = [...definitions, ...(run.additionalReadTools ?? [])]
    if ((skillCatalog && skillMetadata) || bindMcp) {
      if (run.identity.ownerId !== ownerId || run.identity.sessionId !== `scheduled-task:${id}`)
        throw new Error('定时任务工具身份不匹配')
      await run.assertLease()
      if (!await isCurrent()) throw new Error('定时任务工具授权已失效')
    }
    if (skillCatalog && skillMetadata) {
      const skills = await createWebAgentSkillProductionPorts({
        ...skillCatalog, ownerId, listUser: skillMetadata, readUser: readSkill,
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
      ...run, definitions: enabled, isCurrent,
      sendFile: run.sendFile?.(async () => {
        await run.assertLease()
        if (!await isCurrent()) return false
        await run.assertLease()
        return true
      }),
      email,
      isGroupScopeCurrent: async () => Boolean(await verifyGroup(task)),
      mcp: await bindMcp?.(task, run.identity),
    })
  }
}
