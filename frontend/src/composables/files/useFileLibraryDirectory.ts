import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { filesApi, foldersApi, trashApi, type TrashFolderContents, type TrashFolderMeta } from '@/services/api'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'
import { doneYear, doneMonth } from '@/utils/fileParse'
import { statusFolders, yearFolders, monthFolders } from '@/utils/projectFolderCards'
import { projectStatusLabelKey } from '@/utils/projectStages'
import type { NavSeg, FolderCard as FolderCardMeta } from '@/utils/filesNav'

interface DirectoryProjectStore {
  projects: Project[]
  kanbanColumns: Array<{ key: string; label: string }>
}

interface DirectoryCacheStore {
  loaded: boolean
  allFiles: FileMeta[]
  getPersonalRootFolders: () => FolderMeta[]
  getPersonalRootFiles: () => FileMeta[]
  getProjectRootFolders: (projectId: number) => FolderMeta[]
  getProjectRootFiles: (projectId: number) => FileMeta[]
  getSubFolders: (folderId: number) => FolderMeta[]
  getFolderFiles: (folderId: number) => FileMeta[]
  getWorkspaceFolders: (workspaceDirectoryId: number, parentId?: number | null) => FolderMeta[]
  getWorkspaceFiles: (workspaceDirectoryId: number, folderId?: number | null) => FileMeta[]
  mergeDirectorySnapshot: (files: FileMeta[], folders: FolderMeta[]) => void
}

interface ScopedDirectoryState {
  cacheStore: DirectoryCacheStore
  contents: Ref<{ folders: FolderCardMeta[]; files: FileMeta[] }>
  loading: Ref<boolean>
  snapshots: Map<string, { folders: FolderCardMeta[]; files: FileMeta[] }>
  snapshotKey: string
  isCurrent: () => boolean
}

const MAX_SCOPED_SNAPSHOTS = 8
const MAX_SCOPED_SNAPSHOT_ITEMS = 2000

function rememberScopedSnapshot(
  snapshots: Map<string, { folders: FolderCardMeta[]; files: FileMeta[] }>,
  key: string,
  snapshot: { folders: FolderCardMeta[]; files: FileMeta[] },
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
    state.loading.value = false
  } else {
    // 不要在目标目录请求完成前继续展示上一个目录（尤其是根目录分类卡片）。
    state.contents.value = { folders: [], files: [] }
    state.loading.value = true
  }

  try {
    const [files, folders] = await Promise.all([
      filesApi.list({ space, projectId: projectId ?? undefined, folderId: folderId ?? undefined,
        workspaceDirectoryId: workspaceDirectoryId ?? undefined }),
      foldersApi.list({ projectId: projectId ?? undefined, parentId: folderId ?? undefined,
        workspaceDirectoryId: workspaceDirectoryId ?? undefined }),
    ])
    if (!state.isCurrent()) return
    const fileRows = files as FileMeta[]
    const folderRows = folders as FolderMeta[]
    state.cacheStore.mergeDirectorySnapshot(fileRows, folderRows)
    const folderItems = folderRows.map(folder => ({
      id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
      displayName: folder.name, color: segment?.color ?? null,
      projectId: folder.projectId ?? projectId ?? null,
      ...(workspaceDirectoryId != null ? { space: 'workspace', workspaceDirectoryId } : {}),
      count: folder.fileCount,
    }))
    const snapshot = { folders: folderItems, files: fileRows }
    rememberScopedSnapshot(state.snapshots, state.snapshotKey, snapshot)
    state.contents.value = { folders: [...folderItems], files: fileRows }
  } catch (error) {
    if (state.isCurrent()) {
      if (!cached) state.contents.value = { folders: [], files: [] }
      console.error('[Files] 加载目录失败:', error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (state.isCurrent()) state.loading.value = false
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
  const trashFolderContents = ref<Record<number, TrashFolderContents>>({})
  const scopedSnapshots = new Map<string, { folders: FolderCardMeta[]; files: FileMeta[] }>()
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
      count: cacheStore.loaded
        ? cacheStore.allFiles.filter(file => file.projectId === project.id).length
        : null,
    }
  }

  let requestSequence = 0

  function loadContents() {
    requestSequence++
    const sequence = requestSequence
    loading.value = false
    const type = currentType.value
    const segment = currentSeg.value
    if (type !== 'trash') {
      trashFolders.value = []
      expandedTrashFolders.value.clear()
      trashFolderContents.value = {}
    }

    if (type === 'root') {
      const personalCount = cacheStore.loaded
        ? cacheStore.getPersonalRootFiles().length + cacheStore.getPersonalRootFolders().length
        : null
      contents.value = {
        folders: [
          { id: 'personal', type: 'personal', displayName: t('filesUi.personalFiles'), count: personalCount },
          { id: 'projects', type: 'projects', displayName: t('filesUi.projectFiles'), count: projectStore.projects.length },
          { id: 'trash', type: 'trash', displayName: t('filesUi.trash'), count: null },
        ],
        files: [],
      }
      const rootCountRequest = cacheStore.loaded ? Promise.resolve(null) : filesApi.tree()
      Promise.all([trashApi.counts(), rootCountRequest]).then(([trashCounts, tree]) => {
        const personalFolder = contents.value.folders.find(folder => folder.id === 'personal')
        if (personalFolder && tree) personalFolder.count = tree.personalRootCount
        const trashFolder = contents.value.folders.find(folder => folder.id === 'trash')
        if (trashFolder) trashFolder.count = trashCounts.totalCount
      }).catch(() => {})
      return
    }

    if (type === 'trash') {
      loading.value = true
      Promise.all([trashApi.list(), trashApi.listFolders()])
        .then(([files, folders]) => {
          contents.value = { folders: [], files }
          trashFolders.value = folders
        })
        .catch(error => console.error('[Files]', (error as Error).message))
        .finally(() => { loading.value = false })
      return
    }

    if (type === 'personal') {
      if (!cacheStore.loaded) {
        void loadScopedDirectory(type, segment, {
          cacheStore, contents, loading, snapshots: scopedSnapshots, snapshotKey: 'personal-root',
          isCurrent: () => requestSequence === sequence,
        })
        return
      }
      const folderItems = cacheStore.getPersonalRootFolders().map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: null, space: 'personal',
        count: cacheStore.getFolderFiles(folder.id).length,
      }))
      contents.value = { folders: folderItems, files: cacheStore.getPersonalRootFiles() }
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
      if (!cacheStore.loaded) {
        void loadScopedDirectory(type, segment, {
          cacheStore, contents, loading, snapshots: scopedSnapshots,
          snapshotKey: `project:${segment.id}:root`,
          isCurrent: () => requestSequence === sequence,
        })
        return
      }
      const projectId = segment.id
      const folderItems = cacheStore.getProjectRootFolders(projectId).map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: segment.color, projectId,
        count: cacheStore.getFolderFiles(folder.id).length,
      }))
      contents.value = { folders: folderItems, files: cacheStore.getProjectRootFiles(projectId) }
      return
    }

    if (type === 'folder') {
      const segment = currentSeg.value
      if (segment?.folderId == null) return
      if (!cacheStore.loaded) {
        const scope = segment.space === 'workspace'
          ? `workspace:${segment.workspaceDirectoryId}`
          : segment.projectId != null ? `project:${segment.projectId}` : 'personal'
        void loadScopedDirectory(type, segment, {
          cacheStore, contents, loading, snapshots: scopedSnapshots,
          snapshotKey: `${scope}:folder:${segment.folderId}`,
          isCurrent: () => requestSequence === sequence,
        })
        return
      }
      if (segment.space === 'workspace' && segment.workspaceDirectoryId != null) {
        const workspaceDirectoryId = segment.workspaceDirectoryId
        const folderId = segment.folderId
        const folderItems = cacheStore.getWorkspaceFolders(workspaceDirectoryId, folderId).map(folder => ({
          id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
          displayName: folder.name, color: null, space: 'workspace',
          workspaceDirectoryId, count: cacheStore.getWorkspaceFiles(workspaceDirectoryId, folder.id).length,
        }))
        contents.value = {
          folders: folderItems,
          files: cacheStore.getWorkspaceFiles(workspaceDirectoryId, folderId),
        }
        return
      }
      const folderId = segment.folderId
      const folderItems = cacheStore.getSubFolders(folderId).map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: segment.color, projectId: segment.projectId ?? null,
        count: cacheStore.getFolderFiles(folder.id).length,
      }))
      contents.value = { folders: folderItems, files: cacheStore.getFolderFiles(folderId) }
      return
    }

    if (type === 'workspace') {
      const directoryId = currentSeg.value?.workspaceDirectoryId
      if (directoryId == null) return
      if (!cacheStore.loaded) {
        void loadScopedDirectory(type, segment, {
          cacheStore, contents, loading, snapshots: scopedSnapshots,
          snapshotKey: `workspace:${directoryId}:root`,
          isCurrent: () => requestSequence === sequence,
        })
        return
      }
      const folderItems = cacheStore.getWorkspaceFolders(directoryId).map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: null, space: 'workspace',
        workspaceDirectoryId: directoryId, count: cacheStore.getWorkspaceFiles(directoryId, folder.id).length,
      }))
      contents.value = {
        folders: folderItems,
        files: cacheStore.getWorkspaceFiles(directoryId),
      }
    }
  }

  watch(locale, () => loadContents())

  return { contents, trashFolders, expandedTrashFolders, trashFolderContents, sortedTrashFolders, loadContents }
}
