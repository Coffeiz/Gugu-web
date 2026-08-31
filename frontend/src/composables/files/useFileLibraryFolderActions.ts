import { ref, type Ref } from 'vue'
import type { FolderCard as FolderCardMeta, NavSeg } from '@/utils/filesNav'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useFileActions } from '@/composables/files/useFileActions'
import { confirmFileDeletion } from './useFileDeleteConfirm'

interface FolderActionsOptions {
  currentType: Readonly<Ref<string>>
  currentSeg: Readonly<Ref<NavSeg | null>>
  projectSeg: Readonly<Ref<NavSeg | null>>
  cacheStore: ReturnType<typeof useFilesCacheStore>
  fileActions: ReturnType<typeof useFileActions>
  loadContents: () => void
  fetchStorage: () => void | Promise<void>
  pruneHistoryForFolders: (folderIds: Array<number | string>) => void
}

/** 文件库文件夹创建、下载和删除的页面适配；缓存乐观更新仍由文件库注入。 */
export function useFileLibraryFolderActions(options: FolderActionsOptions) {
  const { currentType, currentSeg, projectSeg, cacheStore, fileActions, loadContents, fetchStorage, pruneHistoryForFolders } = options
  const newFolderName = ref('')
  const newFolderLoading = ref(false)
  const showNewFolderInput = ref(false)

  async function createFolder() {
    const name = newFolderName.value.trim()
    if (!name) return
    const type = currentType.value
    const seg = currentSeg.value
    const projectId = (type === 'project' || type === 'folder')
      ? (projectSeg.value?.id ?? seg?.projectId ?? null)
      : null
    const parentId = type === 'folder' ? (seg?.folderId ?? null) : null
    newFolderLoading.value = true
    const tempId = -Date.now()
    cacheStore.addFolder({ id: tempId, name, projectId, parentId, fileCount: 0 })
    newFolderName.value = ''
    showNewFolderInput.value = false
    loadContents()
    try {
      const real = await fileActions.createFolder(projectId, name, parentId)
      cacheStore.removeFolder(tempId)
      cacheStore.addFolder({ id: real.id, name: real.name, projectId: real.projectId ?? null, parentId: real.parentId ?? null, fileCount: 0 })
      loadContents()
    } catch (error) {
      cacheStore.removeFolder(tempId)
      loadContents()
      console.error('[Files] 新建文件夹失败:', (error as Error).message)
    } finally {
      newFolderLoading.value = false
    }
  }

  async function downloadFolder(folder: FolderCardMeta) {
    if (folder.folderId == null) return
    try {
      await fileActions.downloadFolder(folder)
    } catch (error) {
      console.error('[Files] 下载文件夹失败:', (error as Error).message)
    }
  }

  async function deleteFolder(folder: FolderCardMeta) {
    if (folder.folderId == null) return
    if (!await confirmFileDeletion('folder', { name: folder.displayName ?? '文件夹' })) return
    pruneHistoryForFolders([folder.folderId])
    cacheStore.removeFolder(folder.folderId)
    loadContents()
    try {
      await fileActions.deleteFolder(folder.folderId)
      await fetchStorage()
    } catch (error) {
      cacheStore.refresh().then(loadContents)
      console.error('[Files] 删除文件夹失败:', (error as Error).message)
    }
  }

  return { newFolderName, newFolderLoading, showNewFolderInput, createFolder, downloadFolder, deleteFolder }
}
