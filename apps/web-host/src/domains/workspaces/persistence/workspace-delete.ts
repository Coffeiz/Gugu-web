import { createWorkspaceDeleter } from '@gugu/core'
import type { Pool } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { enqueueScheduledTaskRagRebuild } from '../../../modules/scheduled-tasks/persistence/task-rag-job-postgres.js'

export type { WorkspaceDeleteResult } from '@gugu/core'

/** 保留PG事务、行锁及原SQL；声明解绑规则委托Core，不删除物理资源。 */
export function createPostgresWorkspaceDeleter(pool: Pool) {
  return createWorkspaceDeleter({
    transaction: work => withPostgresTransaction(pool, client => work({
      async lockOwnedWorkspace(ownerId, workspaceId) {
        const owned = await client.query<{ id: number } & Record<string, unknown>>(
          `SELECT id FROM workspaces WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [workspaceId, ownerId],
        )
        return !!owned.rows[0]
      },
      async detachSessions(ownerId, workspaceId) {
        await client.query(
          `UPDATE conversation_sessions SET workspace_id = NULL
           WHERE user_id = $1 AND workspace_id = $2`,
          [ownerId, workspaceId],
        )
      },
      async disableOrdinaryTasks(ownerId, workspaceId) {
        const changed = await client.query<{ id: number }>(
          `UPDATE scheduled_tasks SET enabled = FALSE, workspace_id = NULL
           WHERE user_id = $1 AND workspace_id = $2 AND event_id IS NULL RETURNING id`,
          [ownerId, workspaceId],
        )
        for (const task of changed.rows) await enqueueScheduledTaskRagRebuild(client, ownerId, Number(task.id))
      },
      async deleteDeclaration(ownerId, workspaceId) {
        await client.query(
          `DELETE FROM workspaces WHERE id = $1 AND user_id = $2`,
          [workspaceId, ownerId],
        )
      },
    })),
  })
}
