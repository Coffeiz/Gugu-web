import type { Kysely } from 'kysely'
import type { RunIdentity } from '../agent/models.js'
import { groupScopePrefix, type MemoryRagStorageReader } from '../agent/rag/memory-loader.js'
import { createSqlAgentGroupHistory } from '../agent/sessions/im-tools.js'
import { createAgentImTools, type AgentImToolPorts } from '../agent/tools/im.js'
import { createImMaintenanceSource } from '../memory/im-maintenance-source.js'
import { createKyselyScheduledTaskExecutionReader, createKyselyScheduledTaskGroupScopeReader,
  type ScheduledTaskExecutionPlan } from './run-now-read.js'

type GroupPort = NonNullable<AgentImToolPorts['group']>
type Members = Awaited<ReturnType<GroupPort['members']>>

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseMembers(raw: string | null): Members {
  let parsed: unknown
  try { parsed = raw ? JSON.parse(raw) : null } catch { return {} }
  return Object.fromEntries(Object.entries(record(record(parsed).members)).map(([id, data]) => {
    const member = record(data)
    return [id, {
      name: typeof member.name === 'string' ? member.name : undefined,
      aliases: strings(member.aliases),
      nicknames: strings(member.nicknames),
      last_seen_at: typeof member.last_seen_at === 'number' ? member.last_seen_at : undefined,
    }]
  }))
}

/** 已绑定的群范围在工具发现和读取时都与当前任务及 Bot 归属核对。 */
export function createScheduledTaskGroupScopeVerifier<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite') {
  const readTask = createKyselyScheduledTaskExecutionReader(db, backend)
  const readGroup = createKyselyScheduledTaskGroupScopeReader(db, backend)
  return async (task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'groupScope'>) => {
    const bound = task.groupScope
    if (!bound || bound.ownerId !== task.ownerId) return null
    const selected = await readTask(task.ownerId, task.id)
    if ('error' in selected) return null
    const current = await readGroup(selected.plan)
    return current?.platform === bound.platform && current.botId === bound.botId && current.scopeId === bound.scopeId ? current : null
  }
}

/** 定时 Agent 复用共享群搜索工具。每次读取用绑定的 Run 身份重查任务和群归属。 */
export function createScheduledTaskGroupTools<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite', storage?: MemoryRagStorageReader) {
  const verifyGroup = createScheduledTaskGroupScopeVerifier(db, backend)
  const history = createSqlAgentGroupHistory(db, backend)
  const { isTombstoned } = createImMaintenanceSource(db)
  return (task: ScheduledTaskExecutionPlan, identity: RunIdentity) => {
    const bound = task.groupScope
    if (!bound || identity.ownerId !== task.ownerId || bound.ownerId !== task.ownerId) return []
    const expected = { ...identity }
    const scope = async (candidate: RunIdentity, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (candidate.ownerId !== expected.ownerId || candidate.sessionId !== expected.sessionId || candidate.runId !== expected.runId) return null
      const current = await verifyGroup(task)
      signal.throwIfAborted()
      if (!current) return null
      return { platform: current.platform, botId: current.botId, chatId: current.scopeId }
    }

    const authorize = async (candidate: RunIdentity, signal: AbortSignal) => {
      const current = await scope(candidate, signal)
      if (!current) throw new Error('定时任务群聊授权已失效')
      return current
    }
    return createAgentImTools({ group: {
      scope,
      async speakers(candidate, _group, signal) {
        const rows = await history.speakers(candidate, await authorize(candidate, signal), signal)
        await authorize(candidate, signal)
        return rows
      },
      async search(candidate, _group, query, signal) {
        const rows = await history.search(candidate, await authorize(candidate, signal), query, signal)
        await authorize(candidate, signal)
        return rows
      },
      async members(candidate, _group, signal) {
        const group = await authorize(candidate, signal)
        if (!storage) return {}
        const ownerId = candidate.ownerId
        const key = { owner_user_id: ownerId, platform: group.platform, bot_id: group.botId,
          scope_type: 'group' as const, scope_id: group.chatId }
        if (await isTombstoned(key)) return {}
        const prefix = groupScopePrefix(ownerId, { ownerId, platform: group.platform, botId: group.botId, type: 'group', id: group.chatId })
        const raw = await storage.readText({ ownerId, key: `${prefix}members.json`, maxChars: 2_000_000, signal })
        if (await isTombstoned(key)) return {}
        await authorize(candidate, signal)
        return parseMembers(raw)
      },
    } })
  }
}
