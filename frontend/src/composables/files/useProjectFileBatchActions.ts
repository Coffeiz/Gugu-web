import { ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useClipboardStore } from '@/stores/clipboard'
import type { useFileActions } from './useFileActions'

export interface ProjectFileBatchActionOptions {
  fileActions: ReturnType<typeof useFileActions>
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  clipboardStore: ReturnType<typeof useClipboardStore>
  selectedFileIds: Ref<Set<number>>
  selectedFolderIds: Ref<Set<number>>
  getFiles: () => FileMeta[]
  getFolders: () => FolderMeta[]
  getCurrentFolderName: () => string | null
  getProjectName: () => string
  clearSelection: () => void
  pruneFolderHistory: (ids: number[]) => void
}

/** 项目文件区的批量副作用；选择状态本身由 useProjectFileSelection 管理。 */
export function useProjectFileBatchActions(options: ProjectFileBatchActionOptions) {
  const downloading = ref(false)

  async function downloadSelected() {
    if (downloading.value) return
    const fileIds = [...options.selectedFileIds.value]
    const folderIds = [...options.selectedFolderIds.value]
    if (!fileIds.length && !folderIds.length) return

    downloading.value = true
    try {
      if (fileIds.length === 1 && folderIds.length === 0) {
        const file = options.getFiles().find(item => item.id === fileIds[0])
        if (file) await options.fileActions.downloadFile(file)
        return
      }
      if (folderIds.length === 1 && fileIds.length === 0) {
        const folder = options.getFolders().find(item => item.id === folderIds[0])
        if (folder) await options.fileActions.downloadFolder(folder)
        return
      }
      const name = options.getCurrentFolderName() ?? options.getProjectName()
      await options.fileActions.batchDownload(fileIds, folderIds, `${name}.zip`)
    } catch (error) {
      console.error('[ProjectModal] 批量下载失败:', error instanceof Error ? error.message : String(error))
    } finally {
      downloading.value = false
    }
  }

  async function deleteSelected() {
    const visibleFileIds = new Set(options.getFiles().map(file => file.id))
    const visibleFolderIds = new Set(options.getFolders().map(folder => folder.id))
    const fileIds = [...options.selectedFileIds.value].filter(id => visibleFileIds.has(id))
    const folderIds = [...options.selectedFolderIds.value].filter(id => visibleFolderIds.has(id))
    if (!fileIds.length && !folderIds.length) return

    options.clearSelection()
    try {
      await Promise.all([
        ...fileIds.map(id => options.fileActions.deleteFile(id)),
        ...folderIds.map(id => options.fileActions.deleteFolder(id)),
      ])
      options.fileCacheStore.removeFiles(fileIds)
      folderIds.forEach(id => {
        options.fileCacheStore.removeFolder(id)
        options.pruneFolderHistory([id])
      })
      await options.fileCacheStore.refresh()
    } catch (error) {
      console.error('[ProjectModal] 批量删除失败:', error instanceof Error ? error.message : String(error))
    }
  }

  function cutSelected() {
    const visibleFileIds = new Set(options.getFiles().map(file => file.id))
    const visibleFolderIds = new Set(options.getFolders().map(folder => folder.id))
    options.clipboardStore.cut(
      [...options.selectedFileIds.value].filter(id => visibleFileIds.has(id)),
      [...options.selectedFolderIds.value].filter(id => visibleFolderIds.has(id)),
    )
    options.clearSelection()
  }

  function copySelected() {
    const visibleFileIds = new Set(options.getFiles().map(file => file.id))
    const visibleFolderIds = new Set(options.getFolders().map(folder => folder.id))
    options.clipboardStore.copy(
      [...new Set(options.selectedFileIds.value)].filter(id => visibleFileIds.has(id)),
      [...new Set(options.selectedFolderIds.value)].filter(id => visibleFolderIds.has(id)),
    )
    options.clearSelection()
  }

  return { downloading, downloadSelected, deleteSelected, cutSelected, copySelected }
}
