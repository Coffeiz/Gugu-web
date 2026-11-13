import { CoreError, dataContext } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'

export interface WorkspaceDeleteRuntime {
  workspaceShellSupported(): boolean | Promise<boolean>
}

export interface WorkspaceDeleteResult {
  ok: true
  workspaceId: number
}

function validateOwner(ownerId: string): string {
  try {
    return dataContext(ownerId).ownerId
  } catch {
    throw new CoreError('invalid_request', '用户 ID 无效')
  }
}

function validateWorkspaceId(workspaceId: number): number {
  if (!Number.isSafeInteger(workspaceId)) throw new CoreError('invalid_request', '工作区 ID 无效')
  return workspaceId
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** PostgreSQL port of DELETE /workspaces/{id}; file and parent-resource data are retained. */
export function createPostgresWorkspaceDeleter(pool: Pool, runtime: WorkspaceDeleteRuntime) {
  return async function deleteWorkspace(rawOwnerId: string, rawWorkspaceId: number): Promise<WorkspaceDeleteResult> {
    const ownerId = validateOwner(rawOwnerId)
    const workspaceId = validateWorkspaceId(rawWorkspaceId)

    // The Python service rejects OSS before looking up an ID, so preserve its 409 precedence.
    if (!(await runtime.workspaceShellSupported()))
      throw new CoreError('conflict', 'OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒')

    return inTransaction(pool, async (client) => {
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
