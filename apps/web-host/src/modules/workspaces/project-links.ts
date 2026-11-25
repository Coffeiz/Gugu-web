import type { Pool } from 'pg'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import { CoreError } from '@gugu/core'
import type { RunIdentity } from '@gugu/core/agent'
import { sandboxTarget, workspaceDirectoryPath } from './roots.js'

export function createWebProjectWorkspaceBinding(
  db: Kysely<Database>,
  authorize: (tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal) => Promise<boolean>,
) {
  return async (identity: RunIdentity, input: { project_id: number; workspace_id: number | string; bound: boolean }, signal: AbortSignal) => {
    return db.transaction().execute(async tx => {
      if (!await authorize(tx, identity, signal)) throw new CoreError('conflict', '工作区操作授权已失效')
      return changeProjectWorkspace(tx, identity.ownerId, input, signal)
    })
  }
}

async function changeProjectWorkspace(tx: Transaction<Database>, owner: string,
  input: { project_id: number; workspace_id: number | string | null; bound: boolean }, signal?: AbortSignal) {
  if (!Number.isInteger(input.project_id) || input.project_id < 1 || input.project_id > 2_147_483_647
    || (input.workspace_id !== null && (typeof input.workspace_id !== 'number' || !Number.isInteger(input.workspace_id)
      || input.workspace_id < 1 || input.workspace_id > 2_147_483_647)))
    throw new CoreError('invalid_request', '请选择 Web 文件库工作区')
  const project = await sql`SELECT id FROM projects WHERE id=${input.project_id}
    AND user_id=${owner} AND deleted_at IS NULL FOR UPDATE`.execute(tx)
  if (!project.rows.length) throw new CoreError('not_found', '项目不存在')
  let directory: number | undefined
  if (input.workspace_id !== null) {
    const result = await sql<{ id: number }>`SELECT d.id FROM workspaces w
      JOIN workspace_directories d ON d.id=w.directory_id AND d.user_id=w.user_id
      WHERE w.id=${input.workspace_id} AND w.user_id=${owner} AND w.kind='directory'
        AND d.deleted_at IS NULL AND (${!input.bound} OR w.enabled)
      FOR SHARE OF w, d`.execute(tx)
    directory = result.rows[0]?.id
    if (directory === undefined) throw new CoreError('not_found', '文件库工作区不可用')
  }
  signal?.throwIfAborted()
  if (!input.bound && directory !== undefined) {
    const changed = await sql`DELETE FROM project_workspace_directories WHERE user_id=${owner}
      AND project_id=${input.project_id} AND directory_id=${directory} RETURNING directory_id`.execute(tx)
    return changed.rows.length > 0
  }
  const cleared = await sql`UPDATE project_workspace_directories SET active=false WHERE user_id=${owner}
    AND project_id=${input.project_id} AND active
    AND directory_id IS DISTINCT FROM ${directory ?? null} RETURNING directory_id`.execute(tx)
  if (directory === undefined) return cleared.rows.length > 0
  const selected = await sql`INSERT INTO project_workspace_directories (user_id, project_id, directory_id, active)
    VALUES (${owner}, ${input.project_id}, ${directory}, true)
    ON CONFLICT (user_id, project_id, directory_id) DO UPDATE SET active=true
    WHERE NOT project_workspace_directories.active RETURNING directory_id`.execute(tx)
  return selected.rows.length > 0 || cleared.rows.length > 0
}

export function createWebProjectWorkspaceSelection(db: Kysely<Database>, pool: Pick<Pool, 'query'>) {
  return {
    async list(owner: string, project: number) {
      const { rows } = await pool.query<{ id: number; directory_id: number; name: string; active: boolean; bound: boolean }>(`
        SELECT w.id, d.id AS directory_id, d.name, COALESCE(l.active,false) AS active, l.directory_id IS NOT NULL AS bound
        FROM projects p JOIN workspace_directories d ON d.user_id=p.user_id AND d.deleted_at IS NULL
        JOIN LATERAL (SELECT id FROM workspaces WHERE user_id=d.user_id AND directory_id=d.id
          AND kind='directory' AND enabled ORDER BY id LIMIT 1) w ON true
        LEFT JOIN project_workspace_directories l ON l.user_id=p.user_id AND l.project_id=p.id AND l.directory_id=d.id
        WHERE p.user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL ORDER BY d.name, d.id`, [owner, project])
      return rows.map(row => ({ id: row.directory_id, workspaceId: row.id, name: row.name, active: row.active, bound: row.bound, available: true }))
    },
    select(owner: string, project: number, workspaceId: number | null) {
      return db.transaction().execute(tx => changeProjectWorkspace(tx, owner, {
        project_id: project, workspace_id: workspaceId, bound: true,
      }))
    },
  }
}

export function webWorkspaceLocation(ownerId: string, directoryName: string) {
  return { kind: 'sandbox' as const, value: sandboxTarget(workspaceDirectoryPath(ownerId, directoryName)) }
}

export async function readWebProjectWorkspaceLinks(pool: Pick<Pool, 'query'>, ownerId: string, projectId: number) {
  const { rows } = await pool.query<{ id: number; name: string; directory_name: string; directory_id: number; enabled: boolean; active: boolean }>(`
    SELECT w.id, d.id AS directory_id, d.name, d.directory_name, w.enabled, l.active FROM project_workspace_directories l
    JOIN workspace_directories d ON d.id=l.directory_id AND d.user_id=l.user_id AND d.deleted_at IS NULL
    JOIN LATERAL (SELECT id, enabled FROM workspaces WHERE directory_id=d.id AND user_id=d.user_id
      AND kind='directory' ORDER BY enabled DESC, id LIMIT 1) w ON true
    WHERE l.user_id=$1 AND l.project_id=$2 ORDER BY w.id`, [ownerId, projectId])
  return rows.map(row => ({
    id: row.id, directoryId: row.directory_id, name: row.name, available: row.enabled, active: row.enabled && row.active,
    ...(row.enabled ? { location: webWorkspaceLocation(ownerId, row.directory_name) } : {}),
  }))
}
