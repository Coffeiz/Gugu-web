import { nextTick, onUnmounted, type Ref } from 'vue'
import type { Project } from '@/types/project'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { FileLibraryNavigationTarget, NavSeg, FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { doneYear, doneMonth } from '@/utils/fileParse'

type NavigationTarget = FileLibraryNavigationTarget | null

interface NavigationOptions {
  projectStore: {
    projects: Project[]
    kanbanColumns: Array<{ key: string; label: string }>
  }
  cacheStore: {
    loaded: boolean
    load: () => Promise<void>
    getFolder: (id: number) => FolderMeta | null | undefined
    getFile: (id: number) => FileMeta | null | undefined
  }
  uiStore: { pendingFileTarget: NavigationTarget }
  navPath: Ref<NavSeg[]>
  saveNav: () => void
  loadContents: () => void
  clearSelection: () => void
  mainRef: Ref<HTMLElement | null>
}

interface TargetPathDependencies {
  cacheStore: NavigationOptions['cacheStore']
  folderChain: (folderId: number) => FolderMeta[]
  basePath: (projectId: number | null) => NavSeg[]
  folderSegment: (folder: FolderMeta) => NavSeg
}

async function resolveTargetPath(target: FileLibraryNavigationTarget, deps: TargetPathDependencies): Promise<NavSeg[] | null> {
  if (target.workspaceDirectoryId != null) {
    return [
      {
        type: 'workspace',
        name: target.workspaceDirectoryName || '工作区',
        color: null,
        space: 'workspace',
        workspaceDirectoryId: target.workspaceDirectoryId,
      },
      ...(target.folderPath ?? []).map(folder => ({
        type: 'folder',
        folderId: folder.id,
        name: folder.name,
        color: null,
        space: 'workspace',
        workspaceDirectoryId: target.workspaceDirectoryId,
      })),
    ]
  }

  if (!deps.cacheStore.loaded) await deps.cacheStore.load()
  if (target.kind === 'folder') {
    const folder = deps.cacheStore.getFolder(target.id)
    return folder
      ? [...deps.basePath(folder.projectId), ...deps.folderChain(folder.id).map(deps.folderSegment)]
      : null
  }

  const file = deps.cacheStore.getFile(target.id)
  return file
    ? file.folderId != null
      ? [...deps.basePath(file.projectId), ...deps.folderChain(file.folderId).map(deps.folderSegment)]
      : deps.basePath(file.projectId)
    : null
}

export function useFileLibraryNavigation(options: NavigationOptions) {
  const { projectStore, cacheStore, uiStore, navPath, saveNav, loadContents, clearSelection, mainRef } = options

  function folderChain(folderId: number): FolderMeta[] {
    const chain: FolderMeta[] = []
    const seen = new Set<number>()
    let current = cacheStore.getFolder(folderId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current)
      current = current.parentId != null ? cacheStore.getFolder(current.parentId) : undefined
    }
    return chain
  }

  function basePath(projectId: number | null): NavSeg[] {
    if (projectId == null) return [{ type: 'personal', name: '个人文件', color: null }]

    const project = projectStore.projects.find(item => item.id === projectId)
    const base: NavSeg[] = [{ type: 'projects', name: '项目文件', color: null }]
    if (project) {
      const column = projectStore.kanbanColumns.find(item => item.key === project.status)
      base.push({ type: 'status', status: project.status, name: column?.label ?? '项目', color: null })
      if (project.status === 'done') {
        const year = doneYear(project)
        const month = doneMonth(project)
        base.push({ type: 'year', name: `${year} 年`, year, color: null })
        base.push({ type: 'month', name: `${parseInt(month)} 月`, year, month, color: null })
      }
    }
    base.push({ type: 'project', id: projectId, name: project?.name ?? '项目', color: project?.color ?? null })
    return base
  }

  function folderSegment(folder: FolderMeta): NavSeg {
    return {
      type: 'folder',
      folderId: folder.id,
      name: folder.name,
      projectId: folder.projectId ?? null,
      color: null,
    }
  }

  let flashRequest = 0
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let activeFlashElement: HTMLElement | null = null

  function clearFlash() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    activeFlashElement?.classList.remove('search-highlight')
    activeFlashElement = null
  }

  function flashItem(kind: 'file' | 'folder', id: number) {
    const request = ++flashRequest
    clearFlash()
    let attempts = 0
    const findElement = () => {
      if (request !== flashRequest) return
      const attribute = kind === 'file' ? 'data-file-id' : 'data-folder-id'
      const element = mainRef.value?.querySelector<HTMLElement>(`[${attribute}="${id}"]`)
      if (!element) {
        if (attempts++ >= 30) return
        flashTimer = setTimeout(findElement, 50)
        return
      }
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      element.classList.add('search-highlight')
      activeFlashElement = element
      flashTimer = setTimeout(() => {
        if (request !== flashRequest) return
        element.classList.remove('search-highlight')
        activeFlashElement = null
        flashTimer = null
      }, 1800)
    }
    flashTimer = setTimeout(findElement, 50)
  }

  onUnmounted(() => {
    flashRequest++
    clearFlash()
  })

  async function jumpToTarget(target: NavigationTarget) {
    if (!target) return
    const path = await resolveTargetPath(target, { cacheStore, folderChain, basePath, folderSegment })
    if (!path) return
    clearSelection()
    navPath.value = path
    saveNav()
    loadContents()
    if (target.kind === 'file' || target.kind === 'folder') {
      await nextTick()
      flashItem(target.kind, target.id)
    }
  }

  function consumePendingTarget(): NavigationTarget {
    const target = uiStore.pendingFileTarget
    uiStore.pendingFileTarget = null
    return target
  }

  return { jumpToTarget, consumePendingTarget }
}
