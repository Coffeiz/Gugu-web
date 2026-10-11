import { createApp, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import type { FileLibraryNavigationTarget, NavSeg } from '@/utils/filesNav'

function mountNavigation() {
  const navPath = ref<NavSeg[]>([])
  const cacheStore = {
    loaded: false,
    load: vi.fn().mockResolvedValue(undefined),
    getFolder: vi.fn(),
    getFile: vi.fn(),
  }
  const saveNav = vi.fn()
  const loadContents = vi.fn()
  const clearSelection = vi.fn()
  let navigation!: ReturnType<typeof useFileLibraryNavigation>
  const app = createApp({
    setup() {
      navigation = useFileLibraryNavigation({
        projectStore: { projects: [], kanbanColumns: [] },
        cacheStore,
        uiStore: { pendingFileTarget: null },
        navPath,
        saveNav,
        loadContents,
        clearSelection,
        mainRef: ref(null),
      })
      return () => h('div')
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return { app, host, navigation, navPath, cacheStore, saveNav, loadContents, clearSelection }
}

describe('文件库全局搜索定位', () => {
  it.each(['file', 'folder'] as const)('%s 命中工作区时沿工作区父链定位且不加载全库', async kind => {
    const mounted = mountNavigation()
    const target: FileLibraryNavigationTarget = {
      kind,
      id: kind === 'file' ? 91 : 73,
      workspaceDirectoryId: 12,
      workspaceDirectoryName: '开发工作区',
      folderPath: [
        { id: 34, name: '源码' },
        { id: 56, name: '前端' },
      ],
    }

    try {
      await mounted.navigation.jumpToTarget(target)

      expect(mounted.navPath.value).toEqual([
        {
          type: 'workspace', name: '开发工作区', color: null,
          space: 'workspace', workspaceDirectoryId: 12,
        },
        {
          type: 'folder', folderId: 34, name: '源码', color: null,
          space: 'workspace', workspaceDirectoryId: 12,
        },
        {
          type: 'folder', folderId: 56, name: '前端', color: null,
          space: 'workspace', workspaceDirectoryId: 12,
        },
      ])
      expect(mounted.cacheStore.load).not.toHaveBeenCalled()
      expect(mounted.loadContents).toHaveBeenCalledOnce()
      expect(mounted.saveNav).toHaveBeenCalledOnce()
      expect(mounted.clearSelection).toHaveBeenCalledOnce()
    } finally {
      mounted.app.unmount()
      mounted.host.remove()
    }
  })
})
