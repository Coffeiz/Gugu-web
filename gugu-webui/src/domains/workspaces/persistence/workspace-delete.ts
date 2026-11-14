import { CoreError } from '@gugu/core'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'

export interface WorkspaceDeleteResult {
  ok: true
  workspaceId: number
}

function validateWorkspaceId(workspaceId: number): number {
  if (!Number.isSafeInteger(workspaceId)) throw new CoreError('invalid_request', '工作区 ID 无效')
  return workspaceId
}

/** PostgreSQL port of DELETE /workspaces/{id}; file and parent-resource data are retained. */
export function createPostgresWorkspaceDeleter(pool: Pool) {
  return async function deleteWorkspace(rawOwnerId: string, rawWorkspaceId: number): Promise<WorkspaceDeleteResult> {
    const ownerId = normalizeOwnerId(rawOwnerId)
    const workspaceId = validateWorkspaceId(rawWorkspaceId)

    return withPostgresTransaction(pool, async (client) => {
      const owned = await client.query<{ id: number } & Record<string, unknown>>(
        `SELECT id FROM workspaces WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [workspaceId, ownerId],
      )
      if (!owned.rows[0]) throw new CoreError('not_found', '工作区不存在')

      // Match delete_workspace: detach only this owner's sessions and ordinary scheduled tasks.
      await client.query(
        `UPDATE conversation_sessions SET workspace_id = NULL
         WHERE user_id = $1 AND workspace_id = $2`,
        [ownerId, workspaceId],
      )
      await client.query(
        `UPDATE scheduled_tasks SET enabled = FALSE, workspace_id = NULL
         WHERE user_id = $1 AND workspace_id = $2 AND event_id IS NULL`,
        [ownerId, workspaceId],
      )
      await client.query(
        `DELETE FROM workspaces WHERE id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      )

      return { ok: true, workspaceId }
    })
  }
}
