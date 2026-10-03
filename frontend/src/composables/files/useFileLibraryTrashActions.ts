import { ref, type Ref } from 'vue'
import { trashApi, type TrashFolderContents, type TrashFolderMeta } from '@/services/api'
import type { FileMeta } from '@/stores/filesCache'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'
import { confirmFileDeletion } from './useFileDeleteConfirm'

interface TrashApi {
  list: () => Promise<FileMeta[]>
  listFolders: () => Promise<TrashFolderMeta[]>
  restore: (id: number) => Promise<unknown>
  restoreFolder: (id: number) => Promise<unknown>
  hardDelete: (id: number) => Promise<unknown>
  hardDeleteFolder: (id: number) => Promise<unknown>
  listFolderContents: (id: number) => Promise<TrashFolderContents>
}

export interface EmptyTrashProgress {
  done: number
  total: number
  failed: number
}

export interface FileLibraryTrashActionOptions {
  api?: TrashApi
  selectedFileIds: Ref<Set<number>>
  selectedTrashFolderIds: Ref<Set<number>>
  expandedTrashFolders: Ref<Set<number>>
  trashFolderContents: Ref<Record<number, TrashFolderContents>>
  loadContents: () => void
  clearSelection: () => void
  refreshCache: () => void | Promise<void>
  fetchStorage: () => void | Promise<void>
}

/** 回收站动作协调器；普通目录的删除、复制和粘贴不在这里处理。 */
export function useFileLibraryTrashActions(options: FileLibraryTrashActionOptions) {
  const api = options.api ?? trashApi
  const emptyTrashBusy = ref(false)
  const emptyTrashProgress = ref<EmptyTrashProgress | null>(null)

  async function restoreFile(file: FileMeta) {
    try {
      await api.restore(file.id)
      options.loadContents()
      await options.refreshCache()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 恢复失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function restoreFolder(folder: TrashFolderMeta) {
    try {
      await api.restoreFolder(folder.id)
      options.loadContents()
      await options.refreshCache()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 恢复文件夹失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function toggleFolder(folder: TrashFolderMeta) {
    const next = new Set(options.expandedTrashFolders.value)
    if (next.has(folder.id)) {
      next.delete(folder.id)
      options.expandedTrashFolders.value = next
      return
    }
    if (!options.trashFolderContents.value[folder.id]) {
      try {
        options.trashFolderContents.value = {
          ...options.trashFolderContents.value,
          [folder.id]: await api.listFolderContents(folder.id),
        }
      } catch (error) {
        console.error('[Files] 加载回收站文件夹内容失败:', error instanceof Error ? error.message : String(error))
        return
      }
    }
    next.add(folder.id)
    options.expandedTrashFolders.value = next
  }

  async function hardDeleteFile(file: FileMeta) {
    if (!await confirmFileDeletion('permanent-file', { name: file.displayName })) return
    try {
      await api.hardDelete(file.id)
      options.loadContents()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 永久删除失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function hardDeleteFolder(folder: TrashFolderMeta) {
    if (!await confirmFileDeletion('permanent-folder', { name: folder.name })) return
    try {
      await api.hardDeleteFolder(folder.id)
      options.loadContents()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 永久删除文件夹失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function restoreSelected() {
    const fileIds = [...options.selectedFileIds.value]
    const folderIds = [...options.selectedTrashFolderIds.value]
    if (!fileIds.length && !folderIds.length) return
    if (!await confirmFileDeletion('permanent-selected', { count: fileIds.length + folderIds.length })) return
    try {
      await Promise.all([
        ...fileIds.map(id => api.restore(id)),
        ...folderIds.map(id => api.restoreFolder(id)),
      ])
      options.clearSelection()
      options.loadContents()
      await options.refreshCache()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 批量恢复失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function hardDeleteSelected() {
    const fileIds = [...options.selectedFileIds.value]
    const folderIds = [...options.selectedTrashFolderIds.value]
    if (!fileIds.length && !folderIds.length) return
    try {
      await Promise.all([
        ...fileIds.map(id => api.hardDelete(id)),
        ...folderIds.map(id => api.hardDeleteFolder(id)),
      ])
      options.clearSelection()
      options.loadContents()
      await options.fetchStorage()
    } catch (error) {
      console.error('[Files] 批量永久删除失败:', error instanceof Error ? error.message : String(error))
    }
  }

  async function emptyTrash() {
    if (!await confirmDialog({
      title: i18n.global.t('filesViewUi.emptyTrashTitle'),
      message: i18n.global.t('filesViewUi.emptyTrashMessage'),
      tone: 'danger',
      confirmText: i18n.global.t('filesViewUi.permanentDelete'),
    })) return
    emptyTrashBusy.value = true
    emptyTrashProgress.value = null
    try {
      const [files, folders] = await Promise.all([api.list(), api.listFolders()])
      const tasks = [
        ...files.map(file => () => api.hardDelete(file.id)),
        ...folders.map(folder => () => api.hardDeleteFolder(folder.id)),
      ]
      const total = tasks.length
      let done = 0
      let failed = 0
      emptyTrashProgress.value = { done, total, failed }

      let next = 0
      const workerCount = Math.min(4, total)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < total) {
          const task = tasks[next++]
          try {
            await task()
          } catch {
            failed += 1
          } finally {
            done += 1
            emptyTrashProgress.value = { done, total, failed }
          }
        }
      }))

      const [remainingFiles, remainingFolders] = await Promise.all([api.list(), api.listFolders()])
      failed = remainingFiles.length + remainingFolders.length
      emptyTrashProgress.value = { done, total, failed }
      options.loadContents()
      await Promise.all([options.refreshCache(), options.fetchStorage()])
      if (failed > 0) {
        showAppError(i18n.global.t('filesViewUi.emptyTrashPartial', { failed }))
      } else if (total > 0) {
        showAppSuccess(i18n.global.t('filesViewUi.emptyTrashComplete', { count: total }))
      }
    } catch (error) {
      console.error('[Files] 清空回收站失败:', error instanceof Error ? error.message : String(error))
      showAppError(i18n.global.t('filesViewUi.emptyTrashFailed'))
    } finally {
      emptyTrashBusy.value = false
      emptyTrashProgress.value = null
    }
  }

  return {
    restoreFile, restoreFolder, toggleFolder, hardDeleteFile, hardDeleteFolder,
    restoreSelected, hardDeleteSelected, emptyTrash, emptyTrashBusy, emptyTrashProgress,
  }
}
