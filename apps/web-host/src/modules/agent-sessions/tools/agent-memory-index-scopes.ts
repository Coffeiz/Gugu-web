import type { AuthorizedMemoryScope } from '@gugu/core/agent/rag'
import type { SqlDataRuntime } from '@gugu/core/data'
import { normalizeOwnerId } from '../../../shared/owner-context.js'

type ScopeRow = { scope_type: string; scope_id: string; platform: string; bot_id: string }
interface ScopeQuery {
  select(columns: readonly string[]): ScopeQuery
  where(column: string, operator: '=', value: string): ScopeQuery
  orderBy(column: string): ScopeQuery
  execute(): Promise<ScopeRow[]>
}

/**
 * 索引构建只枚举当前 owner 的持久 reflection scope；具体召回授权仍由 search_memory
 * 每次调用时根据可信 IM 上下文单独解析，不因 scope 出现在索引中自动获得访问权。
 */
export function createPostgresAgentMemoryIndexScopeReader(db: SqlDataRuntime['db']) {
  return async (rawOwnerId: string, signal?: AbortSignal): Promise<AuthorizedMemoryScope[]> => {
    signal?.throwIfAborted()
    const ownerId = normalizeOwnerId(rawOwnerId)
    const rows = await (db as unknown as { selectFrom(table: string): ScopeQuery })
      .selectFrom('memory_reflection_cursors')
      .select(['scope_type', 'scope_id', 'platform', 'bot_id'])
      .where('owner_user_id', '=', ownerId)
      .orderBy('id')
      .execute()
    signal?.throwIfAborted()

    const result: AuthorizedMemoryScope[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row.platform?.trim() || !row.bot_id?.trim() || !row.scope_id?.trim()) continue
      let scope: AuthorizedMemoryScope | null = null
      if (row.scope_type === 'group') {
        scope = { ownerId, type: 'group', id: row.scope_id, platform: row.platform, botId: row.bot_id, groupId: row.scope_id }
      } else if (row.scope_type === 'platform-user') {
        const separator = row.scope_id.indexOf(':')
        if (separator > 0 && separator < row.scope_id.length - 1) {
          const groupId = row.scope_id.slice(0, separator)
          scope = { ownerId, type: 'member', id: row.scope_id, platform: row.platform, botId: row.bot_id, groupId }
        }
      }
      if (!scope) continue
      const key = [scope.type, scope.id, scope.platform, scope.botId, scope.groupId].join('\x1f')
      if (!seen.has(key)) { seen.add(key); result.push(scope) }
    }
    return result
  }
}
