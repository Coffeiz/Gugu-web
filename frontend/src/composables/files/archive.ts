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
