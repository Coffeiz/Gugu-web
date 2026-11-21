import type { FileMeta, FolderMeta } from '@/stores/filesCache'

export interface ArchiveScope {
  space: 'personal' | 'project' | 'workspace'
  projectId: number | null
  workspaceDirectoryId: number | null
}

export function archiveScopeOfFile(file: Pick<FileMeta, 'space' | 'projectId' | 'workspaceDirectoryId'>): ArchiveScope | null {
  if (file.space === 'workspace' && file.workspaceDirectoryId != null) {
    return { space: 'workspace', projectId: null, workspaceDirectoryId: file.workspaceDirectoryId }
  }
  if (file.space === 'project' && file.projectId != null) {
    return { space: 'project', projectId: file.projectId, workspaceDirectoryId: null }
  }
  if (file.space === 'personal' && file.projectId == null && file.workspaceDirectoryId == null) {
    return { space: 'personal', projectId: null, workspaceDirectoryId: null }
  }
  return null
}

export function archiveScopeOfFolder(folder: Pick<FolderMeta, 'projectId' | 'workspaceDirectoryId'>): ArchiveScope {
  if (folder.workspaceDirectoryId != null) {
    return { space: 'workspace', projectId: null, workspaceDirectoryId: folder.workspaceDirectoryId }
  }
  if (folder.projectId != null) {
    return { space: 'project', projectId: folder.projectId, workspaceDirectoryId: null }
  }
  return { space: 'personal', projectId: null, workspaceDirectoryId: null }
}

export function isExtractableArchive(file: Pick<FileMeta, 'displayName' | 'ext'>): boolean {
  return archiveFormatForFile(file) != null
}

type ArchiveContextTarget = {
  id?: number | string
  displayName?: string
  ext?: string
}

export function findSelectedExtractableArchive(
  selectedFileIds: ReadonlySet<number>,
  selectedFolderIds: ReadonlySet<number | string>,
  getFile: (id: number) => FileMeta | null,
): FileMeta | null {
  if (selectedFileIds.size !== 1 || selectedFolderIds.size !== 0) return null
  const [id] = selectedFileIds
  if (id == null) return null
  const file = getFile(id)
  return file && isExtractableArchive(file) ? file : null
}

export function canExtractArchiveContext(
  type: string | null,
  target: ArchiveContextTarget | null,
): boolean {
  return (type === 'file' || type === 'multi-file')
    && target != null
    && typeof target.displayName === 'string'
    && typeof target.ext === 'string'
    && isExtractableArchive({ displayName: target.displayName, ext: target.ext })
}

export function canCompressArchiveContext(
  type: string | null,
  target: ArchiveContextTarget | null,
  selectedFileIds: ReadonlySet<number>,
  selectedFolderIds: ReadonlySet<number | string>,
): boolean {
  const hasSelection = selectedFileIds.size + selectedFolderIds.size > 0
  if (type === 'multi-file') return hasSelection
  // 用户可能在多选后右键落在未选中的文件卡上；压缩动作仍然针对当前选择集合。
  if (type === 'file' && hasSelection) return true
  if (target?.id == null) return false
  if (type === 'file') return selectedFileIds.has(Number(target.id))
  if (type === 'folder') return selectedFolderIds.has(target.id)
  return false
}

export function archiveFormatForFile(file: Pick<FileMeta, 'displayName' | 'ext'>): string | null {
  const filename = `${file.displayName}.${file.ext}`.toLowerCase().replace(/\.+$/, '')
  if (filename.endsWith('.tar.gz')) return 'tar.gz'
  if (filename.endsWith('.tgz')) return 'tgz'
  if (filename.endsWith('.tar')) return 'tar'
  if (filename.endsWith('.zip')) return 'zip'
  return null
}

export function archiveNameForFile(file: Pick<FileMeta, 'displayName' | 'ext'>): string {
  const fullName = file.ext ? `${file.displayName}.${file.ext}` : file.displayName
  return fullName.replace(/\.[^.]+$/, '') || file.displayName
}

export function extractFolderNameForArchive(file: Pick<FileMeta, 'displayName' | 'ext'>): string {
  const fullName = file.ext ? `${file.displayName}.${file.ext}` : file.displayName
  const suffix = ['.tar.gz', '.tgz', '.tar', '.zip'].find(value => fullName.toLowerCase().endsWith(value))
  return suffix ? fullName.slice(0, -suffix.length) : archiveNameForFile(file)
}
