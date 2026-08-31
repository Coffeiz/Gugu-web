import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { trashApi, type TrashFolderContents, type TrashFolderMeta } from '@/services/api'
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

  function loadContents() {
    const type = currentType.value
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
      Promise.all([trashApi.list(), trashApi.listFolders()]).then(([files, folders]) => {
        const trashFolder = contents.value.folders.find(folder => folder.id === 'trash')
        if (trashFolder) trashFolder.count = files.length + folders.length
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
      const folderId = segment.folderId
      const folderItems = cacheStore.getSubFolders(folderId).map(folder => ({
        id: `f:${folder.id}`, type: 'folder', folderId: folder.id,
        displayName: folder.name, color: segment.color, projectId: segment.projectId ?? null,
        count: cacheStore.getFolderFiles(folder.id).length,
      }))
      contents.value = { folders: folderItems, files: cacheStore.getFolderFiles(folderId) }
    }
  }

  watch(locale, () => loadContents())

  return { contents, trashFolders, expandedTrashFolders, trashFolderContents, sortedTrashFolders, loadContents }
}
