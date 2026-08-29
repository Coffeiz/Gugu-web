import { ref, computed, watch, nextTick } from 'vue'
import { navPathFor, type NavSeg, type FolderCard } from '@/utils/filesNav'

/**
 * 文件库导航 + 前进/后退历史的状态与编排（P2④ 子步 b，从 Files/index.vue 原样搬迁）。
 *
 * 副作用（重投内容 loadContents / 清选择 clearSelection）由宿主注入。navPath 的任何写入——包括
 * 宿主侧 jumpToTarget 直接改返回的 navPath ref——都经 deep watch 自动记入历史；goBack/goForward
 * 用 _isHistoryNav 标志 + nextTick 复位抑制「回放也被记一遍」，时序逐字保持原实现。
 * 历史状态（navHistoryStack/Cursor/_isHistoryNav）与 NAV_KEY 全内部；pruneHistoryForFolders
 * （删文件夹时剪掉引用已删文件夹的历史帧）也是历史逻辑，一并收进来、对外暴露。
 */
export interface FilesNavDeps {
  loadContents: () => void
  clearSelection: () => void
}

export function useFilesNav(deps: FilesNavDeps) {
  const navPath = ref<NavSeg[]>([])
  const navHistoryStack = ref<NavSeg[][]>([])
  const navHistoryCursor = ref(-1)
  let _isHistoryNav = false

  const canGoBack = computed(() => navHistoryCursor.value > 0)
  const canGoForward = computed(() => navHistoryCursor.value < navHistoryStack.value.length - 1)

  watch(navPath, (newVal) => {
    if (_isHistoryNav) return
    const snap = JSON.parse(JSON.stringify(newVal))
    navHistoryStack.value = navHistoryStack.value.slice(0, navHistoryCursor.value + 1)
    navHistoryStack.value.push(snap)
    navHistoryCursor.value = navHistoryStack.value.length - 1
  }, { deep: true })

  function goBack() {
    if (!canGoBack.value) return
    _isHistoryNav = true
    navHistoryCursor.value--
    navPath.value = JSON.parse(JSON.stringify(navHistoryStack.value[navHistoryCursor.value]))
    deps.loadContents()
    nextTick(() => { _isHistoryNav = false })
  }

  function goForward() {
    if (!canGoForward.value) return
    _isHistoryNav = true
    navHistoryCursor.value++
    navPath.value = JSON.parse(JSON.stringify(navHistoryStack.value[navHistoryCursor.value]))
    deps.loadContents()
    nextTick(() => { _isHistoryNav = false })
  }

  const currentType = computed(() => {
    if (navPath.value.length === 0) return 'root'
    return navPath.value[navPath.value.length - 1].type
  })
  const currentSeg = computed(() => navPath.value[navPath.value.length - 1] ?? null)
  const projectSeg = computed(() => navPath.value.find(s => s.type === 'project') ?? null)
  const canUpload = computed(() => ['personal', 'project', 'folder'].includes(currentType.value))

  const NAV_KEY = 'files_nav_path'
  function saveNav() {
    sessionStorage.setItem(NAV_KEY, JSON.stringify(navPath.value))
  }

  function enterFolder(folder: FolderCard) {
    deps.clearSelection()
    navPath.value = navPathFor(folder, navPath.value)
    saveNav()
    deps.loadContents()
  }

  function navigateTo(idx: number) {
    deps.clearSelection()
    if (idx === -1) {
      navPath.value = []
    } else {
      navPath.value = navPath.value.slice(0, idx + 1)
    }
    saveNav()
    deps.loadContents()
  }

  function restoreNav() {
    try {
      const saved = sessionStorage.getItem(NAV_KEY)
      if (!saved) return
      navPath.value = JSON.parse(saved)
    } catch {
      navPath.value = []
    }
  }

  function pruneHistoryForFolders(folderIds: Array<number | string>) {
    const idSet = new Set(folderIds)
    const hasDeleted = (snap: NavSeg[]) => snap.some(seg => seg.type === 'folder' && idSet.has(seg.folderId as number))
    const curIdx = navHistoryCursor.value
    let newCursor = 0
    const kept: NavSeg[][] = []
    navHistoryStack.value.forEach((snap, i) => {
      if (!hasDeleted(snap)) {
        if (i <= curIdx) newCursor = kept.length
        kept.push(snap)
      }
    })
    navHistoryStack.value = kept
    navHistoryCursor.value = Math.min(newCursor, Math.max(0, kept.length - 1))
  }

  return {
    navPath, canGoBack, canGoForward, goBack, goForward,
    currentType, currentSeg, projectSeg, canUpload,
    saveNav, enterFolder, navigateTo, restoreNav, pruneHistoryForFolders,
  }
}
