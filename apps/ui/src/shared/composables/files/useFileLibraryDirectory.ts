import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { diskTrashApi, filesApi } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import type { FileMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'
import { projectDirectoryFolders } from '@/utils/projectFolderCards'
import { projectStatusLabelKey } from '@/utils/projectStages'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import type { NavSeg, FolderCard as FolderCardMeta } from '@/utils/filesNav'

interface DirectoryProjectStore {
  projects: Project[]
  kanbanColumns: Array<{ key: string; label: string }>
}

interface DirectoryOptions {
  projectStore: DirectoryProjectStore
  currentType: Ref<string>
  currentSeg: Ref<NavSeg | null>
  loading: Ref<boolean>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}

export function useFileLibraryDirectory(options: DirectoryOptions) {
  const pathFilesApi = usePathFileAccess()
  const { projectStore, currentType, currentSeg, loading, sortKey, sortDir } = options
  const { t, locale } = useI18n()
  const contents = ref<{ folders: FolderCardMeta[]; files: FileMeta[] }>({ folders: [], files: [] })
  let requestSequence = 0
  if (getCurrentScope()) onScopeDispose(() => { requestSequence += 1 })
  watch(accountBoundaryEpoch, () => {
    requestSequence += 1
    contents.value = { folders: [], files: [] }
    loading.value = false
  }, { flush: 'sync' })

  function loadContents() {
    requestSequence++
    const sequence = requestSequence
    const accountEpoch = getAccountBoundaryEpoch()
    const isCurrent = () => requestSequence === sequence && accountEpoch === getAccountBoundaryEpoch()
    loading.value = false
    const type = currentType.value
    if (type === 'disk-workspace') {
      contents.value = { folders: [], files: [] }
      return
    }

    if (type === 'root') {
      contents.value = {
        folders: [
          { id: 'personal', type: 'personal', displayName: t('filesUi.personalFiles'), count: null, fileCount: null, folderCount: null },
          { id: 'projects', type: 'projects', displayName: t('filesUi.projectFiles'), count: null, fileCount: null, folderCount: null },
          { id: 'trash', type: 'trash', displayName: t('filesUi.trash'), count: null, fileCount: null, folderCount: null },
        ],
        files: [],
      }
      void pathFilesApi.entries('personal').then(entries => {
        if (!isCurrent()) return
        const folderCount = entries.filter(entry => entry.kind === 'directory').length
        contents.value = {
          ...contents.value,
          folders: contents.value.folders.map(folder => folder.id === 'personal'
            ? { ...folder, folderCount, fileCount: entries.length - folderCount }
            : folder),
        }
      }).catch(() => {
        // 统计依赖磁盘目录快照，失败时保持未知。
      })
      void diskTrashApi.list().then(entries => {
        if (!isCurrent()) return
        const folderCount = entries.filter(entry => entry.kind === 'directory').length
        contents.value = {
          ...contents.value,
          folders: contents.value.folders.map(folder => folder.id === 'trash'
            ? { ...folder, folderCount, fileCount: entries.length - folderCount }
            : folder),
        }
      }).catch(() => {
        // 回收站暂时不可读时，保留未知数量。
      })
      const loadLibraryCounts = filesApi.libraryCounts
      if (loadLibraryCounts) {
        void loadLibraryCounts().then(counts => {
          if (!isCurrent()) return
          contents.value = {
            ...contents.value,
            folders: contents.value.folders.map(folder => ({
              ...folder,
              ...(folder.id === 'projects' ? { fileCount: counts.projectFileCount, folderCount: counts.projectFolderCount } : {}),
            })),
          }
        }).catch(() => {
          // 根目录仍可用；统计失败时保留未知态，不影响文件浏览。
        })
      }
      return
    }

    if (type === 'trash') {
      contents.value = { folders: [], files: [] }
      return
    }

    if (type === 'projects' || type === 'status' || type === 'year' || type === 'month') {
      const columns = projectStore.kanbanColumns.map(column => ({ ...column, label: t(projectStatusLabelKey(column.key)) }))
      contents.value = { folders: projectDirectoryFolders(projectStore.projects, { ...currentSeg.value, type }, columns), files: [] }
      return
    }
  }

  function removeFilesFromSnapshots(filePaths: string[]) {
    const removedPaths = new Set(filePaths)
    contents.value = { ...contents.value, files: contents.value.files.filter(file => !file.filePath || !removedPaths.has(file.filePath)) }
  }

  watch(locale, () => loadContents())
  watch([sortKey, sortDir], () => {
    loadContents()
  })

  return { contents, loadContents, removeFilesFromSnapshots }
}
