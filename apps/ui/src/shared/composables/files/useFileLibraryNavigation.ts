import { nextTick, onUnmounted, type Ref } from 'vue'
import type { Project } from '@/types/project'
import type { FileLibraryNavigationTarget, NavSeg } from '@/utils/filesNav'
import { doneYear, doneMonth } from '@/utils/fileParse'

type NavigationTarget = FileLibraryNavigationTarget | null

interface NavigationOptions {
  projectStore: {
    projects: Project[]
    kanbanColumns: Array<{ key: string; label: string }>
  }
  uiStore: { pendingFileTarget: NavigationTarget }
  navPath: Ref<NavSeg[]>
  saveNav: () => void
  loadContents: () => void
  clearSelection: () => void
  mainRef: Ref<HTMLElement | null>
}

interface TargetPathDependencies {
  basePath: (projectId: number | null) => NavSeg[]
}

async function resolveTargetPath(target: FileLibraryNavigationTarget, deps: TargetPathDependencies): Promise<{ path: NavSeg[]; relativePath?: string }> {
  if (target.pathFile) {
    const { directoryId, directoryName, relativePath } = target.pathFile
    const suffix = relativePath ? relativePath.split('/') : []
    if (target.kind === 'file') suffix.pop()
    const type = typeof directoryId === 'number' ? 'disk-workspace' : directoryId === 'personal' ? 'disk-personal' : 'disk-project'
    const workspaceDirectoryId = typeof directoryId === 'number' ? directoryId : undefined
    const base = typeof directoryId === 'number'
      ? [{ type: 'disk-workspace', name: directoryName, workspaceDirectoryId }]
      : deps.basePath(directoryId === 'personal' ? null : Number(directoryId.slice('project:'.length)))
    const path = [...base, ...suffix.map((name, index): NavSeg => ({
      type, name, workspaceDirectoryId, relativePath: suffix.slice(0, index + 1).join('/'),
    }))]
    return { path, relativePath }
  }
  throw new Error('文件目标缺少路径')
}

export function useFileLibraryNavigation(options: NavigationOptions) {
  const { projectStore, uiStore, navPath, saveNav, loadContents, clearSelection, mainRef } = options

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

  let flashRequest = 0
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let activeFlashElement: HTMLElement | null = null

  function clearFlash() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    activeFlashElement?.classList.remove('search-highlight')
    activeFlashElement = null
  }

  function flashFile(relativePath: string) {
    const request = ++flashRequest
    clearFlash()
    let attempts = 0
    const findElement = () => {
      if (request !== flashRequest) return
      const element = Array.from(mainRef.value?.querySelectorAll<HTMLElement>('[data-path-file]') ?? [])
        .find(card => card.dataset.pathFile === relativePath)
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
    if (!target || (target.kind === 'folder' && !target.pathFile)) return
    let resolved: Awaited<ReturnType<typeof resolveTargetPath>>
    try {
      resolved = await resolveTargetPath(target, { basePath })
    } catch {
      return
    }
    clearSelection()
    navPath.value = resolved.path
    saveNav()
    loadContents()
    if (target.kind === 'file' && resolved.relativePath) {
      await nextTick()
      flashFile(resolved.relativePath)
    }
  }

  function consumePendingTarget(): NavigationTarget {
    const target = uiStore.pendingFileTarget
    uiStore.pendingFileTarget = null
    return target
  }

  return { jumpToTarget, consumePendingTarget }
}
