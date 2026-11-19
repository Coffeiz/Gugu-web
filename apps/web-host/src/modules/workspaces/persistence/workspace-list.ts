import { createWorkspaceLister } from '@gugu/core'
import type { WorkspaceListReadPort, WorkspaceListRow, WorkspaceListRuntime } from '@gugu/core'
import type { Pool } from 'pg'

export type { WorkspaceListRuntime, WorkspaceListRuntimeSettings, WorkspaceListTerminalMode } from '@gugu/core'

type WorkspaceRow = WorkspaceListRow & Record<string, unknown>
interface CountRow extends Record<string, unknown> {
  workspace_id: number
  count: string
}

/** Host 只提供 owner-scoped PostgreSQL 读取；偏好、运行能力与列表投影复用 Core。 */
export function createPostgresWorkspaceLister(pool: Pool, runtime: WorkspaceListRuntime) {
  const store: WorkspaceListReadPort = {
    async preferences(ownerId) {
      const result = await pool.query<{ data_json: string } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id = $1',
        [ownerId],
      )
      return result.rows[0]?.data_json
    },
    async workspaces(ownerId) {
      const result = await pool.query<WorkspaceRow>(
        `SELECT id, name, kind, folder_id, project_id, directory_id, enabled, is_default
       FROM workspaces WHERE user_id = $1 ORDER BY updated_at DESC`,
        [ownerId],
      )
      return result.rows
    },
    async boundSessionCounts(ownerId) {
      const result = await pool.query<CountRow>(
        `SELECT workspace_id, COUNT(id)::text AS count FROM conversation_sessions
       WHERE user_id = $1 AND workspace_id IS NOT NULL GROUP BY workspace_id`,
        [ownerId],
      )
      return result.rows
    },
  }
  return createWorkspaceLister(store, runtime)
}
