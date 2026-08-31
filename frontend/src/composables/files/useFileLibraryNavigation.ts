import { nextTick, onUnmounted, type Ref } from 'vue'
import type { Project } from '@/types/project'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { NavSeg, FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { doneYear, doneMonth } from '@/utils/fileParse'

type NavigationTarget = { kind: string; id: number } | null

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
    if (!cacheStore.loaded) await cacheStore.load()
    clearSelection()

    if (target.kind === 'folder') {
      const folder = cacheStore.getFolder(target.id)
      if (!folder) return
      navPath.value = [...basePath(folder.projectId), ...folderChain(folder.id).map(folderSegment)]
    } else {
      const file = cacheStore.getFile(target.id)
      if (!file) return
      navPath.value = file.folderId != null
        ? [...basePath(file.projectId), ...folderChain(file.folderId).map(folderSegment)]
        : basePath(file.projectId)
    }

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
