import { createProjectListing as createCoreProjectListing, createProjectGetter as createCoreProjectGetter,
  createProjectFileCountListing as createCoreProjectFileCountListing } from '@gugu/core'
import type { ProjectFileCountPort } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { Pool, PoolClient } from 'pg'

export function projectTimestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
}

async function projectFileCounts(pool: Pool, ownerId: string, projectIds: number[]) {
  if (projectIds.length === 0) return new Map<number, number>()
  const counts = await pool.query<{ project_id: number; file_count: string }>(
    `SELECT counts.project_id, counts.file_count
     FROM project_file_counts AS counts
     JOIN projects ON projects.id = counts.project_id
     WHERE projects.user_id = $1 AND counts.project_id = ANY($2::integer[])`,
    [ownerId, projectIds],
  )
  return new Map(counts.rows.map((row) => [row.project_id, Number(row.file_count)]))
}

export async function readProjectFileCount(pool: Pool, ownerId: string, projectId: number): Promise<number> {
  const counts = await projectFileCounts(pool, ownerId, [projectId])
  return counts.get(projectId) ?? 0
}

/** 按当前用户的存活项目文件与目录生成上下文概览。 */
export async function readProjectFileOverview(pool: Pick<Pool, 'query'>, ownerId: string, projectId: number) {
  const result = await pool.query<{ total_file_count: string; root_file_count: string; total_folder_count: string }>(
    `SELECT
       (SELECT count(*) FROM files WHERE user_id=$1 AND project_id=$2 AND space='project' AND deleted_at IS NULL) AS total_file_count,
       (SELECT count(*) FROM files WHERE user_id=$1 AND project_id=$2 AND space='project' AND folder_id IS NULL AND deleted_at IS NULL) AS root_file_count,
       (SELECT count(*) FROM folders WHERE user_id=$1 AND project_id=$2 AND deleted_at IS NULL) AS total_folder_count`,
    [ownerId, projectId],
  )
  const row = result.rows[0]!
  return { total_file_count: Number(row.total_file_count), root_file_count: Number(row.root_file_count), total_folder_count: Number(row.total_folder_count) }
}

export async function projectExistsForOwner(
  client: PoolClient,
  ownerId: string,
  projectId: number,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM projects
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [projectId, ownerId],
  )
  return result.rowCount === 1
}

export function createProjectListing(core: SqlDataRuntime, pool: Pool) {
  return createCoreProjectListing(core, projectCountPort(pool))
}

export function createProjectGetter(core: SqlDataRuntime, pool: Pool) {
  return createCoreProjectGetter(core, projectCountPort(pool))
}

function projectCountPort(pool: Pool): ProjectFileCountPort {
  return {
    forProjects: (owner, ids) => projectFileCounts(pool, owner, [...ids]),
    async list(ownerId) {
      const result = await pool.query<{ project_id: number; file_count: string }>(
        `SELECT projects.id AS project_id, COALESCE(counts.file_count, 0) AS file_count
         FROM projects
         LEFT JOIN project_file_counts AS counts ON counts.project_id = projects.id
         WHERE projects.user_id = $1
         ORDER BY projects.id`,
        [ownerId],
      )
      return result.rows.map((row) => ({ projectId: row.project_id, fileCount: Number(row.file_count) }))
    },
  }
}

export function createProjectFileCountListing(pool: Pool) {
  return createCoreProjectFileCountListing(projectCountPort(pool))
}
