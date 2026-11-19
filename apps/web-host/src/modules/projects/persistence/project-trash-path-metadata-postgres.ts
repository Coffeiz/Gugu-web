import type { Pool } from 'pg'
import type { ProjectTrashPathMetadataReader } from './project-trash-storage.js'

type QueryPool = Pick<Pool, 'query'>
type Row = Record<string, unknown>

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new Error('项目文件路径时间无效')
  return parsed.toISOString()
}

export function createPostgresProjectTrashPathMetadataReader(pool: QueryPool): ProjectTrashPathMetadataReader {
  return {
    async getOwnedProject(ownerId, projectId) {
      const result = await pool.query<Row>(
        `SELECT name, start_date::text AS start_date, created_at
         FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [projectId, ownerId],
      )
      const row = result.rows[0]
      return row ? {
        name: String(row.name),
        startDate: row.start_date == null ? null : String(row.start_date),
        createdAt: iso(row.created_at) ?? '',
      } : null
    },

    async getOwnedWorkspaceDirectory(ownerId, directoryId) {
      const result = await pool.query<Row>(
        `SELECT directory_name, deleted_at
         FROM workspace_directories WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [directoryId, ownerId],
      )
      const row = result.rows[0]
      return row ? {
        directoryName: String(row.directory_name),
        deletedAt: iso(row.deleted_at),
      } : null
    },

    async getOwnedMindMap(ownerId, mindMapId) {
      const result = await pool.query<Row>(
        `SELECT title FROM mind_maps WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [mindMapId, ownerId],
      )
      return result.rows[0] ? { title: String(result.rows[0].title) } : null
    },

    async resolveOwnedFolderPath(ownerId, folderId, projectId, workspaceDirectoryId) {
      const result = await pool.query<Row>(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_id, name, ARRAY[id]::integer[] AS visited, 0 AS depth
           FROM folders
           WHERE id = $1 AND user_id = $2
             AND project_id IS NOT DISTINCT FROM $3::integer
             AND workspace_directory_id IS NOT DISTINCT FROM $4::integer
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.name,
                  chain.visited || parent.id, chain.depth + 1
           FROM folders AS parent
           JOIN chain ON parent.id = chain.parent_id
           WHERE parent.user_id = $2
             AND parent.project_id IS NOT DISTINCT FROM $3::integer
             AND parent.workspace_directory_id IS NOT DISTINCT FROM $4::integer
             AND NOT parent.id = ANY(chain.visited)
         )
         SELECT name, parent_id
         FROM chain
         ORDER BY depth DESC`,
        [folderId, ownerId, projectId, workspaceDirectoryId],
      )
      const rows = result.rows
      if (!rows.length || rows[0]?.parent_id != null) return null
      return rows.map((row) => String(row.name)).join('/')
    },
  }
}
