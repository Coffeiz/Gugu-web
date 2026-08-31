import type { Ref } from 'vue'
import { useFileActions } from '@/composables/files/useFileActions'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from '@/stores/filesCache'
import { confirmFileDeletion } from './useFileDeleteConfirm'

type ProjectFileActions = ReturnType<typeof useFileActions>
type FilesCache = ReturnType<typeof useFilesCacheStore>

interface ProjectFileMutationsOptions {
  fileActions: ProjectFileActions
  fileCacheStore: FilesCache
  projectId: () => number | null
  parentFolderId: () => number | null
  pruneFolderHistory: (ids: number[]) => void
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 项目文件区的单项写操作；拖拽、选择和菜单编排继续由场景层负责。 */
export function useProjectFileMutations(options: ProjectFileMutationsOptions) {
  const { fileActions, fileCacheStore, projectId, parentFolderId, pruneFolderHistory } = options

  async function createFolder(name: string) {
    const trimmed = name.trim()
    const id = projectId()
    if (!trimmed || !id) return null
    const created = await fileActions.createFolder(id, trimmed, parentFolderId())
    fileCacheStore.addFolder(created)
    return created
  }

  async function renameFile(fileId: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const oldName = fileCacheStore.getFile(fileId)?.displayName
    fileCacheStore.updateFile(fileId, { displayName: trimmed })
    try {
      await fileActions.renameFile(fileId, trimmed)
    } catch (error) {
      if (oldName != null) fileCacheStore.updateFile(fileId, { displayName: oldName })
      throw error
    }
  }

  async function deleteFile(file: FileMeta) {
    if (!await confirmFileDeletion('file', { name: file.displayName })) return
    await fileActions.deleteFile(file.id)
    fileCacheStore.removeFile(file.id)
  }

  function downloadFile(file: FileMeta) {
    return fileActions.downloadFile(file)
  }

  async function renameFolder(folderId: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const oldFolder = fileCacheStore.getFolder(folderId)
    const oldName = oldFolder?.name
    const version = oldFolder?.version ?? 1
    fileCacheStore.updateFolder(folderId, { name: trimmed })
    try {
      const updated = await fileActions.renameFolder(folderId, trimmed, version)
      fileCacheStore.updateFolder(folderId, { version: updated.version })
    } catch (error) {
      if (oldName != null) fileCacheStore.updateFolder(folderId, { name: oldName })
      fileCacheStore.refresh()
      throw error
    }
  }

  function downloadFolder(folder: FolderMeta) {
    return fileActions.downloadFolder(folder)
  }

  async function deleteFolder(folder: FolderMeta) {
    if (!await confirmFileDeletion('folder', { name: folder.name })) return
    pruneFolderHistory([folder.id])
    await fileActions.deleteFolder(folder.id)
    fileCacheStore.removeFolder(folder.id)
  }

  return { createFolder, renameFile, deleteFile, downloadFile, renameFolder, downloadFolder, deleteFolder, errorMessage }
}
