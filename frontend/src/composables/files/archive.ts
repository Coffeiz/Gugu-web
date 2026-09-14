import type { FileMeta, FolderMeta } from '@/stores/filesCache'

export const ARCHIVE_ROOT_VALUE = '__root__'

export interface ArchiveScope {
  space: 'personal' | 'project' | 'workspace'
  projectId: number | null
  workspaceDirectoryId: number | null
}

export interface ArchiveFolderOption {
  value: string
  label: string
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

function belongsToScope(folder: FolderMeta, scope: ArchiveScope): boolean {
  if (scope.space === 'workspace') return folder.workspaceDirectoryId === scope.workspaceDirectoryId
  if (scope.space === 'project') return folder.projectId === scope.projectId && folder.workspaceDirectoryId == null
  return folder.projectId == null && folder.workspaceDirectoryId == null
}

export function archiveFolderOptions(
  folders: FolderMeta[],
  scope: ArchiveScope,
  rootLabel: string,
): ArchiveFolderOption[] {
  const scopedFolders = folders.filter(folder => belongsToScope(folder, scope))
  const byId = new Map(scopedFolders.map(folder => [folder.id, folder]))
  const labelFor = (folder: FolderMeta): string => {
    const path = [folder.name]
    let parentId = folder.parentId ?? null
    const seen = new Set([folder.id])
    while (parentId != null && byId.has(parentId) && !seen.has(parentId)) {
      const parent = byId.get(parentId)!
      seen.add(parent.id)
      path.push(parent.name)
      parentId = parent.parentId ?? null
    }
    return path.reverse().join(' / ')
  }

  return [
    { value: ARCHIVE_ROOT_VALUE, label: rootLabel },
    ...scopedFolders
      .map(folder => ({ value: String(folder.id), label: labelFor(folder) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
}

export function isExtractableArchive(file: Pick<FileMeta, 'displayName' | 'ext'>): boolean {
  return archiveFormatForFile(file) != null
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
