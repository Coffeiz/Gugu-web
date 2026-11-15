import type { Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { enqueueScheduledTaskRagIndex } from '../scheduled-tasks/rag-index-job.js'
import type { WorkspaceDeletionRuntime } from '../workspaces/workspace-delete.js'

/** 声明最小读取面；表结构和外键生命周期由平台schema维护，不在此建表。 */
export interface WorkspaceDeletionTables {
  workspaces: { id: number; user_id: string }
  conversation_sessions: { id: number; user_id: string; workspace_id: number | null }
  scheduled_tasks: { id: number; user_id: string | null; workspace_id: number | null; event_id: number | null; enabled: boolean | number }
}

/** 仅删除owner内声明及显式绑定；不操作父资源、文件、执行进程或连接池生命周期。 */
export function createKyselyWorkspaceDeletionRuntime(db: Kysely<WorkspaceDeletionTables>, backend: 'sqlite' | 'postgres'): WorkspaceDeletionRuntime {
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
          async lockOwnedWorkspace(ownerId, workspaceId) {
            let query = tx.selectFrom('workspaces').select('id').where('id', '=', workspaceId).where('user_id', '=', owner(ownerId))
            if (backend === 'postgres') query = query.forUpdate()
            return Boolean(await query.executeTakeFirst())
          },
          async detachSessions(ownerId, workspaceId) {
            await tx.updateTable('conversation_sessions').set({ workspace_id: null })
              .where('user_id', '=', owner(ownerId)).where('workspace_id', '=', workspaceId).execute()
          },
          async disableOrdinaryTasks(ownerId, workspaceId) {
            const taskOwner = owner(ownerId)
            const changed = await tx.updateTable('scheduled_tasks').set({ enabled: backend === 'sqlite' ? 0 : false, workspace_id: null })
              .where('user_id', '=', taskOwner).where('workspace_id', '=', workspaceId).where('event_id', 'is', null).returning(['id']).execute()
            for (const task of changed) await enqueueScheduledTaskRagIndex(tx, backend, taskOwner, Number(task.id))
          },
          async deleteDeclaration(ownerId, workspaceId) {
            await tx.deleteFrom('workspaces').where('id', '=', workspaceId).where('user_id', '=', owner(ownerId)).execute()
          },
        })
        // 回调已写入但尚未提交时取消，必须由真实数据库事务回滚全部变更及外键副作用。
        signal?.throwIfAborted()
        return result
      })
    },
  }
}
