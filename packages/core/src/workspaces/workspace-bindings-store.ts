import type { Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { WorkspaceBindingRuntime } from '../workspaces/workspace-bindings.js'
import type { WorkspaceDeclaration } from '../workspaces/workspace-declarations.js'
import type { WorkspaceListRow } from '../workspaces/workspace-list.js'
import type { WorkspaceListTables } from './workspace-list-store.js'

export type WorkspaceBindingTables = Pick<WorkspaceListTables, 'workspaces' | 'conversation_sessions'>

function mapWorkspaceDeclaration(row: Omit<WorkspaceListRow, 'enabled' | 'is_default'> & {
  enabled: number | boolean; is_default: number | boolean
}): WorkspaceDeclaration {
  return { id: Number(row.id), name: row.name, kind: row.kind,
    folderId: row.folder_id == null ? null : Number(row.folder_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    directoryId: row.directory_id == null ? null : Number(row.directory_id),
    enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default), boundSessionCount: 0 }
}

/** 复用调用方持有的数据库；只读写声明绑定，不创建表、授予执行权限或关闭连接池。 */
export function createKyselyWorkspaceBindingRuntime(db: Kysely<WorkspaceBindingTables>, backend: 'sqlite' | 'postgres'): WorkspaceBindingRuntime {
  const owner = (value: string) => {
    const normalized = dataContext(value).ownerId
    return backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
  }
  return {
    async transaction(work, options = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      return db.transaction().execute(async tx => {
        signal?.throwIfAborted()
        const result = await work({
          async getOwnedSession(ownerId, sessionId) {
            let query = tx.selectFrom('conversation_sessions').select(['id', 'workspace_id'])
              .where('user_id', '=', owner(ownerId)).where('id', '=', sessionId)
            if (backend === 'postgres') query = query.forUpdate()
            const row = await query.executeTakeFirst()
            return row ? { id: Number(row.id), workspaceId: row.workspace_id == null ? null : Number(row.workspace_id) } : null
          },
          async workspaceForOwner(ownerId, workspaceId, requireEnabled) {
            let query = tx.selectFrom('workspaces').select(['id', 'name', 'kind', 'folder_id', 'project_id', 'directory_id', 'enabled', 'is_default'])
              .where('user_id', '=', owner(ownerId)).where('id', '=', workspaceId)
            if (requireEnabled) query = query.where('enabled', '=', backend === 'sqlite' ? 1 : true)
            const row = await query.executeTakeFirst()
            return row ? mapWorkspaceDeclaration(row) : null
          },
          async setWorkspace(ownerId, sessionId, workspaceId) {
            await tx.updateTable('conversation_sessions').set({ workspace_id: workspaceId })
              .where('user_id', '=', owner(ownerId)).where('id', '=', sessionId).execute()
          },
        })
        // 只在提交之前取消并回滚；已提交成功不再伪装成未执行。
        signal?.throwIfAborted()
        return result
      })
    },
  }
}
