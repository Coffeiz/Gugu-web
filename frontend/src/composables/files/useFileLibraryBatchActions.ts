import { type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useClipboardStore } from '@/stores/clipboard'
import { useFilesCacheStore } from '@/stores/filesCache'
import { resolveFolderIds } from '@/utils/folderKeys'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import type { useFileActions } from './useFileActions'
import { useFileBatchCore } from './useFileBatchCore'
import { useFilePasteCore } from './useFilePasteCore'
import type { ConflictDecision, ConflictItem } from '@/components/common/overlays/UploadConflictDialog.vue'
import { clearThumbCache } from '@/composables/shared/useThumbCache'
import { confirmFileDeletion } from './useFileDeleteConfirm'

export interface FileLibraryBatchActionOptions {
  fileActions: ReturnType<typeof useFileActions>
  cacheStore: ReturnType<typeof useFilesCacheStore>
  clipboardStore: ReturnType<typeof useClipboardStore>
  selectedFileIds: Ref<Set<number>>
  selectedFolderKeys: Ref<Set<string | number>>
  getFiles: () => FileMeta[]
  getFolders: () => FileLibraryFolder[]
  getCurrentFolderName: () => string | null | undefined
  clearSelection: () => void
  loadContents: () => void
  pruneHistoryForFolders: (ids: number[]) => void
  fetchStorage: () => void | Promise<void>
  getDestination: () => { folderId: number | null; projectId: number | null }
  showConflicts?: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>
}

type FileLibraryFolder = {
  id: string | number
  folderId?: number
  displayName?: string
  name?: string
}

/** 文件库普通目录的批量副作用；回收站恢复/永久删除仍由页面单独编排。 */
export function useFileLibraryBatchActions(options: FileLibraryBatchActionOptions) {
  const core = useFileBatchCore({
    fileActions: options.fileActions,
    clipboardStore: options.clipboardStore,
    selectedFileIds: options.selectedFileIds,
    selectedFolderKeys: options.selectedFolderKeys,
    getFiles: options.getFiles,
    getFolders: options.getFolders,
    resolveFolderSelection: (keys, folders) => {
      const selected = folders.filter(folder => keys.includes(folder.id))
      return { ids: resolveFolderIds(selected.map(folder => folder.id), selected), folders: selected.filter(folder => folder.folderId != null) }
    },
    getCurrentFolderName: options.getCurrentFolderName,
    getArchiveName: () => '文件',
    getFolderDownloadTarget: folder => ({
      folderId: folder.folderId,
      displayName: folder.displayName ?? folder.name ?? '文件夹',
    }),
    clearSelection: options.clearSelection,
    logLabel: '[Files] ',
  })

  async function deleteSelected() {
    const { fileIds, folderIds } = core.resolveSelection()
    if (!fileIds.length && !folderIds.length) return
    if (!await confirmFileDeletion('selected', { count: fileIds.length + folderIds.length })) return

    const fileBackups = fileIds.map(id => options.cacheStore.getFile(id)).filter((file): file is FileMeta => file != null)
    const folderBackups = folderIds.map(id => options.cacheStore.getFolder(id)).filter((folder): folder is FolderMeta => folder != null)
    try {
      await InteractionSync.execute({
        scope: 'file.batch-delete', entityKey: `file-batch-delete:${fileIds.join(',')}:${folderIds.join(',')}`,
        apply: () => {
          options.clearSelection()
          options.cacheStore.removeFiles(fileIds)
          options.pruneHistoryForFolders(folderIds)
          folderIds.forEach(id => options.cacheStore.removeFolder(id))
          options.loadContents()
        },
        rollback: () => {
          fileBackups.forEach(file => options.cacheStore.addFile(file))
          folderBackups.forEach(folder => options.cacheStore.addFolder(folder))
          options.loadContents()
        },
        request: async mutation => {
          await Promise.all([
            fileIds.length ? options.fileActions.batchDelete(fileIds, { mutationId: mutation.mutationId }) : Promise.resolve(),
            ...folderIds.map(id => options.fileActions.deleteFolder(id, { mutationId: mutation.mutationId })),
          ])
          return null
        },
        onCommit: options.fetchStorage,
        onError: error => console.error('[Files] 批量删除失败:', error instanceof Error ? error.message : String(error)),
      })
    } catch { /* 错误已回滚并记录 */ }
  }

  const pasteCore = useFilePasteCore({
    clipboardStore: options.clipboardStore,
    getDestination: options.getDestination,
    showConflicts: options.showConflicts,
    onCut: async (fileIds, folderIds, destination) => {
      const fileBackups = fileIds.map(id => options.cacheStore.getFile(id)).filter((file): file is FileMeta => file != null)
      const folderBackups = folderIds.map(id => options.cacheStore.getFolder(id)).filter((folder): folder is FolderMeta => folder != null)
      let movedFolders: FolderMeta[] = []
      await InteractionSync.execute({
        scope: 'file.move-paste', entityKey: `file-paste:${fileIds.join(',')}:${folderIds.join(',')}`,
        apply: () => {
          fileIds.forEach(id => options.cacheStore.updateFile(id, { folderId: destination.folderId, projectId: destination.projectId }))
          folderIds.forEach(id => options.cacheStore.updateFolder(id, { parentId: destination.folderId, projectId: destination.projectId }))
          options.clipboardStore.clear()
        },
        afterMutate: options.loadContents,
        request: async mutation => {
          await Promise.all([
            Promise.all(fileBackups.map(file => options.fileActions.moveFile(file.id, destination.folderId, destination.projectId, { mutationId: mutation.mutationId }))),
            Promise.all(folderIds.map(id => options.fileActions.moveFolder(
              id, destination.folderId, folderBackups.find(folder => folder.id === id)?.version ?? 1, destination.projectId,
              { mutationId: mutation.mutationId },
            ))).then(result => { movedFolders = result }),
          ])
          return null
        },
        rollback: () => {
          fileBackups.forEach(file => options.cacheStore.updateFile(file.id, { folderId: file.folderId, projectId: file.projectId }))
          folderBackups.forEach(folder => options.cacheStore.updateFolder(folder.id, { parentId: folder.parentId, projectId: folder.projectId }))
        },
        onCommit: () => movedFolders.forEach(folder => options.cacheStore.updateFolder(folder.id, { version: folder.version })),
        onError: error => console.error('[Files] 粘贴失败:', error),
      })
    },
    getCopyConflicts: fileIds => {
      const destinationFiles = options.getFiles()
      return fileIds.map(id => options.cacheStore.getFile(id)).filter((source): source is FileMeta => source != null)
        .map(source => {
          const existing = destinationFiles.find(target => target.displayName === source.displayName && target.ext === source.ext)
          return existing ? { filename: `${source.displayName}.${source.ext}`, existingFile: { id: existing.id } } : null
        }).filter(item => item != null) as ConflictItem[]
    },
    onCopy: async (fileIds, folderIds, destination, decisions) => {
      const copyIds = fileIds.filter(id => {
        const source = options.cacheStore.getFile(id)
        const name = source ? `${source.displayName}.${source.ext}` : String(id)
        return decisions?.get(name)?.action !== 'skip'
      })
      const created = await Promise.all(copyIds.map(id => {
        const source = options.cacheStore.getFile(id)
        const name = source ? `${source.displayName}.${source.ext}` : String(id)
        const decision = decisions?.get(name)
        const target = decision?.existingFileId
        return options.fileActions.copyFile(id, destination.folderId, destination.projectId,
          decision?.action === 'overwrite' ? { onConflict: 'overwrite', overwriteFileId: target } : undefined)
      }))
      created.forEach((file, index) => {
        const sourceId = copyIds[index]
        const source = options.cacheStore.getFile(sourceId)
        const name = source ? `${source.displayName}.${source.ext}` : String(sourceId)
        const decision = decisions?.get(name)
        if (decision?.action === 'overwrite' && decision.existingFileId != null) {
          clearThumbCache(decision.existingFileId)
          options.cacheStore.updateFile(decision.existingFileId, { ...file, thumbRevision: Date.now() })
        } else options.cacheStore.addFile(file)
      })
      const copiedFolders = await Promise.all(folderIds.map(id => options.fileActions.copyFolder(id, destination.folderId, destination.projectId)))
      copiedFolders.forEach(folder => options.cacheStore.addFolder({
        id: folder.id, projectId: folder.projectId, parentId: folder.parentId, name: folder.name, fileCount: 0, version: folder.version,
      }))
      options.loadContents()
      await options.fetchStorage()
    },
    onError: error => console.error('[Files] 粘贴失败:', error instanceof Error ? error.message : String(error)),
  })

  return {
    downloading: core.downloading,
    downloadSelected: core.downloadSelected,
    deleteSelected,
    cutSelected: core.cutSelected,
    copySelected: core.copySelected,
    paste: pasteCore.paste,
  }
}
