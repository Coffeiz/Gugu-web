import { projectFileStorageKey } from '../files/paths.js'
import { readPathDirectoryOverview } from '../workspaces/files.js'
import { createProjectListing as createCoreProjectListing, createProjectGetter as createCoreProjectGetter,
  createProjectFileCountListing as createCoreProjectFileCountListing } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { Pool, PoolClient } from 'pg'

export function projectTimestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
}

function createPathProjectFileCountReader(pool: Pick<Pool, 'query'>, storageRoot: string) {
  async function read(ownerId: string, ids: readonly number[] | null, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const { rows } = await pool.query<{ id: number; name: string; start_date: string | null; created_at: Date }>(
      'SELECT id,name,start_date,created_at FROM projects WHERE user_id=$1 AND ($2::int[] IS NULL OR id=ANY($2)) ORDER BY id',
      [ownerId, ids],
    )
    const counts: Array<{ projectId: number; fileCount: number }> = []
    for (const row of rows) {
      signal?.throwIfAborted()
      const key = projectFileStorageKey(ownerId, row.id, row.name, row.start_date, row.created_at)
      const { total } = await readPathDirectoryOverview(storageRoot, key, signal)
      counts.push({ projectId: row.id, fileCount: total })
    }
    signal?.throwIfAborted()
    return counts
  }
  return {
    async forProjects(ownerId: string, ids: readonly number[], signal?: AbortSignal) {
      if (!ids.length) return new Map<number, number>()
      return new Map((await read(ownerId, ids, signal)).map(item => [item.projectId, item.fileCount]))
    },
    list: (ownerId: string, signal?: AbortSignal) => read(ownerId, null, signal),
  }
}

export async function readProjectFileCount(pool: Pool, storageRoot: string, ownerId: string, projectId: number): Promise<number> {
  const counts = await createPathProjectFileCountReader(pool, storageRoot).forProjects(ownerId, [projectId])
  return counts.get(projectId) ?? 0
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

export function createProjectListing(core: SqlDataRuntime, pool: Pool, storageRoot: string) {
  return createCoreProjectListing(core, createPathProjectFileCountReader(pool, storageRoot))
}

export function createProjectGetter(core: SqlDataRuntime, pool: Pool, storageRoot: string) {
  return createCoreProjectGetter(core, createPathProjectFileCountReader(pool, storageRoot))
}

export function createProjectFileCountListing(pool: Pool, storageRoot: string) {
  return createCoreProjectFileCountListing(createPathProjectFileCountReader(pool, storageRoot))
}
