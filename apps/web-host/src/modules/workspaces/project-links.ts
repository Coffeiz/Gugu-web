import type { Pool } from 'pg'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import { CoreError } from '@gugu/core'
import type { RunIdentity } from '@gugu/core/agent'
import { sandboxTarget, workspaceDirectoryStorageKey } from './roots.js'

export function createWebProjectWorkspaceBinding(
  db: Kysely<Database>,
  authorize: (tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal) => Promise<boolean>,
) {
  return async (identity: RunIdentity, input: { project_id: number; workspace_id: number | string; bound: boolean }, signal: AbortSignal) => {
    if (typeof input.workspace_id !== 'number' || input.workspace_id > 2_147_483_647 || input.project_id > 2_147_483_647)
      throw new CoreError('invalid_request', '请选择 Web 文件库工作区')
    return db.transaction().execute(async tx => {
      if (!await authorize(tx, identity, signal)) throw new CoreError('conflict', '工作区操作授权已失效')
      const owner = identity.ownerId
      const project = await sql`SELECT id FROM projects WHERE id=${input.project_id}
        AND user_id=${owner} AND deleted_at IS NULL FOR SHARE`.execute(tx)
      if (!project.rows.length) throw new CoreError('not_found', '项目不存在')
      const workspace = await sql<{ id: number }>`SELECT d.id FROM workspaces w
        JOIN workspace_directories d ON d.id=w.directory_id AND d.user_id=w.user_id
        WHERE w.id=${input.workspace_id} AND w.user_id=${owner} AND w.kind='directory'
          AND d.deleted_at IS NULL AND (${!input.bound} OR w.enabled)
        FOR SHARE OF w, d`.execute(tx)
      const directory = workspace.rows[0]
      if (!directory) throw new CoreError('not_found', '文件库工作区不可用')
      signal.throwIfAborted()
      const changed = input.bound
        ? await sql`INSERT INTO project_workspace_directories (user_id, project_id, directory_id)
            VALUES (${owner}, ${input.project_id}, ${directory.id}) ON CONFLICT DO NOTHING RETURNING directory_id`.execute(tx)
        : await sql`DELETE FROM project_workspace_directories WHERE user_id=${owner}
            AND project_id=${input.project_id} AND directory_id=${directory.id} RETURNING directory_id`.execute(tx)
      return changed.rows.length > 0
    })
  }
}

export function webWorkspaceLocation(ownerId: string, directoryName: string) {
  return { kind: 'sandbox' as const, value: sandboxTarget(workspaceDirectoryStorageKey(ownerId, directoryName)) }
}

export async function readWebProjectWorkspaceLinks(pool: Pick<Pool, 'query'>, ownerId: string, projectId: number) {
  const { rows } = await pool.query<{ id: number; name: string; directory_name: string; enabled: boolean }>(`
    SELECT w.id, d.name, d.directory_name, w.enabled FROM project_workspace_directories l
    JOIN workspace_directories d ON d.id=l.directory_id AND d.user_id=l.user_id AND d.deleted_at IS NULL
    JOIN LATERAL (SELECT id, enabled FROM workspaces WHERE directory_id=d.id AND user_id=d.user_id
      AND kind='directory' ORDER BY enabled DESC, id LIMIT 1) w ON true
    WHERE l.user_id=$1 AND l.project_id=$2 ORDER BY w.id`, [ownerId, projectId])
  return rows.map(row => ({
    id: row.id, name: row.name, available: row.enabled,
    ...(row.enabled ? { location: webWorkspaceLocation(ownerId, row.directory_name) } : {}),
  }))
}
