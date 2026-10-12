import { computed, ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFolderNavigation } from '@/composables/files/useFolderNavigation'

interface ProjectFileCache {
  getProjectRootFolders(projectId: number, sortBy?: string, sortOrder?: 'asc' | 'desc'): FolderMeta[]
  getSubFolders(parentId: number, sortBy?: string, sortOrder?: 'asc' | 'desc'): FolderMeta[]
  getProjectRootFiles(projectId: number, sortBy?: string, sortOrder?: 'asc' | 'desc'): FileMeta[]
  getFolderFiles(folderId: number, sortBy?: string, sortOrder?: 'asc' | 'desc'): FileMeta[]
  getFolder(folderId: number): FolderMeta | null
}

/**
 * 项目编辑卡的文件工作区状态边界。
 *
 * 这里只负责目录导航、当前层派生数据和视图状态；文件增删改、选择、拖拽
 * 和上传仍由 ProjectModal 编排，避免在拆分过程中改变现有副作用顺序。
 */
export function useProjectFileWorkspace(options: {
  projectId: () => number | null | undefined
  fileCacheStore: ProjectFileCache
  isDirectoryLoaded: (projectId: number, folderId: number) => boolean
  sortBy?: () => string
  sortOrder?: () => 'asc' | 'desc'
}) {
  const { projectId, fileCacheStore, isDirectoryLoaded } = options
  const sortBy = () => options.sortBy?.() ?? 'createdAt'
  const sortOrder = () => options.sortOrder?.() ?? 'desc'
  const fileViewMode = ref<'grid' | 'list'>('grid')
  const openFolders = ref(new Set<number>())
  const {
    folderStack,
    canGoBack: pmCanGoBack,
    canGoForward: pmCanGoForward,
    enterFolder: pmEnterFolder,
    navigateTo: pmNavigateTo,
    goBack: pmGoBack,
    goForward: pmGoForward,
    pruneHistoryForFolders: prunePmHistoryForFolder,
    reset: resetPmNavigation,
  } = useFolderNavigation()

  const currentFolders = computed(() => {
    const pid = projectId() ?? -1
    if (!folderStack.value.length) return fileCacheStore.getProjectRootFolders(pid, sortBy(), sortOrder())
    const parentId = folderStack.value[folderStack.value.length - 1].id
    return fileCacheStore.getSubFolders(parentId, sortBy(), sortOrder())
  })

  const currentFiles = computed(() => {
    const pid = projectId() ?? -1
    if (!folderStack.value.length) return fileCacheStore.getProjectRootFiles(pid, sortBy(), sortOrder())
    const folderId = folderStack.value[folderStack.value.length - 1].id
    return fileCacheStore.getFolderFiles(folderId, sortBy(), sortOrder())
  })

  const currentFolder = computed(() =>
    folderStack.value.length ? folderStack.value[folderStack.value.length - 1] : null)
  const currentFolderFiles = computed(() => currentFiles.value)

  function pmFolderCount(folderId: number) {
    const pid = projectId() ?? -1
    if (isDirectoryLoaded(pid, folderId)) return fileCacheStore.getFolderFiles(folderId).length
    return fileCacheStore.getFolder(folderId)?.fileCount ?? fileCacheStore.getFolderFiles(folderId).length
  }

  return {
    fileViewMode,
    openFolders,
    folderStack,
    pmCanGoBack,
    pmCanGoForward,
    pmEnterFolder,
    pmNavigateTo,
    pmGoBack,
    pmGoForward,
    prunePmHistoryForFolder,
    resetPmNavigation,
    currentFolders,
    currentFiles,
    currentFolder,
    currentFolderFiles,
    pmFolderCount,
  }
}
