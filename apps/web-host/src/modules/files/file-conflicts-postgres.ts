import { CoreError } from '@gugu/core'
import type { Pool, QueryResultRow } from 'pg'
import type { FileConflictInput, FileConflictOperations } from './file-conflicts.js'

type FileRow = QueryResultRow & Record<string, unknown> & {
  id: number | string
  display_name: string
  ext: string
  space: string
  workspace_directory_id: number | string | null
  project_id: number | string | null
  project_name: string | null
  project_color: string | null
  stage_name: string
  folder_id: number | string | null
  folder_name: string | null
  mind_map_id: number | string | null
  size: string
  size_bytes: number | string
  mime_type: string | null
  created_at: string
  deleted_at: string | null
  img_width: number | string | null
  img_height: number | string | null
  version: number | string | null
}

function parseFilename(filename: string): { displayName: string; ext: string } {
  if (filename.startsWith('.') && filename.length > 1 && !filename.slice(1).includes('.'))
    return { displayName: filename, ext: 'FILE' }
  if (filename.endsWith('.') && filename.length > 1)
    return { displayName: filename.slice(0, -1), ext: 'FILE' }
  const dot = filename.lastIndexOf('.')
  return dot < 0
    ? { displayName: filename, ext: 'FILE' }
    : { displayName: filename.slice(0, dot), ext: filename.slice(dot + 1).toUpperCase().slice(0, 10) }
}

function fileResponse(row: FileRow) {
  return {
    id: Number(row.id),
    display_name: row.display_name,
    ext: row.ext,
    space: row.space,
    workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
    project_id: row.project_id === null ? null : Number(row.project_id),
    project_name: row.project_name,
    project_color: row.project_color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? row.project_color,
    stage_name: row.stage_name,
    folder_id: row.folder_id === null ? null : Number(row.folder_id),
    folder_name: row.folder_name,
    mind_map_id: row.mind_map_id === null ? null : Number(row.mind_map_id),
    size: row.size,
    size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type,
    created_at: row.created_at.endsWith('Z') ? row.created_at : `${row.created_at}Z`,
    deleted_at: row.deleted_at,
    img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height),
    version: Number(row.version ?? 1),
  }
}

async function findConflict(pool: Pool, ownerId: string, input: FileConflictInput): Promise<FileRow | null> {
  const { displayName, ext } = parseFilename(input.filename)
  const result = await pool.query<FileRow>(
    `SELECT file.id,file.display_name,file.ext,file.space,file.workspace_directory_id,file.project_id,
       project.name AS project_name,project.color AS project_color,file.stage_name,file.folder_id,folder.name AS folder_name,
       file.mind_map_id,file.size,file.size_bytes,file.mime_type,
       to_char(file.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
       NULL::text AS deleted_at,file.img_width,file.img_height,file.version
     FROM files file
     LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
     LEFT JOIN folders folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
     WHERE file.user_id=$1 AND file.deleted_at IS NULL AND file.space=$2 AND file.display_name=$3 AND file.ext=$4
       AND file.project_id IS NOT DISTINCT FROM $5
       AND file.folder_id IS NOT DISTINCT FROM $6
       AND file.workspace_directory_id IS NOT DISTINCT FROM $7
     LIMIT 1`,
    [ownerId, input.space, displayName, ext, input.projectId, input.folderId, input.workspaceDirectoryId],
  )
  return result.rows[0] ?? null
}

export function createPostgresFileConflictOperations(pool: Pool): FileConflictOperations {
  return {
    async find(rawOwner, items) {
      if (!/^[0-9a-f-]{36}$/i.test(rawOwner)) throw new CoreError('invalid_request', '用户标识无效')
      const ownerId = rawOwner.toLowerCase()
      const results = []
      for (const item of items) {
        const existing = await findConflict(pool, ownerId, item)
        results.push({
          filename: item.filename,
          conflict: existing !== null,
          existing_file: existing ? fileResponse(existing) : null,
        })
      }
      return results
    },
  }
}
