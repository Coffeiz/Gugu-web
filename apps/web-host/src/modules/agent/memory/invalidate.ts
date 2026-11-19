import { changeAgentMemoryScopeAndEnqueue, invalidateAgentMemoryRag } from '@gugu/core/agent/rag'
import type { SqlDataRuntime } from '@gugu/core/data'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import type { ImMemoryMaintenanceApplyPorts } from '../../admin/memory-apply.js'

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

      await changeAgentMemoryScopeAndEnqueue(core.db, core.backend, ownerId, {
        platform: scope.platform, botId: scope.bot_id, scopeType: scope.scope_type, scopeId: scope.scope_id,
      })
    },
  }
}
