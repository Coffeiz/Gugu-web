import { nextTick, ref, watch, type Ref } from 'vue'
import { filesApi, foldersApi } from '@/services/api'
import type { DirectorySnapshotScope, FileMeta, FolderMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'

type FileCacheLike = {
  loaded: boolean
  replaceDirectorySnapshot: (scope: DirectorySnapshotScope, files: FileMeta[], folders: FolderMeta[]) => void
}

/** 项目切换时同步文件工作区导航与全局缓存，避免弹窗层重复维护生命周期细节。 */
export function useProjectFileProjectSync(options: {
  project: () => Project | null
  openFolders: Ref<Set<number>>
  folderStack: Ref<FolderMeta[]>
  resetNavigation: () => void
  showNewFolder: Ref<boolean>
  resetDraft: (project: Project | null) => void
  fileCacheStore: FileCacheLike
}) {
  const initializing = ref(false)
  const loadedDirectories = new Set<string>()
  const pendingDirectories = new Map<string, Promise<void>>()

  function ensureDirectoryLoaded(projectId: number, folderId: number | null = null): Promise<void> {
    if (options.fileCacheStore.loaded) return Promise.resolve()
    const key = `${projectId}:${folderId ?? 'root'}`
    if (loadedDirectories.has(key)) return Promise.resolve()
    const pending = pendingDirectories.get(key)
    if (pending) return pending

    const request = Promise.all([
      filesApi.list({ space: 'project', projectId, folderId: folderId ?? undefined }),
      foldersApi.list({ projectId, parentId: folderId ?? undefined }),
    ]).then(([files, folders]) => {
      if (options.project()?.id !== projectId) return
      options.fileCacheStore.replaceDirectorySnapshot(
        { space: 'project', projectId, ...(folderId != null ? { folderId } : {}) },
        files as FileMeta[], folders as FolderMeta[],
      )
      loadedDirectories.add(key)
    }).catch(() => {
      // 加载失败时不标记目录，重新进入时允许重试。
    }).finally(() => {
      pendingDirectories.delete(key)
    })

    pendingDirectories.set(key, request)
    return request
  }

  function isDirectoryLoaded(projectId: number, folderId: number | null): boolean {
    return options.fileCacheStore.loaded || loadedDirectories.has(`${projectId}:${folderId ?? 'root'}`)
  }

  function invalidateProjectDirectories(projectId: number): void {
    for (const key of loadedDirectories) if (key.startsWith(`${projectId}:`)) loadedDirectories.delete(key)
  }

  watch(() => options.project()?.id, async id => {
    initializing.value = true
    options.resetDraft(options.project())
    options.openFolders.value = new Set<number>()
    options.folderStack.value = []
    options.resetNavigation()
    options.showNewFolder.value = false
    await nextTick()
    initializing.value = false
    if (!id) {
      loadedDirectories.clear()
      return
    }
    for (const key of loadedDirectories) if (!key.startsWith(`${id}:`)) loadedDirectories.delete(key)
    void ensureDirectoryLoaded(id, null)
  }, { immediate: true })

  return { initializing, ensureDirectoryLoaded, isDirectoryLoaded, invalidateProjectDirectories }
}
