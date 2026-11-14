import { ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { useClipboardStore } from '@/stores/clipboard'
import type { useFileActions } from './useFileActions'

export interface VisibleBatchSelection<FolderKey = number> {
  fileIds: number[]
  folderKeys: FolderKey[]
  folderIds: number[]
  folders: FileBatchFolder[]
}

export interface FileBatchFolder {
  id: number | string
  name?: string
  displayName?: string
  folderId?: number
}

export interface FileBatchCoreOptions<FolderKey = number> {
  fileActions: ReturnType<typeof useFileActions>
  clipboardStore: ReturnType<typeof useClipboardStore>
  selectedFileIds: Ref<Set<number>>
  selectedFolderKeys: Ref<Set<FolderKey>>
  getFiles: () => FileMeta[]
  getFolders: () => FileBatchFolder[]
  resolveFolderSelection: (keys: FolderKey[], folders: FileBatchFolder[]) => { ids: number[]; folders: FileBatchFolder[] }
  getCurrentFolderName: () => string | null | undefined
  getArchiveName?: () => string
  getFolderDownloadTarget?: (folder: FileBatchFolder) => FolderMeta | { folderId?: number; displayName: string }
  clearSelection: () => void
  logLabel: string
}

/** 只收集当前视图中仍可见的选择，避免批量操作使用已经离开目录的 ID。 */
export function resolveVisibleBatchSelection<FolderKey>(options: Pick<
  FileBatchCoreOptions<FolderKey>,
  'selectedFileIds' | 'selectedFolderKeys' | 'getFiles' | 'getFolders' | 'resolveFolderSelection'
>): VisibleBatchSelection<FolderKey> {
  const visibleFiles = new Set(options.getFiles().map(file => file.id))
  const visibleFolders = options.getFolders()
  const visibleFolderKeys = new Set(visibleFolders.map(folder => folder.id as FolderKey))
  const fileIds = [...options.selectedFileIds.value].filter(id => visibleFiles.has(id))
  const folderKeys = [...options.selectedFolderKeys.value].filter(key => visibleFolderKeys.has(key))
  const resolved = options.resolveFolderSelection(folderKeys, visibleFolders)
  return { fileIds, folderKeys, folderIds: resolved.ids, folders: resolved.folders }
}

/** 文件库与项目文件区共用的下载、剪切和复制命令；删除/粘贴的缓存策略留给适配层。 */
export function useFileBatchCore<FolderKey = number>(options: FileBatchCoreOptions<FolderKey>) {
  const downloading = ref(false)

  async function downloadSelected() {
    if (downloading.value) return
    const selection = resolveVisibleBatchSelection(options)
    if (!selection.fileIds.length && !selection.folderIds.length) return
    downloading.value = true
    try {
      if (selection.fileIds.length === 1 && selection.folderIds.length === 0) {
        const file = options.getFiles().find(item => item.id === selection.fileIds[0])
        if (file) await options.fileActions.downloadFile(file)
        return
      }
      if (selection.folderIds.length === 1 && selection.fileIds.length === 0) {
        const folder = selection.folders[0]
        if (folder) {
          const target = options.getFolderDownloadTarget?.(folder) ?? {
            folderId: typeof folder.id === 'number' ? folder.id : undefined,
            displayName: folder.displayName ?? folder.name ?? '文件夹',
          }
          await options.fileActions.downloadFolder(target)
        }
        return
      }
      const name = options.getCurrentFolderName() ?? options.getArchiveName?.() ?? '文件'
      await options.fileActions.batchDownload(selection.fileIds, selection.folderIds, `${name}.zip`)
    } catch (error) {
      console.error(`${options.logLabel}批量下载失败:`, error instanceof Error ? error.message : String(error))
    } finally {
      downloading.value = false
    }
  }

  function updateClipboard(type: 'cut' | 'copy') {
    const selection = resolveVisibleBatchSelection(options)
    if (!selection.fileIds.length && !selection.folderIds.length) return
    options.clipboardStore[type](selection.fileIds, selection.folderIds)
    options.clearSelection()
  }

  return {
    downloading,
    downloadSelected,
    cutSelected: () => updateClipboard('cut'),
    copySelected: () => updateClipboard('copy'),
    resolveSelection: () => resolveVisibleBatchSelection(options),
  }
}
