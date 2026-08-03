import { ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useClipboardStore } from '@/stores/clipboard'
import { useFilesCacheStore } from '@/stores/filesCache'
import { resolveFolderIds } from '@/utils/folderKeys'
import { optimisticMutation } from '@/utils/optimisticMutation'
import type { useFileActions } from './useFileActions'

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
}

type FileLibraryFolder = {
  id: string | number
  folderId?: number
  displayName?: string
  name?: string
}

/** 文件库普通目录的批量副作用；回收站恢复/永久删除仍由页面单独编排。 */
export function useFileLibraryBatchActions(options: FileLibraryBatchActionOptions) {
  const downloading = ref(false)

  async function downloadSelected() {
    if (downloading.value) return
    const fileIds = [...options.selectedFileIds.value]
    const folders = options.getFolders().filter(folder => options.selectedFolderKeys.value.has(folder.id) && folder.folderId != null)
    const folderIds = folders.map(folder => folder.folderId as number)
    if (!fileIds.length && !folderIds.length) return

    downloading.value = true
    try {
      if (fileIds.length === 1 && folderIds.length === 0) {
        const file = options.getFiles().find(item => item.id === fileIds[0])
        if (file) await options.fileActions.downloadFile(file)
        return
      }
      if (folderIds.length === 1 && fileIds.length === 0) {
        await options.fileActions.downloadFolder({ folderId: folderIds[0], displayName: folders[0].displayName ?? folders[0].name ?? '文件夹' })
        return
      }
      const name = options.getCurrentFolderName() ?? '文件'
      await options.fileActions.batchDownload(fileIds, folderIds, `${name}.zip`)
    } catch (error) {
      console.error('[Files] 批量下载失败:', error instanceof Error ? error.message : String(error))
    } finally {
      downloading.value = false
    }
  }

  async function deleteSelected() {
    const visibleFileIds = new Set(options.getFiles().map(file => file.id))
    const visibleFolders = options.getFolders()
    const visibleFolderKeys = new Set(visibleFolders.map(folder => folder.id))
    const fileIds = [...options.selectedFileIds.value].filter(id => visibleFileIds.has(id))
    const folderKeys = [...options.selectedFolderKeys.value].filter(key => visibleFolderKeys.has(key))
    const folderIds = resolveFolderIds(folderKeys, visibleFolders)
    if (!fileIds.length && !folderIds.length) return

    const fileBackups = fileIds.map(id => options.cacheStore.getFile(id)).filter((file): file is FileMeta => file != null)
    options.clearSelection()
    options.cacheStore.removeFiles(fileIds)
    options.pruneHistoryForFolders(folderIds)
    folderIds.forEach(id => options.cacheStore.removeFolder(id))
    options.loadContents()

    try {
      await Promise.all([
        fileIds.length ? options.fileActions.batchDelete(fileIds) : Promise.resolve(),
        ...folderIds.map(id => options.fileActions.deleteFolder(id)),
      ])
      await options.fetchStorage()
    } catch (error) {
      fileBackups.forEach(file => options.cacheStore.addFile(file))
      options.loadContents()
      console.error('[Files] 批量删除失败:', error instanceof Error ? error.message : String(error))
    }
  }

  function cutSelected() {
    const visibleFiles = new Set(options.getFiles().map(file => file.id))
    const visibleFolders = options.getFolders()
    const visibleFolderKeys = new Set(visibleFolders.map(folder => folder.id))
    const folderIds = resolveFolderIds(
      [...options.selectedFolderKeys.value].filter(key => visibleFolderKeys.has(key)),
      visibleFolders,
    )
    const fileIds = [...options.selectedFileIds.value].filter(id => visibleFiles.has(id))
    if (!fileIds.length && !folderIds.length) return
    options.clipboardStore.cut(fileIds, folderIds)
    options.clearSelection()
  }

  function copySelected() {
    const visibleFiles = new Set(options.getFiles().map(file => file.id))
    const visibleFolders = options.getFolders()
    const visibleFolderKeys = new Set(visibleFolders.map(folder => folder.id))
    const folderIds = resolveFolderIds(
      [...options.selectedFolderKeys.value].filter(key => visibleFolderKeys.has(key)),
      visibleFolders,
    )
    const fileIds = [...options.selectedFileIds.value].filter(id => visibleFiles.has(id))
    if (!fileIds.length && !folderIds.length) return
    options.clipboardStore.copy(fileIds, folderIds)
    options.clearSelection()
  }

  const pasteBusy = ref(false)
  async function paste() {
    if (pasteBusy.value || !options.clipboardStore.hasContent()) return
    pasteBusy.value = true
    const { folderId, projectId } = options.getDestination()
    try {
      if (options.clipboardStore.type === 'cut') {
        const fileIds = [...options.clipboardStore.fileIds]
        const folderIds = [...options.clipboardStore.folderIds]
        const fileBackups = fileIds.map(id => options.cacheStore.getFile(id)).filter((file): file is FileMeta => file != null)
        const folderBackups = folderIds.map(id => options.cacheStore.getFolder(id)).filter((folder): folder is FolderMeta => folder != null)
        let movedFolders: FolderMeta[] = []
        await optimisticMutation({
          apply: () => {
            fileIds.forEach(id => options.cacheStore.updateFile(id, { folderId, projectId }))
            folderIds.forEach(id => options.cacheStore.updateFolder(id, { parentId: folderId, projectId }))
            options.clipboardStore.clear()
          },
          afterMutate: options.loadContents,
          work: async () => {
            await Promise.all([
              Promise.all(fileBackups.map(file => options.fileActions.moveFile(file.id, folderId, projectId))),
              Promise.all(folderIds.map(id => options.fileActions.moveFolder(
                id,
                folderId,
                folderBackups.find(folder => folder.id === id)?.version ?? 1,
                projectId,
              ))).then(result => { movedFolders = result }),
            ])
          },
          rollback: () => {
            fileBackups.forEach(file => options.cacheStore.updateFile(file.id, { folderId: file.folderId, projectId: file.projectId }))
            folderBackups.forEach(folder => options.cacheStore.updateFolder(folder.id, { parentId: folder.parentId, projectId: folder.projectId }))
          },
          onCommit: () => movedFolders.forEach(folder => options.cacheStore.updateFolder(folder.id, { version: folder.version })),
          onError: error => console.error('[Files] 粘贴失败:', error),
        })
      } else {
        const created = await Promise.all(options.clipboardStore.fileIds.map(id => options.fileActions.copyFile(id, folderId, projectId)))
        created.forEach(file => options.cacheStore.addFile(file))
        const copiedFolders = await Promise.all(options.clipboardStore.folderIds.map(id => options.fileActions.copyFolder(id, folderId, projectId)))
        copiedFolders.forEach(folder => options.cacheStore.addFolder({
          id: folder.id,
          projectId: folder.projectId,
          parentId: folder.parentId,
          name: folder.name,
          fileCount: 0,
          version: folder.version,
        }))
        options.loadContents()
        await options.fetchStorage()
      }
    } catch (error) {
      console.error('[Files] 粘贴失败:', error instanceof Error ? error.message : String(error))
    } finally {
      pasteBusy.value = false
    }
  }

  return { downloading, downloadSelected, deleteSelected, cutSelected, copySelected, paste }
}
