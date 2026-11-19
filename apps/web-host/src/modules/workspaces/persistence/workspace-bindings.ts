import { createWorkspaceBindings } from '@gugu/core'
import type { WorkspaceBindingOperations } from '@gugu/core'
import type { WorkspaceDeclaration } from '@gugu/core/workspace-declarations'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'

export type { WorkspaceBindingOperations } from '@gugu/core'

interface WorkspaceRow {
  id: number
  name: string
  kind: WorkspaceDeclaration['kind']
  folder_id: number | null
  project_id: number | null
  directory_id: number | null
  enabled: boolean
  is_default: boolean
}

interface SessionRow {
  id: number
  workspace_id: number | null
}

async function workspaceForOwner(
  client: PoolClient,
  ownerId: string,
  workspaceId: number,
  requireEnabled: boolean,
): Promise<WorkspaceDeclaration | null> {
  const result = await client.query<WorkspaceRow & Record<string, unknown>>(
    `SELECT id, name, kind, folder_id, project_id, directory_id, enabled, is_default
     FROM workspaces
     WHERE id = $1 AND user_id = $2${requireEnabled ? ' AND enabled IS TRUE' : ''}`,
    [workspaceId, ownerId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    folderId: row.folder_id == null ? null : Number(row.folder_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    directoryId: row.directory_id == null ? null : Number(row.directory_id),
    enabled: row.enabled,
    isDefault: row.is_default,
    boundSessionCount: 0,
  }
}

/** Host 保留 PostgreSQL 事务与行锁，绑定规则及错误判断委托 Core 公共用例。 */
export function createPostgresWorkspaceBindingOperations(pool: Pool): WorkspaceBindingOperations {
  return createWorkspaceBindings({
    transaction: work => withPostgresTransaction(pool, client => work({
      async getOwnedSession(ownerId, sessionId) {
        const result = await client.query<SessionRow & Record<string, unknown>>(
          `SELECT id, workspace_id FROM conversation_sessions
     WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [sessionId, ownerId],
        )
        const row = result.rows[0]
        return row ? { id: Number(row.id), workspaceId: row.workspace_id == null ? null : Number(row.workspace_id) } : null
      },
      workspaceForOwner: (ownerId, workspaceId, requireEnabled) => workspaceForOwner(client, ownerId, workspaceId, requireEnabled),
      async setWorkspace(ownerId, sessionId, workspaceId) {
        if (workspaceId === null) {
          await client.query(
            `UPDATE conversation_sessions SET workspace_id = NULL
           WHERE id = $1 AND user_id = $2`,
            [sessionId, ownerId],
          )
        } else {
          await client.query(
            `UPDATE conversation_sessions SET workspace_id = $3
           WHERE id = $1 AND user_id = $2`,
            [sessionId, ownerId, workspaceId],
          )
        }
      },
    })),
  })
}
