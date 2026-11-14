import { chmod, chown, lstat, mkdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProjectTrashFile,
  ProjectTrashFolder,
  ProjectTrashStorage,
} from '../application/project-trash.js'
import { ProjectTrashStoragePathError } from '../application/project-trash.js'
import type { ProjectRecord } from '@gugu/core'
import { isPathWithin } from '../../../adapters/path-safety.js'

const INVALID_NAME = /[\\/:*?"<>|]/g

function safeName(value: string): string { return value.replace(INVALID_NAME, '_') }

function safeFilename(displayName: string, ext: string): string {
  const name = safeName(displayName)
  return ext ? `${name}.${ext.toLowerCase()}` : name
}

function safeKey(ownerId: string, key: string): string[] {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new ProjectTrashStoragePathError('文件存储 key 必须是安全相对路径')
  const segments = key.split('/')
  if (segments[0] !== ownerId || segments.some((part) => !part || part === '.' || part === '..'))
    throw new ProjectTrashStoragePathError('文件存储 key 与 owner 不匹配')
  return segments
}

function trashKey(ownerId: string, file: ProjectTrashFile): string {
  const segments = safeKey(ownerId, file.storage_key)
  const logicalParent = segments.slice(1, -1)
  if (logicalParent.length) logicalParent.shift()
  const parent = logicalParent.length ? `${logicalParent.join('/')}/` : ''
  const filename = `${safeName(file.display_name)}.${file.ext.toLowerCase()}`
  return `${ownerId}/trash/${parent}${filename}`
}

function withConflictName(key: string, displayName: string, ext: string, number: number): { key: string; name: string } {
  const parent = key.slice(0, key.lastIndexOf('/') + 1)
  const name = `${displayName}(${number})`
  return { key: `${parent}${safeName(name)}.${ext.toLowerCase()}`, name }
}

async function checkedPath(root: string, ownerId: string, key: string, allowMissing = true): Promise<string> {
  const segments = safeKey(ownerId, key)
  const target = path.resolve(root, ...segments)
  if (!isPathWithin(root, target)) throw new ProjectTrashStoragePathError('文件存储路径超出配置根目录')
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new ProjectTrashStoragePathError('文件存储路径不能经过符号链接')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (allowMissing && (code === 'ENOENT' || code === 'ENOTDIR')) break
      throw error
    }
  }
  return target
}

async function verifyRealFileWithin(root: string, target: string): Promise<void> {
  const resolved = await realpath(target)
  if (!isPathWithin(root, resolved)) throw new ProjectTrashStoragePathError('文件存储路径超出配置根目录')
}

async function inheritGroupAccess(filePath: string): Promise<void> {
  try {
    const parent = await stat(path.dirname(filePath))
    const current = await lstat(filePath)
    await chown(filePath, current.uid, parent.gid)
    await chmod(filePath, (current.mode & 0o7777) | 0o060)
  } catch { /* 与 Python 存储一致：文件移动成功优先，权限修复为 best-effort */ }
}

export type OriginalProjectFileKey = (
  ownerId: string,
  file: ProjectTrashFile,
  project: ProjectRecord,
  folders: ProjectTrashFolder[],
) => Promise<string> | string

export interface ProjectTrashPathMetadataReader {
  getOwnedProject(ownerId: string, projectId: number): Promise<{
    name: string
    startDate: string | null
    createdAt: string
  } | null>
  getOwnedWorkspaceDirectory(ownerId: string, directoryId: number): Promise<{
    directoryName: string
    deletedAt: string | null
  } | null>
  getOwnedMindMap(ownerId: string, mindMapId: number): Promise<{ title: string } | null>
  resolveOwnedFolderPath(
    ownerId: string,
    folderId: number,
    projectId: number | null,
    workspaceDirectoryId: number | null,
  ): Promise<string | null>
}

interface OriginalStorageKeyParts {
  projectName: string
  projectId: number
  projectDate: string
  mindMapTitle: string
  mindMapId: number
  workspaceDirectoryName: string
  folderPath: string
}

function buildOriginalKey(ownerId: string, file: ProjectTrashFile, parts: OriginalStorageKeyParts): string {
  const filename = safeFilename(file.display_name, file.ext)
  const folder = parts.folderPath.split('/').filter(Boolean).map(safeName).join('/')
  if (file.space === 'project') {
    const year = parts.projectDate.slice(0, 4)
    const month = parts.projectDate.slice(5, 7)
    const datePath = year && month ? `${year}/${month}/` : ''
    const projectPath = `${safeName(parts.projectName)} #${parts.projectId}`
    return `${ownerId}/项目文件/${datePath}${projectPath}${folder ? `/${folder}` : ''}/${filename}`
  }
  if (file.space === 'mind') {
    return `${ownerId}/思维/${safeName(parts.mindMapTitle)} #${parts.mindMapId}/${filename}`
  }
  if (file.space === 'asset') return `${ownerId}/素材板/${filename}`
  if (file.space === 'workspace') {
    if (!parts.workspaceDirectoryName || parts.workspaceDirectoryName === '.' || parts.workspaceDirectoryName === '..'
      || safeName(parts.workspaceDirectoryName) !== parts.workspaceDirectoryName)
      throw new Error('工作区目录名无效')
    return `${ownerId}/workspace/${parts.workspaceDirectoryName}${folder ? `/${folder}` : ''}/${filename}`
  }
  return `${ownerId}/个人文件/${folder ? `${folder}/` : ''}${filename}`
}

/** Python `original_storage_key` 关系读取语义：Workspace 严格，MindMap/Project 缺失时保留空名称，坏 folder chain 为空路径。 */
export function createProjectTrashOriginalStorageKeyResolver(
  reader: ProjectTrashPathMetadataReader,
): OriginalProjectFileKey {
  return async (ownerId, file, project, folders) => {
    let workspaceDirectoryName = ''
    if (file.workspace_directory_id !== null) {
      const directory = await reader.getOwnedWorkspaceDirectory(ownerId, file.workspace_directory_id)
      if (!directory || directory.deletedAt !== null) throw new Error('工作区目录不存在')
      workspaceDirectoryName = directory.directoryName
    }

    const projectRow = file.project_id
      ? await reader.getOwnedProject(ownerId, file.project_id)
      : null
    let folderPath = ''
    if (file.folder_id) {
      folderPath = await reader.resolveOwnedFolderPath(
        ownerId, file.folder_id, file.project_id, file.workspace_directory_id,
      ) ?? ''
    }
    const mindMap = file.mind_map_id
      ? await reader.getOwnedMindMap(ownerId, file.mind_map_id)
      : null
    const projectName = projectRow?.name ?? ''
    const projectDate = projectRow ? (projectRow.startDate || projectRow.createdAt) : ''

    return buildOriginalKey(ownerId, file, {
      projectName,
      projectId: file.project_id || 0,
      projectDate,
      mindMapTitle: mindMap?.title ?? '',
      mindMapId: file.mind_map_id || 0,
      workspaceDirectoryName,
      folderPath,
    })
  }
}

function folderPath(file: ProjectTrashFile, folders: ProjectTrashFolder[]): string {
  if (file.folder_id == null) return ''
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const names: string[] = []
  const seen = new Set<number>()
  let current = byId.get(file.folder_id)
  if (!current || current.user_id !== file.user_id
    || current.project_id !== file.project_id
    || current.workspace_directory_id !== file.workspace_directory_id) return ''
  while (current) {
    if (seen.has(current.id)) return ''
    seen.add(current.id)
    names.unshift(safeName(current.name))
    if (current.parent_id == null) break
    const parent = byId.get(current.parent_id)
    if (!parent || parent.user_id !== file.user_id
      || parent.project_id !== file.project_id
      || parent.workspace_directory_id !== file.workspace_directory_id) return ''
    current = parent
  }
  return names.join('/')
}

/** 项目文件默认 key builder；非项目空间可由 Host 注入带 mind-map/workspace 元数据的解析器。 */
export function projectOriginalStorageKey(
  ownerId: string,
  file: ProjectTrashFile,
  project: ProjectRecord,
  folders: ProjectTrashFolder[],
): string {
  return buildOriginalKey(ownerId, file, {
    projectName: file.project_id ? project.name : '',
    projectId: file.project_id || 0,
    projectDate: file.project_id ? project.start_date || project.created_at : '',
    mindMapTitle: '',
    mindMapId: file.mind_map_id || 0,
    workspaceDirectoryName: '',
    folderPath: folderPath(file, folders),
  })
}

/** Python files.trash.py 中本地回收站 key 的纯函数等价实现。 */
export function projectFileTrashKey(ownerId: string, file: ProjectTrashFile): string {
  return trashKey(ownerId, file)
}

/** LocalStorageBackend 语义：物理 rename、(n) 冲突名、越界/symlink fail-closed。 */
export function createLocalProjectTrashStorage(
  storageRoot: string,
  originalKeyFor: OriginalProjectFileKey = projectOriginalStorageKey,
): ProjectTrashStorage {
  const absoluteRoot = path.resolve(storageRoot)

  async function rootPath(): Promise<string> {
    const root = await realpath(absoluteRoot)
    if (!isPathWithin(root, root)) throw new ProjectTrashStoragePathError('存储根目录无效')
    return root
  }

  async function findAvailableKey(root: string, ownerId: string, baseKey: string, displayName: string, ext: string) {
    let candidate = baseKey
    let name = displayName
    for (let index = 1; ; index += 1) {
      const absolute = await checkedPath(root, ownerId, candidate)
      try {
        await lstat(absolute)
        const next = withConflictName(baseKey, displayName, ext, index)
        candidate = next.key
        name = next.name
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { key: candidate, name }
        throw error
      }
    }
  }

  async function move(oldKey: string, newKey: string, ownerId: string): Promise<() => Promise<void>> {
    const root = await rootPath()
    const oldPath = await checkedPath(root, ownerId, oldKey, false)
    const newPath = await checkedPath(root, ownerId, newKey)
    const newParent = path.dirname(newPath)
    await mkdir(newParent, { recursive: true })
    await checkedPath(root, ownerId, newKey)
    await rename(oldPath, newPath)
    try {
      await checkedPath(root, ownerId, newKey, false)
      await verifyRealFileWithin(root, newPath)
    } catch (error) {
      try {
        await rename(newPath, oldPath)
      } catch {
        throw new ProjectTrashStoragePathError('文件移动后无法恢复原路径')
      }
      throw error
    }
    await inheritGroupAccess(newPath)
    let rolledBack = false
    return async () => {
      if (rolledBack) return
      await move(newKey, oldKey, ownerId)
      rolledBack = true
    }
  }

  return {
    async moveToTrash(ownerId, file) {
      const root = await rootPath()
      const baseKey = trashKey(ownerId, file)
      if (file.storage_key === baseKey) return { storageKey: file.storage_key }
      const available = await findAvailableKey(root, ownerId, baseKey, file.display_name, file.ext)
      try {
        const rollback = await move(file.storage_key, available.key, ownerId)
        return { storageKey: available.key, rollback }
      } catch (error) {
        if (error instanceof ProjectTrashStoragePathError) throw error
        // Python 捕获 storage.rename_file 异常，继续提交墓碑并保留原 key。
        return { storageKey: file.storage_key }
      }
    },
    async restoreFromTrash(ownerId, file, project, folders) {
      const baseKey = await originalKeyFor(ownerId, file, project, folders)
      safeKey(ownerId, baseKey)
      let available: { key: string; name: string }
      let root: string | null
      try {
        root = await rootPath()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        root = null
      }
      if (!root) {
        available = { key: baseKey, name: file.display_name }
      } else if (file.storage_key === baseKey) {
        available = { key: baseKey, name: file.display_name }
      } else {
        available = await findAvailableKey(root, ownerId, baseKey, file.display_name, file.ext)
      }
      let rollback: (() => Promise<void>) | undefined
      try {
        if (file.storage_key !== available.key) rollback = await move(file.storage_key, available.key, ownerId)
      } catch (error) {
        if (error instanceof ProjectTrashStoragePathError) throw error
        /* 与 restore_file_storage 一致：物理源缺失时也复原预期 DB 路径 */
      }
      return { storageKey: available.key, displayName: available.name, rollback }
    },
  }
}
