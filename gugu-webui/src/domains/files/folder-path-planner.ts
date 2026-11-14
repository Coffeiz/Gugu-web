import type { PoolClient, QueryResultRow } from 'pg'
import { createLocalPathMirrorMutation, localPathMirrorEntryExists, type PathMirrorFileChange, type PreparedPathMirrorMutation } from './local-path-mirror.js'

type FolderRecord = QueryResultRow & {
  id: number | string
  parent_id: number | string | null
  name: string
  project_id: number | string | null
  workspace_directory_id: number | string | null
}

type FileRecord = QueryResultRow & {
  id: number | string
  folder_id: number | string
  storage_key: string
  display_name: string
  ext: string
  storage_backend: string
}

const invalidPathChars = /[\\/:*?"<>|]/g

function id(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function safePathName(value: string): string {
  const safe = value.replace(invalidPathChars, '_')
  if (!safe || safe === '.' || safe === '..') throw new Error('文件夹路径包含无效目录段')
  return safe
}

function folderKey(ownerId: string, base: string, names: string[]): string {
  return [ownerId, base, ...names.map(safePathName)].join('/')
}

function safeFilename(displayName: string, extension: string): string {
  const safeName = displayName.replace(invalidPathChars, '_')
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('文件名无效')
  return extension ? `${safeName}.${extension.toLowerCase()}` : safeName
}

function dateParts(startDate: unknown, createdAt: unknown): { year: string; month: string } {
  const source = startDate ?? createdAt
  const text = source instanceof Date ? source.toISOString().slice(0, 10) : String(source ?? '')
  const match = /^(\d{4})-(\d{2})/.exec(text)
  return match ? { year: match[1], month: match[2] } : { year: '', month: '' }
}

interface PathScope {
  projectId: number | null
  workspaceDirectoryId: number | null
  baseSegments: string[]
}

async function pathScope(client: PoolClient, ownerId: string, root: FolderRecord): Promise<PathScope> {
  const projectId = id(root.project_id)
  const workspaceDirectoryId = id(root.workspace_directory_id)
  if (projectId !== null && workspaceDirectoryId !== null)
    throw new Error('文件夹空间归属无效')
  if (workspaceDirectoryId !== null) {
    const result = await client.query<{ directory_name: string }>(
      `SELECT directory_name FROM workspace_directories
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [workspaceDirectoryId, ownerId],
    )
    const directoryName = result.rows[0]?.directory_name
    if (!directoryName) throw new Error('文件夹 Workspace 不存在')
    return { projectId, workspaceDirectoryId, baseSegments: ['workspace', safePathName(directoryName)] }
  }
  if (projectId !== null) {
    const result = await client.query<{ name: string; start_date: unknown; created_at: unknown }>(
      `SELECT name,start_date,created_at FROM projects
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [projectId, ownerId],
    )
    const project = result.rows[0]
    if (!project) throw new Error('文件夹所属项目不存在')
    const { year, month } = dateParts(project.start_date, project.created_at)
    return {
      projectId, workspaceDirectoryId,
      baseSegments: [
        '项目文件', ...(year && month ? [year, month] : []),
        `${safePathName(project.name)} #${projectId}`,
      ],
    }
  }
  return { projectId, workspaceDirectoryId, baseSegments: ['个人文件'] }
}

async function ancestorNames(client: PoolClient, ownerId: string, root: FolderRecord): Promise<string[]> {
  const expectedProject = id(root.project_id)
  const expectedWorkspace = id(root.workspace_directory_id)
  let parentId = id(root.parent_id)
  const reversed: string[] = []
  const seen = new Set<number>([Number(root.id)])
  while (parentId !== null) {
    if (seen.has(parentId)) throw new Error('文件夹路径存在循环')
    seen.add(parentId)
    const result = await client.query<FolderRecord>(
      `SELECT id,parent_id,name,project_id,workspace_directory_id
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [parentId, ownerId],
    )
    const parent = result.rows[0]
    if (!parent || id(parent.project_id) !== expectedProject || id(parent.workspace_directory_id) !== expectedWorkspace)
      throw new Error('文件夹父级归属无效')
    reversed.push(parent.name)
    parentId = id(parent.parent_id)
  }
  return reversed.reverse()
}

async function loadSubtree(client: PoolClient, ownerId: string, folderId: number): Promise<FolderRecord[]> {
  const result = await client.query<FolderRecord>(
    `WITH RECURSIVE subtree(id,parent_id,name,project_id,workspace_directory_id,visited) AS (
       SELECT id,parent_id,name,project_id,workspace_directory_id,ARRAY[id]::int[]
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent_id,child.name,child.project_id,child.workspace_directory_id,subtree.visited || child.id
       FROM folders child JOIN subtree ON child.parent_id=subtree.id
       WHERE child.user_id=$2 AND child.deleted_at IS NULL AND NOT child.id=ANY(subtree.visited)
     )
     SELECT id,parent_id,name,project_id,workspace_directory_id FROM subtree`,
    [folderId, ownerId],
  )
  return result.rows
}

function folderPaths(root: FolderRecord, subtree: FolderRecord[], ancestorPath: string[]): Map<number, string[]> {
  const byId = new Map(subtree.map((folder) => [Number(folder.id), folder]))
  const paths = new Map<number, string[]>()
  const resolve = (folder: FolderRecord, seen = new Set<number>()): string[] => {
    const folderId = Number(folder.id)
    const cached = paths.get(folderId)
    if (cached) return cached
    if (seen.has(folderId)) throw new Error('文件夹子树存在循环')
    seen.add(folderId)
    const parentId = id(folder.parent_id)
    const parent = parentId === null ? undefined : byId.get(parentId)
    const parentPath = parent ? resolve(parent, seen) : ancestorPath
    const result = [...parentPath, folder.name]
    paths.set(folderId, result)
    return result
  }
  for (const folder of subtree) {
    if (id(folder.project_id) !== id(root.project_id)
      || id(folder.workspace_directory_id) !== id(root.workspace_directory_id))
      throw new Error('文件夹子树跨越空间归属')
    resolve(folder)
  }
  return paths
}

/**
 * Builds a transaction-bound planner for Python PathMirror semantics. It updates every active
 * descendant file's key/scope in SQL before returning reversible physical file moves.
 */
export function createPostgresFolderPathMirrorPlanner(
  storageRoot: string,
  buildSearchRomaji: (name: string) => string,
): (client: PoolClient, ownerId: string, folderId: number, action: 'create' | 'rename' | 'move', beforeName: string | null, previousDirectoryKeys?: string[]) => Promise<PreparedPathMirrorMutation> {
  return async (client, ownerId, folderId, action, beforeName, previousDirectoryKeys = []) => {
    const rootResult = await client.query<FolderRecord>(
      `SELECT id,parent_id,name,project_id,workspace_directory_id
       FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [folderId, ownerId],
    )
    const root = rootResult.rows[0]
    if (!root) throw new Error('文件夹不存在')
    const scope = await pathScope(client, ownerId, root)
    const ancestorPath = await ancestorNames(client, ownerId, root)
    const subtree = await loadSubtree(client, ownerId, folderId)
    if (!subtree.length) throw new Error('文件夹子树为空')
    const paths = folderPaths(root, subtree, ancestorPath)
    const ensureDirectoryKeys = subtree.map((folder) => folderKey(ownerId, scope.baseSegments.join('/'), paths.get(Number(folder.id))!))
    const removeDirectoryKeys = action === 'move'
      ? previousDirectoryKeys
      : action === 'rename' && beforeName !== null
      ? subtree.map((folder) => {
        const names = [...paths.get(Number(folder.id))!]
        names[ancestorPath.length] = beforeName
        return folderKey(ownerId, scope.baseSegments.join('/'), names)
      })
      : []
    const moves: Array<{ fromKey: string; toKey: string }> = []
    const fileChanges: PathMirrorFileChange[] = []

    if (action !== 'create') {
      const folderIds = subtree.map((folder) => Number(folder.id))
      const filesResult = await client.query<FileRecord>(
        `SELECT id,folder_id,storage_key,display_name,ext,storage_backend
         FROM files WHERE user_id=$1 AND folder_id=ANY($2::int[]) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
        [ownerId, folderIds],
      )
      const reservedKeys = new Set<string>()
      for (const file of filesResult.rows) {
        if (file.storage_backend !== 'local') throw new Error('文件存储后端不支持 PathMirror relocate')
        const folderPath = paths.get(Number(file.folder_id))
        if (!folderPath) throw new Error('文件夹子树状态无效')
        const base = folderKey(ownerId, scope.baseSegments.join('/'), folderPath)
        const originalName = file.display_name
        let displayName = originalName
        let toKey = `${base}/${safeFilename(displayName, file.ext)}`
        if (toKey !== file.storage_key) {
          let suffix = 0
          while (reservedKeys.has(toKey) || await localPathMirrorEntryExists(storageRoot, ownerId, toKey)
            || (await client.query(
              `SELECT id FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL AND id<>$3 LIMIT 1`,
              [ownerId, toKey, Number(file.id)],
            )).rowCount) {
            suffix += 1
            displayName = `${originalName}(${suffix})`
            toKey = `${base}/${safeFilename(displayName, file.ext)}`
          }
          const updated = await client.query(
            `UPDATE files SET storage_key=$1,display_name=$2,search_romaji=$3,
               space=$4,project_id=$5,workspace_directory_id=$6,updated_at=CURRENT_TIMESTAMP
             WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`,
            [toKey, displayName, buildSearchRomaji(displayName),
              scope.workspaceDirectoryId !== null ? 'workspace' : scope.projectId !== null ? 'project' : 'personal',
              scope.projectId, scope.workspaceDirectoryId, Number(file.id), ownerId],
          )
          if (updated.rowCount !== 1) throw new Error('文件状态在搬迁期间发生变化')
          moves.push({ fromKey: file.storage_key, toKey })
          fileChanges.push({
            fileId: Number(file.id), beforeStorageKey: file.storage_key, afterStorageKey: toKey,
            beforeDisplayName: originalName, afterDisplayName: displayName,
          })
          reservedKeys.add(toKey)
        }
      }
    }

    const mutation = createLocalPathMirrorMutation(
      storageRoot, ownerId, moves, ensureDirectoryKeys, removeDirectoryKeys,
    )
    return { ...mutation, fileChanges }
  }
}

export async function capturePostgresFolderPathMirrorDirectoryKeys(
  storageRoot: string,
  client: PoolClient,
  ownerId: string,
  folderId: number,
): Promise<string[]> {
  const rootResult = await client.query<FolderRecord>(
    `SELECT id,parent_id,name,project_id,workspace_directory_id
     FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [folderId, ownerId],
  )
  const root = rootResult.rows[0]
  if (!root) throw new Error('文件夹不存在')
  const scope = await pathScope(client, ownerId, root)
  const ancestorPath = await ancestorNames(client, ownerId, root)
  const subtree = await loadSubtree(client, ownerId, folderId)
  if (!subtree.length) throw new Error('文件夹子树为空')
  const paths = folderPaths(root, subtree, ancestorPath)
  return subtree.map((folder) => folderKey(ownerId, scope.baseSegments.join('/'), paths.get(Number(folder.id))!))
}
