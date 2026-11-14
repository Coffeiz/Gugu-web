import { CoreError } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { WorkspaceCreateResponse } from './workspace-create.js'

interface WorkspaceRow {
  id: number
  name: string
  kind: WorkspaceCreateResponse['kind']
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

export interface WorkspaceBindingOperations {
  bind(ownerId: string, workspaceId: number, sessionId: number): Promise<WorkspaceCreateResponse>
  unbind(ownerId: string, sessionId: number): Promise<void>
  current(ownerId: string, sessionId: number): Promise<WorkspaceCreateResponse | null>
}

function validateId(id: number, label: string): number {
  if (!Number.isSafeInteger(id)) throw new CoreError('invalid_request', `${label} 无效`)
  return id
}

async function ownedSession(client: PoolClient, ownerId: string, sessionId: number): Promise<SessionRow> {
  const result = await client.query<SessionRow & Record<string, unknown>>(
    `SELECT id, workspace_id FROM conversation_sessions
     WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [sessionId, ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', '会话不存在')
  return row
}

async function workspaceForOwner(
  client: PoolClient,
  ownerId: string,
  workspaceId: number,
  requireEnabled: boolean,
): Promise<WorkspaceCreateResponse | null> {
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

/** PostgreSQL port of bind_session, describe_session and current_workspace data access. */
export function createPostgresWorkspaceBindingOperations(pool: Pool): WorkspaceBindingOperations {
  return {
    async bind(rawOwnerId, workspaceId, sessionId) {
      const ownerId = normalizeOwnerId(rawOwnerId)
      validateId(workspaceId, '工作区 ID')
      validateId(sessionId, '会话 ID')
      return withPostgresTransaction(pool, async (client) => {
        await ownedSession(client, ownerId, sessionId)
        const workspace = await workspaceForOwner(client, ownerId, workspaceId, true)
        if (!workspace) throw new CoreError('not_found', '工作区不存在或已停用')
        await client.query(
          `UPDATE conversation_sessions SET workspace_id = $3
           WHERE id = $1 AND user_id = $2`,
          [sessionId, ownerId, workspace.id],
        )
        // Python bind_workspace explicitly responds with boundSessionCount=1.
        return { ...workspace, boundSessionCount: 1 }
      })
    },

    async unbind(rawOwnerId, sessionId) {
      const ownerId = normalizeOwnerId(rawOwnerId)
      validateId(sessionId, '会话 ID')
      await withPostgresTransaction(pool, async (client) => {
        await ownedSession(client, ownerId, sessionId)
        await client.query(
          `UPDATE conversation_sessions SET workspace_id = NULL
           WHERE id = $1 AND user_id = $2`,
          [sessionId, ownerId],
        )
      })
    },

    async current(rawOwnerId, sessionId) {
      const ownerId = normalizeOwnerId(rawOwnerId)
      validateId(sessionId, '会话 ID')
      return withPostgresTransaction(pool, async (client) => {
        const session = await ownedSession(client, ownerId, sessionId)
        if (session.workspace_id == null) return null
        // Python get_workspace does not require enabled here; stale/disabled bindings remain visible.
        return workspaceForOwner(client, ownerId, session.workspace_id, false)
      })
    },
  }
}
