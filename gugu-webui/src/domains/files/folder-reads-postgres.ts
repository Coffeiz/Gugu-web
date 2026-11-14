import { CoreError } from '@gugu/core'
import type { Pool, QueryResultRow } from 'pg'
import type { FolderReadOperations, FolderResolvePathFilters } from './folder-reads.js'

type FolderRow = QueryResultRow & {
  id: number | string
  project_id: number | string | null
  workspace_directory_id: number | string | null
  parent_id: number | string | null
  name: string
  version: number | string | null
  file_count?: number | string
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function response(row: FolderRow, fileCount = 0) {
  return {
    id: Number(row.id),
    projectId: nullableNumber(row.project_id),
    workspaceDirectoryId: nullableNumber(row.workspace_directory_id),
    parentId: nullableNumber(row.parent_id),
    name: row.name,
    fileCount,
    folderCount: 0,
    version: Number(row.version ?? 1),
  }
}

async function loadFolder(pool: Pool, ownerId: string, folderId: number): Promise<FolderRow | null> {
  const result = await pool.query<FolderRow>(
    `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,
            folder.name,folder.version,COUNT(file.id) AS file_count
     FROM folders folder
     LEFT JOIN files file
       ON file.folder_id=folder.id AND file.user_id=folder.user_id AND file.deleted_at IS NULL
     WHERE folder.id=$1 AND folder.user_id=$2 AND folder.deleted_at IS NULL
     GROUP BY folder.id`,
    [folderId, ownerId],
  )
  return result.rows[0] ?? null
}

async function loadAncestor(pool: Pool, ownerId: string, folderId: number): Promise<FolderRow | null> {
  const result = await pool.query<FolderRow>(
    `SELECT id,project_id,workspace_directory_id,parent_id,name,version
     FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [folderId, ownerId],
  )
  return result.rows[0] ?? null
}

function sameScope(left: FolderRow, right: FolderRow): boolean {
  return nullableNumber(left.project_id) === nullableNumber(right.project_id)
    && nullableNumber(left.workspace_directory_id) === nullableNumber(right.workspace_directory_id)
}

function normalizedPath(pathValue: string): string[] {
  let decoded = pathValue
  try { decoded = decodeURIComponent(pathValue) } catch { /* Python unquote 保留非法百分号编码 */ }
  return decoded.split('/').filter((part) => part !== '' && part !== '.')
}

function folderPathResponse(row: FolderRow) {
  return response(row)
}

export function createPostgresFolderReadOperations(pool: Pool): FolderReadOperations {
  return {
    async getFolder(ownerId, folderId) {
      const folder = await loadFolder(pool, ownerId, folderId)
      return folder ? response(folder, Number(folder.file_count ?? 0)) : null
    },

    async getFolderLocation(ownerId, folderId) {
      const folder = await loadFolder(pool, ownerId, folderId)
      if (!folder) return null
      const chain = [folder]
      const seen = new Set<number>([Number(folder.id)])
      let parentId = nullableNumber(folder.parent_id)
      while (parentId !== null && chain.length < 64) {
        if (seen.has(parentId)) throw new CoreError('not_found', '文件夹位置不存在')
        seen.add(parentId)
        const parent = await loadAncestor(pool, ownerId, parentId)
        if (!parent || !sameScope(parent, folder)) throw new CoreError('not_found', '文件夹位置不存在')
        chain.push(parent)
        parentId = nullableNumber(parent.parent_id)
      }
      if (parentId !== null) throw new CoreError('not_found', '文件夹位置超过允许的层级')
      return {
        folder: response(folder, Number(folder.file_count ?? 0)),
        ancestors: chain.slice(1).reverse().map((ancestor) => response(ancestor)),
      }
    },

    async resolvePaths(ownerId, filters: FolderResolvePathFilters) {
      const { projectId, workspaceDirectoryId, parentId, paths } = filters
      if (projectId !== null && workspaceDirectoryId !== null) return []
      if (projectId !== null) {
        const project = await pool.query(
          'SELECT 1 FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [projectId, ownerId],
        )
        if (!project.rows.length) throw new CoreError('not_found', '项目不存在')
      }
      if (workspaceDirectoryId !== null) {
        const workspace = await pool.query(
          'SELECT 1 FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [workspaceDirectoryId, ownerId],
        )
        if (!workspace.rows.length) throw new CoreError('not_found', 'Workspace 不存在')
      }
      if (parentId !== null) {
        const parent = await pool.query<FolderRow>(
          `SELECT id,project_id,workspace_directory_id,parent_id,name,version
           FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [parentId, ownerId],
        )
        const row = parent.rows[0]
        if (!row || nullableNumber(row.project_id) !== projectId
          || nullableNumber(row.workspace_directory_id) !== workspaceDirectoryId) return []
      }

      const parsed = paths.map((path) => ({ path, parts: normalizedPath(path) }))
      const states = new Map<string, number | null>([['', parentId]])
      const found = new Map<number, FolderRow>()
      const maxDepth = Math.max(0, ...parsed.map((item) => item.parts.length))
      for (let depth = 0; depth < maxDepth; depth++) {
        const pairs = new Map<string, { parent: number; name: string }>()
        for (const item of parsed) {
          if (item.parts.length <= depth) continue
          const prefix = item.parts.slice(0, depth).join('/')
          if (!states.has(prefix)) continue
          const parent = states.get(prefix) ?? 0
          const name = item.parts[depth]!
          pairs.set(`${parent}\0${name}`, { parent, name })
        }
        if (!pairs.size) break
        const targets = [...pairs.values()]
        const rows = await pool.query<FolderRow>(
          `SELECT folder.id,folder.project_id,folder.workspace_directory_id,folder.parent_id,folder.name,folder.version
           FROM folders folder
           JOIN unnest($4::integer[],$5::text[]) AS wanted(parent_key,folder_name)
             ON COALESCE(folder.parent_id,0)=wanted.parent_key AND folder.name=wanted.folder_name
           WHERE folder.user_id=$1 AND folder.deleted_at IS NULL
             AND folder.project_id IS NOT DISTINCT FROM $2
             AND folder.workspace_directory_id IS NOT DISTINCT FROM $3
           LIMIT 256`,
          [ownerId, projectId, workspaceDirectoryId, targets.map((item) => item.parent), targets.map((item) => item.name)],
        )
        const byPair = new Map(rows.rows.map((row) => [`${Number(row.parent_id ?? 0)}\0${row.name}`, row]))
        const next = new Map<string, number>()
        for (const item of parsed) {
          if (item.parts.length <= depth) continue
          const prefix = item.parts.slice(0, depth).join('/')
          if (!states.has(prefix)) continue
          const folder = byPair.get(`${Number(states.get(prefix) ?? 0)}\0${item.parts[depth]}`)
          if (!folder) continue
          found.set(Number(folder.id), folder)
          next.set(item.parts.slice(0, depth + 1).join('/'), Number(folder.id))
        }
        states.clear()
        for (const [prefix, id] of next) states.set(prefix, id)
        if (!states.size) break
      }
      return [...found.values()].map(folderPathResponse)
    },
  }
}
