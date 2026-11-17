import { CoreError, dataContext } from '../../contracts/index.js'
import { sql, type Kysely } from 'kysely'
import type { MemoryRagScopeStatePort } from './memory-loader.js'

type ScopeStateRow = {
  scope_version: number | string | null
  updated_at: Date | string | null
  tombstoned: boolean | number | null
}

/**
 * 读取 1.7.7 Memory scope 游标版本与删除屏障。
 * Scope 来自可信 Host 授权结果；此查询再次按 owner 和完整 scope key 限定，
 * 但不会自行授予 scope 权限或枚举 scope。
 */
export function createSqlMemoryScopeStateReader<DB>(db: Kysely<DB>): MemoryRagScopeStatePort['getMemoryScopeState'] {
  return async (context, scope, signal) => {
    signal?.throwIfAborted()
    const ownerId = dataContext(context.ownerId).ownerId
    if (!scope.id || !scope.platform || !scope.botId || !['group', 'member'].includes(scope.type)) {
      throw new CoreError('invalid_request', 'Memory scope 缺少必要字段')
    }

    const cursorType = scope.type === 'group' ? 'group' : 'platform-user'
    let row: ScopeStateRow | undefined
    try {
      const result = await sql<ScopeStateRow>`
        SELECT
          (SELECT scope_version FROM memory_reflection_cursors
            WHERE owner_user_id = ${ownerId} AND platform = ${scope.platform}
              AND bot_id = ${scope.botId} AND scope_type = ${cursorType}
              AND scope_id = ${scope.id} LIMIT 1) AS scope_version,
          (SELECT updated_at FROM memory_reflection_cursors
            WHERE owner_user_id = ${ownerId} AND platform = ${scope.platform}
              AND bot_id = ${scope.botId} AND scope_type = ${cursorType}
              AND scope_id = ${scope.id} LIMIT 1) AS updated_at,
          EXISTS (SELECT 1 FROM memory_scope_tombstones
            WHERE owner_user_id = ${ownerId} AND platform = ${scope.platform}
              AND bot_id = ${scope.botId} AND scope_type = ${cursorType}
              AND scope_id = ${scope.id}) AS tombstoned
      `.execute(db)
      row = result.rows[0]
    } catch {
      signal?.throwIfAborted()
      throw new CoreError('storage_error', 'Memory scope 状态查询失败')
    }
    signal?.throwIfAborted()
    if (!row) throw new CoreError('storage_error', 'Memory scope 状态查询失败')

    const updatedAt = row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at || '')
    const revision = row.scope_version == null
      ? 'missing'
      : `${Number(row.scope_version) || 0}:${updatedAt}`
    return { revision, tombstoned: row.tombstoned === true || row.tombstoned === 1 }
  }
}
