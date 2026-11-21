import { type Ref } from 'vue'
import { trashApi, type TrashFolderContentsPage, type TrashFolderContentsSnapshot, type TrashFolderMeta } from '@/services/api'
import type { FileMeta } from '@/stores/filesCache'
import { confirmFileDeletion } from './useFileDeleteConfirm'
import { useFileLibraryTrashPurge, type TrashPurgeApi } from './useFileLibraryTrashPurge'

export type { EmptyTrashProgress } from './useFileLibraryTrashPurge'

interface TrashApi extends TrashPurgeApi {
  restore: (id: number) => Promise<unknown>
  restoreFolder: (id: number) => Promise<unknown>
  hardDelete: (id: number) => Promise<unknown>
  hardDeleteFolder: (id: number) => Promise<unknown>
  folderContentsPage: (id: number, params?: { limit?: number; folderCursor?: string | null; fileCursor?: string | null }) => Promise<TrashFolderContentsPage>
}

export interface FileLibraryTrashActionOptions {
  api?: TrashApi
  selectedFileIds: Ref<Set<number>>
  selectedTrashFolderIds: Ref<Set<number>>
  expandedTrashFolders: Ref<Set<number>>
  trashFolderContents: Ref<Record<number, TrashFolderContentsSnapshot>>
  trashFolderCursors: Ref<Record<number, { folderCursor: string | null; fileCursor: string | null; folderHasMore: boolean; fileHasMore: boolean }>>
  loadContents: () => void
  clearSelection: () => void
  refreshCache: () => void | Promise<void | boolean>
  fetchStorage: () => void | Promise<void>
}

/** 回收站动作协调器；普通目录的删除、复制和粘贴不在这里处理。 */
export function useFileLibraryTrashActions(options: FileLibraryTrashActionOptions) {
  const api = options.api ?? trashApi
  const purge = useFileLibraryTrashPurge({
    api,
    loadContents: options.loadContents,
    refreshCache: options.refreshCache,
    fetchStorage: options.fetchStorage,
  })

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
          [folder.id]: await (async () => {
            const remaining = Math.max(0, 2000 - Object.values(options.trashFolderContents.value)
              .reduce((count, content) => count + content.folders.length + content.files.length, 0))
            if (remaining === 0) return { folders: [], files: [] }
            const page = await api.folderContentsPage(folder.id)
            const files = page.files.items.slice(0, remaining)
            const folders = page.folders.items.slice(0, Math.max(0, remaining - files.length))
            options.trashFolderCursors.value = {
              ...options.trashFolderCursors.value,
              [folder.id]: {
                folderCursor: folders.length === page.folders.items.length ? page.folders.next_cursor : null,
                fileCursor: files.length === page.files.items.length ? page.files.next_cursor : null,
                folderHasMore: folders.length === page.folders.items.length && page.folders.has_more,
                fileHasMore: files.length === page.files.items.length && page.files.has_more,
              },
            }
            return { folders, files }
          })(),
        }
      } catch (error) {
        console.error('[Files] 加载回收站文件夹内容失败:', error instanceof Error ? error.message : String(error))
        return
      }
    }
    next.add(folder.id)
    options.expandedTrashFolders.value = next
  }

  async function loadMoreFolderContents(folderId: number) {
    const cursor = options.trashFolderCursors.value[folderId]
    if (!cursor || (!cursor.folderHasMore && !cursor.fileHasMore)) return
    const previous = options.trashFolderContents.value[folderId]
    if (!previous) return
    const loaded = Object.values(options.trashFolderContents.value)
      .reduce((count, content) => count + content.folders.length + content.files.length, 0)
    const remaining = Math.max(0, 2000 - loaded)
    if (remaining === 0) return
    try {
      const page = await api.folderContentsPage(folderId, cursor)
      const files = page.files.items.slice(0, remaining)
      const folders = page.folders.items.slice(0, Math.max(0, remaining - files.length))
      options.trashFolderContents.value = {
        ...options.trashFolderContents.value,
        [folderId]: {
          folders: [...previous.folders, ...folders],
          files: [...previous.files, ...files],
        },
      }
      options.trashFolderCursors.value = {
        ...options.trashFolderCursors.value,
        [folderId]: {
          folderCursor: folders.length === page.folders.items.length && page.folders.has_more ? page.folders.next_cursor : null,
          fileCursor: files.length === page.files.items.length && page.files.has_more ? page.files.next_cursor : null,
          folderHasMore: folders.length === page.folders.items.length && page.folders.has_more,
          fileHasMore: files.length === page.files.items.length && page.files.has_more,
        },
      }
    } catch (error) {
      console.error('[Files] 继续加载回收站文件夹失败:', error instanceof Error ? error.message : String(error))
    }
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

  const emptyTrash = purge.empty

  return {
    restoreFile, restoreFolder, toggleFolder, loadMoreFolderContents, hardDeleteFile, hardDeleteFolder,
    restoreSelected, hardDeleteSelected, emptyTrash,
    emptyTrashBusy: purge.busy, emptyTrashProgress: purge.progress,
  }
}
