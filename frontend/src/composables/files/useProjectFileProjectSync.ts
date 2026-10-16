import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import { filesApi, foldersApi, type CursorPage } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { DirectoryPageState, DirectorySnapshotScope, FileMeta, FolderMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'

type FileCacheLike = {
  getDirectory: (scope: DirectorySnapshotScope) => DirectoryPageState | null
  setDirectoryPage: (scope: DirectorySnapshotScope, files: CursorPage<FileMeta>, folders: CursorPage<FolderMeta>, append?: boolean) => void
  invalidatePages: (scope?: DirectorySnapshotScope) => void
}

/** 项目切换时同步文件工作区导航与全局缓存，避免弹窗层重复维护生命周期细节。 */
export function useProjectFileProjectSync(options: {
  project: () => Project | null
  openFolders: Ref<Set<number>>
  folderStack: Ref<FolderMeta[]>
  resetNavigation: () => void
  showNewFolder: Ref<boolean>
  resetDraft: (project: Project | null) => void
  sortBy?: () => 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'
  sortOrder?: () => 'asc' | 'desc'
  fileCacheStore: FileCacheLike
}) {
  const initializing = ref(false)
  const loadedDirectories = new Set<string>()
  const directoryScopes = new Map<string, DirectorySnapshotScope>()
  const pendingDirectories = new Map<string, Promise<void>>()
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const loadingMore = ref(false)
  const limitedDirectories = ref(new Set<string>())
  const sortBy = () => options.sortBy?.() ?? 'createdAt'
  const sortOrder = () => options.sortOrder?.() ?? 'desc'
  const directoryKey = (projectId: number, folderId: number | null) =>
    `${projectId}:${folderId ?? 'root'}:${sortBy()}:${sortOrder()}`

  function ensureDirectoryLoaded(projectId: number, folderId: number | null = null): Promise<void> {
    const key = directoryKey(projectId, folderId)
    if (loadedDirectories.has(key)) return Promise.resolve()
    const scope: DirectorySnapshotScope = {
      space: 'project', projectId, ...(folderId != null ? { folderId } : {}),
      sortBy: sortBy(), sortOrder: sortOrder(),
    }
    if (options.fileCacheStore.getDirectory(scope)) {
      loadedDirectories.add(key)
      directoryScopes.set(key, scope)
      return Promise.resolve()
    }
    const pending = pendingDirectories.get(key)
    if (pending) return pending

    const request = Promise.all([
      filesApi.page({ space: 'project', projectId, folderId: folderId ?? undefined,
        sortBy: sortBy(), sortOrder: sortOrder() }),
      foldersApi.page({ projectId, parentId: folderId ?? undefined,
        sortBy: sortBy(), sortOrder: sortOrder() }),
    ]).then(([files, folders]) => {
      if (options.project()?.id !== projectId) return
      options.fileCacheStore.setDirectoryPage(
        scope,
        files as CursorPage<FileMeta>, folders as CursorPage<FolderMeta>,
      )
      loadedDirectories.add(key)
      directoryScopes.set(key, scope)
    }).catch(() => {
      // 加载失败时不标记目录，重新进入时允许重试。
    }).finally(() => {
      pendingDirectories.delete(key)
    })

    pendingDirectories.set(key, request)
    return request
  }

  async function loadMoreDirectory(): Promise<void> {
    const projectId = options.project()?.id
    if (projectId == null || loadingMore.value) return
    const folderId = options.folderStack.value.at(-1)?.id
    const scope: DirectorySnapshotScope = {
      space: 'project', projectId, ...(folderId != null ? { folderId } : {}),
      sortBy: sortBy(), sortOrder: sortOrder(),
    }
    const previous = options.fileCacheStore.getDirectory(scope)
    if (!previous || (!previous.fileHasMore && !previous.folderHasMore)) return
    const loadedCount = previous.files.length + previous.folders.length
    if (loadedCount >= 2000) {
      limitedDirectories.value.add(directoryKey(projectId, folderId ?? null))
      return
    }
    loadingMore.value = true
    try {
      const [files, folders] = await Promise.all([
        previous.fileHasMore ? filesApi.page({ space: 'project', projectId, folderId,
          cursor: previous.fileCursor, sortBy: sortBy(), sortOrder: sortOrder() })
          : Promise.resolve({ items: [], next_cursor: null, has_more: false } as CursorPage<FileMeta>),
        previous.folderHasMore ? foldersApi.page({ projectId, parentId: folderId,
          cursor: previous.folderCursor, sortBy: sortBy(), sortOrder: sortOrder() })
          : Promise.resolve({ items: [], next_cursor: null, has_more: false } as CursorPage<FolderMeta>),
      ])
      if (options.project()?.id !== projectId || options.folderStack.value.at(-1)?.id !== folderId) return
      const remaining = 2000 - loadedCount
      const acceptedFiles = files.items.slice(0, remaining)
      const acceptedFolders = folders.items.slice(0, Math.max(0, remaining - acceptedFiles.length))
      const boundedFiles = { ...files, items: acceptedFiles, has_more: files.has_more && acceptedFiles.length === files.items.length }
      const boundedFolders = { ...folders, items: acceptedFolders, has_more: folders.has_more && acceptedFolders.length === folders.items.length }
      options.fileCacheStore.setDirectoryPage(scope, boundedFiles as CursorPage<FileMeta>, boundedFolders as CursorPage<FolderMeta>, true)
      if (loadedCount + acceptedFiles.length + acceptedFolders.length >= 2000
          && (files.has_more || folders.has_more)) {
        limitedDirectories.value.add(directoryKey(projectId, folderId ?? null))
      }
    } catch {
      // 加载失败时保留旧页与 cursor，滚动后仍可重试。
    } finally {
      loadingMore.value = false
    }
  }

  function directoryHasMore(): boolean {
    const projectId = options.project()?.id
    if (projectId == null) return false
    const folderId = options.folderStack.value.at(-1)?.id
    const scope: DirectorySnapshotScope = {
      space: 'project', projectId, ...(folderId != null ? { folderId } : {}),
      sortBy: sortBy(), sortOrder: sortOrder(),
    }
    const state = options.fileCacheStore.getDirectory(scope)
    return Boolean(state?.fileHasMore || state?.folderHasMore)
  }

  function directoryLimitReached(): boolean {
    const projectId = options.project()?.id
    return projectId != null && limitedDirectories.value.has(
      directoryKey(projectId, options.folderStack.value.at(-1)?.id ?? null),
    )
  }

  function isDirectoryLoaded(projectId: number, folderId: number | null): boolean {
    return loadedDirectories.has(directoryKey(projectId, folderId))
  }

  function invalidateProjectDirectories(projectId: number): void {
    for (const [key, scope] of directoryScopes) {
      if (!key.startsWith(`${projectId}:`)) continue
      options.fileCacheStore.invalidatePages(scope)
      directoryScopes.delete(key)
      loadedDirectories.delete(key)
    }
    for (const key of [...limitedDirectories.value]) {
      if (key.startsWith(`${projectId}:`)) limitedDirectories.value.delete(key)
    }
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
      directoryScopes.clear()
      limitedDirectories.value.clear()
      return
    }
    for (const key of loadedDirectories) if (!key.startsWith(`${id}:`)) loadedDirectories.delete(key)
    void ensureDirectoryLoaded(id, null)
  }, { immediate: true })

  const liveStore = useLiveStore()
  watch(() => liveStore.rev.files, () => {
    const projectId = options.project()?.id
    if (projectId == null) return
    invalidateProjectDirectories(projectId)
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void ensureDirectoryLoaded(projectId, options.folderStack.value.at(-1)?.id ?? null)
    }, 180)
  })
  onScopeDispose(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  return { initializing, ensureDirectoryLoaded, isDirectoryLoaded, invalidateProjectDirectories,
    loadMoreDirectory, directoryHasMore, directoryLimitReached, loadingMore }
}
