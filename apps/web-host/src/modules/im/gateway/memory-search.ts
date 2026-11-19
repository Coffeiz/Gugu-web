import type { Pool } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { MemorySearchAccessError, type AuthorizedMemoryScope } from '@gugu/core/agent/rag'
import type { CanonicalRunPreparationPorts, RunIdentity } from '@gugu/core/agent'
import type { ImActor, ImBotAccess } from '@gugu/core/im/access'
import { imCanUseTool } from '@gugu/core/im/access'
import { resolveImMemorySearchScopes, type ImMemorySearchPolicy } from '@gugu/core/im/memory-search-scopes'
import type { MemorySearchPort } from '@gugu/core/tools'
import { agentDispatchSource, type AgentDispatchLease } from '../../agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresAgentMemorySnapshotReader } from '../../agent-sessions/tools/agent-rag-run-context.js'
import { createWebOwnerMemorySearchPort } from '../../agent-sessions/tools/agent-memory-search.js'
import type { createPostgresImAccess } from './access-postgres.js'

const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
const denied = () => new MemorySearchAccessError('IM 记忆搜索未授权或暂不可用')
const key = (scope: AuthorizedMemoryScope) => JSON.stringify([scope.ownerId, scope.type, scope.id, scope.platform ?? '', scope.botId ?? '', scope.groupId ?? ''])

/** 严格IM来源绑定，复用正式Core文件检索/排名器；绝不伪装成Web lease或回落owner范围。 */
export function createPostgresImMemorySearch(options: {
  pool: Pick<Pool, 'query'>
  core: Pick<SqlDataRuntime, 'db'>
  storageRoot: string
  lease: AgentDispatchLease
  actor: ImActor
  bot: ImBotAccess
  access: ReturnType<typeof createPostgresImAccess>
  configuration: CanonicalRunPreparationPorts['configuration']
  embedding?: Parameters<typeof createWebOwnerMemorySearchPort>[1]['embedding']
}): MemorySearchPort {
  if (typeof options.configuration !== 'function' || typeof options.access?.authorizeDelivery !== 'function') throw denied()
  const lease = structuredClone(options.lease), actor = structuredClone(options.actor), bot = structuredClone(options.bot), identity = lease.identity
  if (agentDispatchSource(lease.input) !== 'im' || lease.input.v !== 3 || actor.ownerId !== identity.ownerId
    || actor.botId !== lease.input.im.botId || actor.platform !== lease.input.im.platform || actor.chatType !== lease.input.im.chatType
    || actor.chatId !== lease.input.im.chatId || actor.platformUserId !== lease.input.im.platformUserId
    || bot.id !== actor.botId || bot.ownerId !== actor.ownerId || bot.platform !== actor.platform) throw denied()
  async function authorized(target: RunIdentity, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!same(target, identity) || !imCanUseTool(actor, 'search_memory') || !await options.access.authorizeDelivery(actor, bot)) throw denied()
    const active = await options.pool.query(`SELECT 1 FROM conversation_sessions s JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3 AND d.state='selected'
        AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
    signal.throwIfAborted()
    if (active.rowCount !== 1) throw denied()
    const config = await options.configuration(target, signal)
    if (config.source !== actor.platform || config.identity.ownerId !== actor.ownerId || config.identity.subject.kind !== 'session'
      || config.identity.subject.id !== identity.sessionId || !config.toolNames.includes('search_memory')) throw denied()
    signal.throwIfAborted()
  }
  async function policy(signal: AbortSignal): Promise<ImMemorySearchPolicy> {
    const result = await options.pool.query(`SELECT group_memory_enabled,member_memory_enabled FROM user_bots
      WHERE user_id=$1 AND id=$2 AND platform=$3 AND enabled IS TRUE`, [identity.ownerId, actor.botId, actor.platform])
    signal.throwIfAborted()
    const row = result.rows[0]
    if (result.rows.length !== 1 || typeof row?.group_memory_enabled !== 'boolean' || typeof row?.member_memory_enabled !== 'boolean') throw denied()
    return { groupMemoryEnabled: row.group_memory_enabled, memberMemoryEnabled: row.member_memory_enabled }
  }
  async function scopes(requested: Parameters<typeof resolveImMemorySearchScopes>[1], signal: AbortSignal) {
    const current = await policy(signal), mixed = (actor.speakerRoles?.length ?? 0) > 1
    const needsStored = !mixed && actor.role !== 'unknown' && (actor.chatType === 'group' ? requested === 'all_my_groups' : requested === 'auto' || requested === 'all_my_groups')
    const stored: AuthorizedMemoryScope[] = []
    const type = actor.role === 'owner' ? 'group' : 'member'
    if (needsStored && (type === 'group' ? current.groupMemoryEnabled : current.memberMemoryEnabled)) {
      const rows = await options.pool.query(`SELECT owner_user_id::text,platform,bot_id,scope_type,scope_id FROM memory_reflection_cursors
        WHERE owner_user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_type=$4 ORDER BY id LIMIT $5`,
      [identity.ownerId, actor.platform, actor.botId, type === 'group' ? 'group' : 'platform-user', type === 'group' ? 3 : 40])
      for (const row of rows.rows) {
        signal.throwIfAborted()
        if (row.owner_user_id !== identity.ownerId || row.platform !== actor.platform || row.bot_id !== actor.botId
          || row.scope_type !== (type === 'group' ? 'group' : 'platform-user') || typeof row.scope_id !== 'string') throw denied()
        const suffix = `:${actor.platformUserId}`
        if (type === 'member' && !row.scope_id.endsWith(suffix)) continue
        const groupId = type === 'group' ? row.scope_id : row.scope_id.slice(0, -suffix.length)
        if (groupId) stored.push({ ownerId: row.owner_user_id, platform: row.platform, botId: row.bot_id, type, id: row.scope_id, groupId })
      }
    }
    return resolveImMemorySearchScopes(actor, requested, current, stored)
  }
  const port = createWebOwnerMemorySearchPort(options.core, { storageRoot: options.storageRoot,
    async resolveScopes(target, requested, signal) { await authorized(target, signal); return scopes(requested, signal) },
    async authorize(target, signal, proposed) {
      await authorized(target, signal)
      const allowed = new Set((await scopes('all_my_groups', signal)).map(key))
      return !!proposed?.length && proposed.every(scope => allowed.has(key(scope)))
    },
    snapshot: createPostgresAgentMemorySnapshotReader(options.pool, identity),
    ...(options.embedding ? { embedding: options.embedding } : {}),
  })
  return { async search(target, request, signal) {
    try { return await port.search(target, request, signal) }
    catch { signal.throwIfAborted(); throw denied() }
  } }
}
