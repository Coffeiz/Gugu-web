import type { ProjectRecord } from '../contracts/index.js'
import { ProjectTrashStoragePathError, type ProjectTrashFile, type ProjectTrashFolder } from './project-trash.js'

// 旧模型 ID 仅用于兼容已有归属元数据；实际文件定位与移动使用逻辑路径。
const INVALID_NAME = /[\\/:*?"<>|]/g

export function safeName(value: string): string { return value.replace(INVALID_NAME, '_') }

function safeFilename(displayName: string, ext: string): string {
  const name = safeName(displayName)
  return ext ? `${name}.${ext.toLowerCase()}` : name
}

export function safeKey(ownerId: string, key: string): string[] {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new ProjectTrashStoragePathError('文件存储 key 必须是安全相对路径')
  const segments = key.split('/')
  if (segments[0] !== ownerId || segments.some((part) => !part || part === '.' || part === '..'))
    throw new ProjectTrashStoragePathError('文件存储 key 与 owner 不匹配')
  return segments
}

export function trashKey(ownerId: string, file: ProjectTrashFile): string {
  const segments = safeKey(ownerId, file.storage_key)
  const logicalParent = segments.slice(1, -1)
  if (logicalParent.length) logicalParent.shift()
  const parent = logicalParent.length ? `${logicalParent.join('/')}/` : ''
  const filename = `${safeName(file.display_name)}.${file.ext.toLowerCase()}`
  return `${ownerId}/trash/${parent}${filename}`
}

export function withConflictName(key: string, displayName: string, ext: string, number: number): { key: string; name: string } {
  const parent = key.slice(0, key.lastIndexOf('/') + 1)
  const name = `${displayName}(${number})`
  return { key: `${parent}${safeName(name)}.${ext.toLowerCase()}`, name }
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

export interface OriginalStorageKeyParts {
  projectName: string
  projectId: number
  projectDate: string
  mindMapTitle: string
  mindMapId: number
  workspaceDirectoryName: string
  folderPath: string
}

export function buildOriginalKey(ownerId: string, file: Pick<ProjectTrashFile, 'space' | 'display_name' | 'ext'>, parts: OriginalStorageKeyParts): string {
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
  return async (ownerId, file, _project, _folders) => {
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
