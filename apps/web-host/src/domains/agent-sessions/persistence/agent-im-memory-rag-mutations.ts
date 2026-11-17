import { enqueueAgentRagRebuild, invalidateAgentMemoryRag } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { sql } from 'kysely'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import type { ImMemoryMaintenanceApplyPorts } from '../../../modules/admin/im-memory-maintenance-apply.js'

type Scope = Parameters<ImMemoryMaintenanceApplyPorts['memoryIndex']['changed']>[0]

/**
 * Admin IM 记忆维护写入文件系统后，更新与缓存绑定的持久 scope revision 并重建正式索引。
 * 旧投影在首次文件写入前即撤回；队列只在文件变更后排入，且完整重建 memory 来源。
 */
export function createAgentImMemoryRagMutationPorts(core: Pick<SqlDataRuntime, 'db' | 'backend'>): ImMemoryMaintenanceApplyPorts['memoryIndex'] {
  return {
    async invalidate(rawOwnerId) {
      const ownerId = normalizeOwnerId(rawOwnerId)
      await invalidateAgentMemoryRag(core.db, core.backend, ownerId)
    },
    async changed(scope: Scope) {
      const ownerId = normalizeOwnerId(scope.owner_user_id)
      if (!scope.platform.trim() || !scope.bot_id.trim() || !scope.scope_id.trim()
        || scope.scope_type !== 'group' && scope.scope_type !== 'platform-user')
        throw new TypeError('IM 记忆 scope 身份无效')

      const updated = await sql<{ id: number }>`
        UPDATE memory_reflection_cursors
        SET scope_version = scope_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE owner_user_id = ${ownerId}
          AND platform = ${scope.platform}
          AND bot_id = ${scope.bot_id}
          AND scope_type = ${scope.scope_type}
          AND scope_id = ${scope.scope_id}
          AND scope_version < 2147483647
          AND NOT EXISTS (
            SELECT 1 FROM memory_scope_tombstones t
            WHERE t.owner_user_id = ${ownerId}
              AND t.platform = ${scope.platform}
              AND t.bot_id = ${scope.bot_id}
              AND t.scope_type = ${scope.scope_type}
              AND t.scope_id = ${scope.scope_id}
          )
        RETURNING id
      `.execute(core.db)
      if (updated.rows.length !== 1) throw new Error('IM 记忆 scope 已失效或不存在')
      await enqueueAgentRagRebuild(core.db, core.backend, ownerId, 'memory')
    },
  }
}
