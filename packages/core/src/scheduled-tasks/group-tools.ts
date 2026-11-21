import { sql, type Kysely } from 'kysely'
import type { RunIdentity } from '../agent/models.js'
import { createSqlMemoryScopeStateReader, MemorySearchAccessError, createMemorySearch, type AuthorizedMemoryScope, type MemoryRagScopeStatePort } from '../agent/rag/index.js'
import { groupScopePrefix, type MemoryRagStorageReader } from '../agent/rag/memory-loader.js'
import { createSqlAgentGroupHistory } from '../agent/sessions/im-tools.js'
import { createAgentImTools, type AgentImToolPorts } from '../agent/tools/im.js'
import { createMemorySearchTool } from '../agent/tools/memory.js'
import type { MemorySearchPort, ToolDefinition } from '../agent/tools/index.js'
import { createImMaintenanceSource } from '../memory/im-maintenance-source.js'
import { createKyselyScheduledTaskExecutionReader, createKyselyScheduledTaskGroupScopeReader,
  type ScheduledTaskExecutionPlan } from './run-now-read.js'

type GroupPort = NonNullable<AgentImToolPorts['group']>
type Group = NonNullable<Awaited<ReturnType<GroupPort['scope']>>>
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

/** 定时 Run 没有当前 IM 发送者，只能在每次授权检查时重新绑定到单一群 scope。 */
export function createScheduledTaskGroupMemorySearchPort<DB>(options: {
  db?: Kysely<DB>
  storage: MemoryRagStorageReader
  scopeState?: MemoryRagScopeStatePort
  resolveGroup(identity: RunIdentity, signal: AbortSignal): Promise<Group | null>
}): MemorySearchPort {
  const scopeState = options.scopeState ?? (options.db
    ? { getMemoryScopeState: createSqlMemoryScopeStateReader(options.db) }
    : null)
  if (!scopeState) throw new TypeError('定时群记忆 scope 状态端口未装配')
  return { search: async (identity, request, signal) => {
    const requested = request.scope ?? 'auto'
    if (requested !== 'auto' && requested !== 'current_group')
      throw new MemorySearchAccessError('定时任务只能搜索当前群聊记忆')
    const resolveScope = async (candidate: RunIdentity, innerSignal: AbortSignal): Promise<AuthorizedMemoryScope & { platform: string; botId: string }> => {
      innerSignal.throwIfAborted()
      const group = await options.resolveGroup(candidate, innerSignal)
      innerSignal.throwIfAborted()
      if (!group) throw new MemorySearchAccessError('定时任务群聊授权已失效')
      return { ownerId: candidate.ownerId, type: 'group', id: group.chatId,
        platform: group.platform, botId: group.botId, groupId: group.chatId }
    }
    const search = createMemorySearch({
      async resolveScopes(candidate, _requested, innerSignal) { return [await resolveScope(candidate, innerSignal)] },
      async authorize(candidate, scopes, innerSignal) {
        try {
          const current = await resolveScope(candidate, innerSignal)
          const state = await scopeState.getMemoryScopeState(candidate, {
            type: 'group', id: current.id, platform: current.platform, botId: current.botId,
          }, innerSignal)
          return !state.tombstoned && scopes.length === 1 && scopes[0]?.type === 'group' && scopes[0].ownerId === current.ownerId
            && scopes[0].id === current.id && scopes[0].platform === current.platform && scopes[0].botId === current.botId
        } catch (error) {
          if (error instanceof MemorySearchAccessError) return false
          throw error
        }
      },
      snapshot: async (candidate, innerSignal) => {
        innerSignal.throwIfAborted()
        const current = await resolveScope(candidate, innerSignal)
        return { revision: `scheduled:${candidate.sessionId}:${current.platform}:${current.botId}:${current.id}`, text: '' }
      },
      storage: () => options.storage,
      scopeState,
    })
    return search(identity, { ...request, scope: requested === 'auto' ? 'current_group' : requested,
      strategy: request.strategy ?? 'bm25' }, signal)
  } }
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

export function createScheduledTaskGroupMemoryAuthorizer<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite') {
  const verify = createScheduledTaskGroupScopeVerifier(db, backend)
  return async (task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'groupScope'>) => {
    const scope = await verify(task)
    if (!scope) return null
    const { rows } = await sql`SELECT 1 FROM user_bots
      WHERE id=${scope.botId} AND user_id=${scope.ownerId} AND platform=${scope.platform}
        AND enabled=TRUE AND group_memory_enabled=TRUE
        AND CASE WHEN platform='feishu' THEN feishu_group_chat_enabled IS DISTINCT FROM FALSE ELSE group_chat_enabled IS TRUE END`.execute(db)
    return rows.length ? scope : null
  }
}

async function readScheduledGroupMembers<DB>(db: Kysely<DB>, ownerId: string, group: Group,
  storage: MemoryRagStorageReader | undefined, signal: AbortSignal, authorizeMemory: () => Promise<boolean>): Promise<Members> {
  if (!storage || !await authorizeMemory()) return {}
  const { isTombstoned } = createImMaintenanceSource(db)
  const key = { owner_user_id: ownerId, platform: group.platform, bot_id: group.botId,
    scope_type: 'group' as const, scope_id: group.chatId }
  if (await isTombstoned(key)) return {}
  const prefix = groupScopePrefix(ownerId, { ownerId, platform: group.platform, botId: group.botId, type: 'group', id: group.chatId })
  const raw = await storage.readText({ ownerId, key: `${prefix}members.json`, maxChars: 2_000_000, signal })
  signal.throwIfAborted()
  if (await isTombstoned(key) || !await authorizeMemory()) return {}
  return parseMembers(raw)
}

/** 定时 Agent 复用共享群搜索工具。每次读取用绑定的 Run 身份重查任务和群归属。 */
export function createScheduledTaskGroupTools<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite', storage?: MemoryRagStorageReader) {
  const verifyGroup = createScheduledTaskGroupScopeVerifier(db, backend)
  const verifyMemory = createScheduledTaskGroupMemoryAuthorizer(db, backend)
  const history = createSqlAgentGroupHistory(db, backend)
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
    const tools: ToolDefinition[] = createAgentImTools({ group: {
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
        return readScheduledGroupMembers(db, candidate.ownerId, group, storage, signal, async () => Boolean(await verifyMemory(task)))
      },
    } })
    if (storage) {
      const resolveGroup = async (candidate: RunIdentity, signal: AbortSignal): Promise<Group | null> => {
        signal.throwIfAborted()
        if (candidate.ownerId !== expected.ownerId || candidate.sessionId !== expected.sessionId || candidate.runId !== expected.runId)
          return null
        const current = await verifyMemory(task)
        signal.throwIfAborted()
        if (!current) return null
        return { platform: current.platform, botId: current.botId, chatId: current.scopeId }
      }
      const memorySearch = createScheduledTaskGroupMemorySearchPort({ db, storage,
        resolveGroup: (candidate, signal) => resolveGroup(candidate, signal) })
      tools.push(createMemorySearchTool(memorySearch))
    }
    return tools
  }
}
