import { createApp, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import type { FileLibraryNavigationTarget, NavSeg } from '@/utils/filesNav'
import { filesApi, foldersApi } from '@/services/api'

vi.mock('@/services/api', () => ({ filesApi: { location: vi.fn() }, foldersApi: { location: vi.fn() } }))

function mountNavigation() {
  const navPath = ref<NavSeg[]>([])
  const cacheStore = {
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
      folderPath: [{ id: 34, name: '源码' }, { id: 56, name: '前端' }],
    }
    vi.mocked(filesApi.location).mockResolvedValue({
      file: { projectId: null, workspaceDirectoryId: 12 } as never,
      folderPath: [{ id: 34, name: '源码' }, { id: 56, name: '前端' }] as never,
    } as never)
    vi.mocked(foldersApi.location).mockResolvedValue({
      folder: { id: 73, name: '目标', projectId: null, workspaceDirectoryId: 12 } as never,
      ancestors: [{ id: 34, name: '源码' }, { id: 56, name: '前端' }] as never,
    } as never)

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
      expect(kind === 'file' ? filesApi.location : foldersApi.location).toHaveBeenCalledWith(target.id)
      expect(mounted.loadContents).toHaveBeenCalledOnce()
      expect(mounted.saveNav).toHaveBeenCalledOnce()
      expect(mounted.clearSelection).toHaveBeenCalledOnce()
    } finally {
      mounted.app.unmount()
      mounted.host.remove()
    }
  })

  it('项目空间文件命中时使用接口返回的 folderPath 跳到所属项目目录', async () => {
    const mounted = mountNavigation()
    vi.mocked(filesApi.location).mockResolvedValue({
      file: { projectId: 308, workspaceDirectoryId: null } as never,
      folderPath: [
        { id: 4381, projectId: 308, name: 'coffeiz-speedraw' },
        { id: 4570, projectId: 308, name: 'reference' },
      ] as never,
    } as never)

    try {
      await mounted.navigation.jumpToTarget({ kind: 'file', id: 21183 })

      expect(mounted.navPath.value).toEqual([
        { type: 'projects', name: '项目文件', color: null },
        { type: 'project', id: 308, name: '项目', color: null },
        { type: 'folder', folderId: 4381, name: 'coffeiz-speedraw', projectId: 308, color: null },
        { type: 'folder', folderId: 4570, name: 'reference', projectId: 308, color: null },
      ])
      expect(mounted.loadContents).toHaveBeenCalledOnce()
      expect(mounted.saveNav).toHaveBeenCalledOnce()
      expect(mounted.clearSelection).toHaveBeenCalledOnce()
    } finally {
      mounted.app.unmount()
      mounted.host.remove()
    }
  })
})
