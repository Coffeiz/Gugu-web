import { type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useClipboardStore } from '@/stores/clipboard'
import type { useFileActions } from './useFileActions'
import { useFileBatchCore } from './useFileBatchCore'

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
  const core = useFileBatchCore({
    fileActions: options.fileActions,
    clipboardStore: options.clipboardStore,
    selectedFileIds: options.selectedFileIds,
    selectedFolderKeys: options.selectedFolderIds,
    getFiles: options.getFiles,
    getFolders: options.getFolders,
    resolveFolderSelection: (keys, folders) => ({
      ids: keys,
      folders: folders.filter(folder => keys.includes(folder.id as number)),
    }),
    getCurrentFolderName: options.getCurrentFolderName,
    getArchiveName: options.getProjectName,
    clearSelection: options.clearSelection,
    logLabel: '[ProjectModal] ',
  })

  async function deleteSelected() {
    const { fileIds, folderIds } = core.resolveSelection()
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

  return {
    downloading: core.downloading,
    downloadSelected: core.downloadSelected,
    deleteSelected,
    cutSelected: core.cutSelected,
    copySelected: core.copySelected,
  }
}
