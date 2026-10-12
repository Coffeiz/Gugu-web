import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { filesApi, foldersApi, trashApi, type CursorPage, type TrashFolderContentsSnapshot, type TrashFolderMeta } from '@/services/api'
import type { DirectorySnapshotScope, FileMeta, FolderMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'
import { doneYear, doneMonth } from '@/utils/fileParse'
import { statusFolders, yearFolders, monthFolders } from '@/utils/projectFolderCards'
import { projectStatusLabelKey } from '@/utils/projectStages'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import type { NavSeg, FolderCard as FolderCardMeta } from '@/utils/filesNav'

interface DirectoryProjectStore {
  projects: Project[]
  kanbanColumns: Array<{ key: string; label: string }>
}

interface DirectoryCacheStore {
  getDirectory: (scope: DirectorySnapshotScope) => {
    files: FileMeta[]; folders: FolderMeta[]; fileCursor: string | null; folderCursor: string | null
    fileHasMore: boolean; folderHasMore: boolean
  } | null
  setDirectoryPage: (scope: DirectorySnapshotScope, files: CursorPage<FileMeta>, folders: CursorPage<FolderMeta>, append?: boolean) => void
  getPersonalRootFiles: () => FileMeta[]
  getProjectRootFolders: (projectId: number) => FolderMeta[]
  getProjectRootFiles: (projectId: number) => FileMeta[]
  getSubFolders: (folderId: number) => FolderMeta[]
  getFolderFiles: (folderId: number) => FileMeta[]
  getWorkspaceFolders: (workspaceDirectoryId: number, parentId?: number | null) => FolderMeta[]
  getWorkspaceFiles: (workspaceDirectoryId: number, folderId?: number | null) => FileMeta[]
}

interface ScopedDirectoryState {
  cacheStore: DirectoryCacheStore
  contents: Ref<{ folders: FolderCardMeta[]; files: FileMeta[] }>
  loading: Ref<boolean>
  snapshots: Map<string, ScopedSnapshot>
  snapshotKey: string
  isCurrent: () => boolean
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
  pagination: Ref<{ scope: DirectorySnapshotScope | null; fileCursor: string | null; folderCursor: string | null; fileHasMore: boolean; folderHasMore: boolean }>
}

const MAX_SCOPED_SNAPSHOTS = 8
const MAX_SCOPED_SNAPSHOT_ITEMS = 2000
type ScopedSnapshot = {
  folders: FolderCardMeta[]
  files: FileMeta[]
  pagination: ScopedDirectoryState['pagination']['value']
}

function rememberScopedSnapshot(
  snapshots: Map<string, ScopedSnapshot>,
  key: string,
  snapshot: ScopedSnapshot,
) {
  if (snapshot.folders.length + snapshot.files.length > MAX_SCOPED_SNAPSHOT_ITEMS) {
    snapshots.delete(key)
    return
  }
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  while (snapshots.size > MAX_SCOPED_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (oldest == null) break
    snapshots.delete(oldest)
  }
}

async function loadScopedDirectory(type: string, segment: NavSeg | null, state: ScopedDirectoryState) {
  const accountEpoch = getAccountBoundaryEpoch()
  const isCurrent = () => state.isCurrent() && accountEpoch === getAccountBoundaryEpoch()
  const projectId = type === 'project' ? segment?.id : segment?.projectId
  const folderId = type === 'folder' ? segment?.folderId : undefined
  const workspaceDirectoryId = type === 'workspace' || segment?.space === 'workspace'
    ? segment?.workspaceDirectoryId
    : undefined
  const space = workspaceDirectoryId != null ? 'workspace' : projectId != null ? 'project' : 'personal'
  const cached = state.snapshots.get(state.snapshotKey)
  if (cached) {
    rememberScopedSnapshot(state.snapshots, state.snapshotKey, cached)
    state.contents.value = { folders: [...cached.folders], files: [...cached.files] }
    state.pagination.value = cached.pagination
    state.loading.value = false
  } else {
    // 不要在目标目录请求完成前继续展示上一个目录（尤其是根目录分类卡片）。
    state.contents.value = { folders: [], files: [] }
    state.loading.value = true
  }

  try {
    const scope: DirectorySnapshotScope = {
      space,
      ...(projectId != null ? { projectId } : {}),
      ...(folderId != null ? { folderId } : {}),
      ...(workspaceDirectoryId != null ? { workspaceDirectoryId } : {}),
    }
    const sortBy = ['name', 'type', 'stage', 'createdAt', 'size', 'id'].includes(state.sortKey.value)
      ? state.sortKey.value as 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'
      : 'createdAt'
    scope.sortBy = sortBy
    scope.sortOrder = state.sortDir.value
    const [files, folders] = await Promise.all([
      filesApi.page({ space, projectId: projectId ?? undefined, folderId: folderId ?? undefined,
        workspaceDirectoryId: workspaceDirectoryId ?? undefined, sortBy, sortOrder: state.sortDir.value }),
      foldersApi.page({ projectId: projectId ?? undefined, parentId: folderId ?? undefined,
        workspaceDirectoryId: workspaceDirectoryId ?? undefined, sortBy, sortOrder: state.sortDir.value }),
    ])
    if (!isCurrent()) return
    const fileRows = files.items as FileMeta[]
    const folderRows = folders.items as FolderMeta[]
    state.cacheStore.setDirectoryPage(scope, files as CursorPage<FileMeta>, folders as CursorPage<FolderMeta>)
    state.pagination.value = {
      scope, fileCursor: files.next_cursor, folderCursor: folders.next_cursor,
      fileHasMore: files.has_more, folderHasMore: folders.has_more,
    }
    const folderItems = folderRows.map(folder => ({
      id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
      displayName: folder.name, color: segment?.color ?? null,
      projectId: folder.projectId ?? projectId ?? null,
      ...(workspaceDirectoryId != null ? { space: 'workspace', workspaceDirectoryId } : {}),
      count: folder.fileCount,
    }))
    state.pagination.value = {
      scope, fileCursor: files.next_cursor, folderCursor: folders.next_cursor,
      fileHasMore: files.has_more, folderHasMore: folders.has_more,
    }
    const snapshot = { folders: folderItems, files: fileRows, pagination: state.pagination.value }
    rememberScopedSnapshot(state.snapshots, state.snapshotKey, snapshot)
    state.contents.value = { folders: [...folderItems], files: fileRows }
  } catch (error) {
    if (isCurrent()) {
      if (!cached) state.contents.value = { folders: [], files: [] }
      console.error('[Files] 加载目录失败:', error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (isCurrent()) state.loading.value = false
  }
}

interface DirectoryOptions {
  projectStore: DirectoryProjectStore
  cacheStore: DirectoryCacheStore
  currentType: Ref<string>
  currentSeg: Ref<NavSeg | null>
  loading: Ref<boolean>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}

export function useFileLibraryDirectory(options: DirectoryOptions) {
  const { projectStore, cacheStore, currentType, currentSeg, loading, sortKey, sortDir } = options
  const { t, locale } = useI18n()
  const contents = ref<{ folders: FolderCardMeta[]; files: FileMeta[] }>({ folders: [], files: [] })
  const trashFolders = ref<TrashFolderMeta[]>([])
  const expandedTrashFolders = ref(new Set<number>())
  const trashFolderContents = ref<Record<number, TrashFolderContentsSnapshot>>({})
  const trashFolderCursors = ref<Record<number, { folderCursor: string | null; fileCursor: string | null; folderHasMore: boolean; fileHasMore: boolean }>>({})
  const scopedSnapshots = new Map<string, ScopedSnapshot>()
  const pagination = ref<ScopedDirectoryState['pagination']['value']>({
    scope: null, fileCursor: null, folderCursor: null, fileHasMore: false, folderHasMore: false,
  })
  const loadingMore = ref(false)
  const retentionLimitReached = ref(false)
  const trashPagination = ref({ fileCursor: null as string | null, folderCursor: null as string | null,
    fileHasMore: false, folderHasMore: false })
  const sortedTrashFolders = computed(() => [...trashFolders.value].sort((a, b) => {
    const dir = sortDir.value === 'asc' ? 1 : -1
    if (sortKey.value === 'createdAt') return dir * a.deletedAt.localeCompare(b.deletedAt)
    return dir * a.name.localeCompare(b.name, 'zh')
  }))

  function extractColor(colorStr: string | null | undefined): string | null {
    if (!colorStr) return null
    const match = colorStr.match(/#[0-9a-fA-F]{3,6}/)
    return match ? match[0] : colorStr
  }

  function projectFolder(project: Project): FolderCardMeta {
    return {
      id: `p:${project.id}`,
      type: 'project',
      displayName: project.name,
      color: extractColor(project.color),
      projectId: project.id,
      count: null,
    }
  }

  let requestSequence = 0
  if (getCurrentScope()) onScopeDispose(() => { requestSequence += 1 })
  watch(accountBoundaryEpoch, () => {
    requestSequence += 1
    scopedSnapshots.clear()
    contents.value = { folders: [], files: [] }
    trashFolders.value = []
    expandedTrashFolders.value.clear()
    trashFolderContents.value = {}
    trashFolderCursors.value = {}
    loading.value = false
  }, { flush: 'sync' })

  function loadContents() {
    requestSequence++
    const sequence = requestSequence
    const accountEpoch = getAccountBoundaryEpoch()
    const isCurrent = () => requestSequence === sequence && accountEpoch === getAccountBoundaryEpoch()
    loading.value = false
    const type = currentType.value
    const segment = currentSeg.value
    loadingMore.value = false
    retentionLimitReached.value = false
    pagination.value = { scope: null, fileCursor: null, folderCursor: null, fileHasMore: false, folderHasMore: false }
    if (type !== 'trash') {
      trashFolders.value = []
      expandedTrashFolders.value.clear()
      trashFolderContents.value = {}
      trashFolderCursors.value = {}
    }

    if (type === 'root') {
      contents.value = {
        folders: [
          { id: 'personal', type: 'personal', displayName: t('filesUi.personalFiles'), count: null },
          { id: 'projects', type: 'projects', displayName: t('filesUi.projectFiles'), count: projectStore.projects.length },
          { id: 'trash', type: 'trash', displayName: t('filesUi.trash'), count: null },
        ],
        files: [],
      }
      return
    }

    if (type === 'trash') {
      loading.value = true
      Promise.all([trashApi.page(), trashApi.foldersPage()])
        .then(([files, folders]) => {
          if (!isCurrent()) return
          contents.value = { folders: [], files: files.items as FileMeta[] }
          trashFolders.value = folders.items
          trashPagination.value = {
            fileCursor: files.next_cursor, folderCursor: folders.next_cursor,
            fileHasMore: files.has_more, folderHasMore: folders.has_more,
          }
        })
        .catch(error => { if (isCurrent()) console.error('[Files]', (error as Error).message) })
        .finally(() => { if (isCurrent()) loading.value = false })
      return
    }

    if (type === 'personal') {
      void loadScopedDirectory(type, segment, {
        cacheStore, contents, loading, snapshots: scopedSnapshots, snapshotKey: 'personal-root',
        isCurrent: () => requestSequence === sequence, sortKey, sortDir, pagination,
      })
      return
    }

    if (type === 'projects') {
      contents.value = { folders: statusFolders(projectStore.projects, projectStore.kanbanColumns.map(column => ({ ...column, label: t(projectStatusLabelKey(column.key)) }))), files: [] }
      return
    }

    if (type === 'status') {
      const { status } = currentSeg.value ?? {}
      if (status === 'done') {
        contents.value = { folders: yearFolders(projectStore.projects), files: [] }
      } else {
        const projects = projectStore.projects.filter(project => project.status === status)
        contents.value = { folders: projects.map(projectFolder), files: [] }
      }
      return
    }

    if (type === 'year') {
      const { year } = currentSeg.value ?? {}
      contents.value = { folders: monthFolders(projectStore.projects, year ?? '未归类'), files: [] }
      return
    }

    if (type === 'month') {
      const { year, month } = currentSeg.value ?? {}
      const projects = projectStore.projects.filter(project =>
        project.status === 'done' && doneYear(project) === year && doneMonth(project) === month,
      )
      contents.value = { folders: projects.map(projectFolder), files: [] }
      return
    }

    if (type === 'project') {
      const segment = currentSeg.value
      if (segment?.id == null) return
      void loadScopedDirectory(type, segment, {
        cacheStore, contents, loading, snapshots: scopedSnapshots,
        snapshotKey: `project:${segment.id}:root`,
        isCurrent: () => requestSequence === sequence, sortKey, sortDir, pagination,
      })
      return
    }

    if (type === 'folder') {
      const segment = currentSeg.value
      if (segment?.folderId == null) return
      const scope = segment.space === 'workspace'
        ? `workspace:${segment.workspaceDirectoryId}`
        : segment.projectId != null ? `project:${segment.projectId}` : 'personal'
      void loadScopedDirectory(type, segment, {
        cacheStore, contents, loading, snapshots: scopedSnapshots,
        snapshotKey: `${scope}:folder:${segment.folderId}`,
        isCurrent: () => requestSequence === sequence, sortKey, sortDir, pagination,
      })
      return
    }

    if (type === 'workspace') {
      const directoryId = currentSeg.value?.workspaceDirectoryId
      if (directoryId == null) return
      void loadScopedDirectory(type, segment, {
        cacheStore, contents, loading, snapshots: scopedSnapshots,
        snapshotKey: `workspace:${directoryId}:root`,
        isCurrent: () => requestSequence === sequence, sortKey, sortDir, pagination,
      })
    }
  }

  async function loadMore() {
    if (currentType.value === 'trash') {
      if (loadingMore.value || (!trashPagination.value.fileHasMore && !trashPagination.value.folderHasMore)) return
      const loadedEntityCount = contents.value.files.length + trashFolders.value.length
      if (loadedEntityCount >= MAX_SCOPED_SNAPSHOT_ITEMS) {
        retentionLimitReached.value = true
        return
      }
      loadingMore.value = true
      const sequence = requestSequence
      const epoch = getAccountBoundaryEpoch()
      const before = trashPagination.value
      const emptyFile: CursorPage<FileMeta> = { items: [], next_cursor: before.fileCursor, has_more: before.fileHasMore }
      const emptyFolder: CursorPage<TrashFolderMeta> = { items: [], next_cursor: before.folderCursor, has_more: before.folderHasMore }
      try {
        const [files, folders] = await Promise.all([
          before.fileHasMore ? trashApi.page({ cursor: before.fileCursor }) : Promise.resolve(emptyFile),
          before.folderHasMore ? trashApi.foldersPage({ cursor: before.folderCursor }) : Promise.resolve(emptyFolder),
        ])
        if (sequence !== requestSequence || epoch !== getAccountBoundaryEpoch()) return
        const remaining = MAX_SCOPED_SNAPSHOT_ITEMS - loadedEntityCount
        const acceptedFiles = (files.items as FileMeta[]).slice(0, remaining)
        const acceptedFolders = folders.items.slice(0, Math.max(0, remaining - acceptedFiles.length))
        contents.value = { ...contents.value, files: [...contents.value.files, ...acceptedFiles] }
        trashFolders.value = [...trashFolders.value, ...acceptedFolders]
        retentionLimitReached.value = loadedEntityCount + acceptedFiles.length + acceptedFolders.length >= MAX_SCOPED_SNAPSHOT_ITEMS
        trashPagination.value = {
          fileCursor: files.has_more && acceptedFiles.length === files.items.length ? files.next_cursor : null,
          folderCursor: folders.has_more && acceptedFolders.length === folders.items.length ? folders.next_cursor : null,
          fileHasMore: files.has_more && acceptedFiles.length === files.items.length,
          folderHasMore: folders.has_more && acceptedFolders.length === folders.items.length,
        }
      } catch (error) {
        if (sequence === requestSequence) console.error('[Files] 继续加载回收站失败:', error instanceof Error ? error.message : String(error))
      } finally {
        if (sequence === requestSequence) loadingMore.value = false
      }
      return
    }
    const state = pagination.value
    if (loadingMore.value || !state.scope || (!state.fileHasMore && !state.folderHasMore)) return
    loadingMore.value = true
    const sequence = requestSequence
    const epoch = getAccountBoundaryEpoch()
    const sortBy = ['name', 'type', 'stage', 'createdAt', 'size', 'id'].includes(sortKey.value)
      ? sortKey.value as 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'
      : 'createdAt'
    const scope = { ...state.scope, sortBy, sortOrder: sortDir.value }
    const loadedEntityCount = contents.value.files.length + contents.value.folders.filter(item => item.type === 'folder').length
    if (loadedEntityCount >= MAX_SCOPED_SNAPSHOT_ITEMS) {
      retentionLimitReached.value = true
      return
    }
    const emptyFilePage: CursorPage<FileMeta> = {
      items: [], next_cursor: state.fileCursor, has_more: state.fileHasMore,
    }
    const emptyFolderPage: CursorPage<FolderMeta> = {
      items: [], next_cursor: state.folderCursor, has_more: state.folderHasMore,
    }
    try {
      const [files, folders] = await Promise.all([
        state.fileHasMore
          ? filesApi.page({ space: scope.space, projectId: scope.projectId, folderId: scope.folderId,
            workspaceDirectoryId: scope.workspaceDirectoryId, cursor: state.fileCursor,
            sortBy, sortOrder: sortDir.value })
          : Promise.resolve(emptyFilePage),
        state.folderHasMore
          ? foldersApi.page({ projectId: scope.projectId, parentId: scope.folderId,
            workspaceDirectoryId: scope.workspaceDirectoryId, cursor: state.folderCursor,
            sortBy, sortOrder: sortDir.value })
          : Promise.resolve(emptyFolderPage),
      ])
      if (sequence !== requestSequence || epoch !== getAccountBoundaryEpoch()) return
      const remaining = MAX_SCOPED_SNAPSHOT_ITEMS - loadedEntityCount
      const acceptedFiles = (files.items as FileMeta[]).slice(0, remaining)
      const acceptedFolders = folders.items.slice(0, Math.max(0, remaining - acceptedFiles.length))
      const boundedFiles = { ...files, items: acceptedFiles, has_more: files.has_more && acceptedFiles.length === files.items.length }
      const boundedFolders = { ...folders, items: acceptedFolders, has_more: folders.has_more && acceptedFolders.length === folders.items.length }
      cacheStore.setDirectoryPage(scope, boundedFiles as CursorPage<FileMeta>, boundedFolders as CursorPage<FolderMeta>, true)
      const folderCards = acceptedFolders.map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: currentSeg.value?.color ?? null,
        projectId: folder.projectId ?? scope.projectId ?? null,
        ...(scope.workspaceDirectoryId != null ? { space: 'workspace', workspaceDirectoryId: scope.workspaceDirectoryId } : {}),
        count: folder.fileCount,
      }))
      contents.value = {
        folders: [...contents.value.folders, ...folderCards],
        files: [...contents.value.files, ...acceptedFiles],
      }
      retentionLimitReached.value = loadedEntityCount + acceptedFiles.length + acceptedFolders.length >= MAX_SCOPED_SNAPSHOT_ITEMS
      pagination.value = {
        scope,
        fileCursor: boundedFiles.has_more ? files.next_cursor : null,
        folderCursor: boundedFolders.has_more ? folders.next_cursor : null,
        fileHasMore: boundedFiles.has_more,
        folderHasMore: boundedFolders.has_more,
      }
      rememberScopedSnapshot(scopedSnapshots, directoryKeyForSnapshot(scope), {
        folders: contents.value.folders, files: contents.value.files, pagination: pagination.value,
      })
    } catch (error) {
      if (sequence === requestSequence) console.error('[Files] 继续加载失败:', error instanceof Error ? error.message : String(error))
    } finally {
      if (sequence === requestSequence) loadingMore.value = false
    }
  }

  function directoryKeyForSnapshot(scope: DirectorySnapshotScope) {
    if (scope.space === 'workspace') return scope.folderId != null
      ? `workspace:${scope.workspaceDirectoryId}:folder:${scope.folderId}`
      : `workspace:${scope.workspaceDirectoryId}:root`
    if (scope.space === 'project') return scope.folderId != null
      ? `project:${scope.projectId}:folder:${scope.folderId}`
      : `project:${scope.projectId}:root`
    return scope.folderId != null ? `personal:folder:${scope.folderId}` : 'personal-root'
  }

  /** 删除文件时同步剔除当前视图和所有按需目录快照，避免旧快照重新显示已删卡片。 */
  function removeFilesFromSnapshots(fileIds: number[]) {
    if (!fileIds.length) return
    const removedIds = new Set(fileIds)
    contents.value = {
      ...contents.value,
      files: contents.value.files.filter(file => !removedIds.has(file.id)),
    }
    for (const [key, snapshot] of scopedSnapshots) {
      const files = snapshot.files.filter(file => !removedIds.has(file.id))
      if (files.length !== snapshot.files.length) {
        scopedSnapshots.set(key, { ...snapshot, files })
      }
    }
  }

  watch(locale, () => loadContents())
  watch([sortKey, sortDir], () => {
    scopedSnapshots.clear()
    loadContents()
  })

  return { contents, trashFolders, expandedTrashFolders, trashFolderContents, sortedTrashFolders,
    trashFolderCursors, pagination, trashPagination, loadingMore, retentionLimitReached, loadContents, loadMore, removeFilesFromSnapshots }
}
