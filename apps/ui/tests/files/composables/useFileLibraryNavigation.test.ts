import { createApp, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import type { NavSeg } from '@/utils/filesNav'
import { filesApi } from '@/services/api'

vi.mock('@/services/api', () => ({ filesApi: { location: vi.fn() } }))

function mountNavigation() {
  const navPath = ref<NavSeg[]>([])
  const saveNav = vi.fn()
  const loadContents = vi.fn()
  const clearSelection = vi.fn()
  let navigation!: ReturnType<typeof useFileLibraryNavigation>
  const app = createApp({
    setup() {
      navigation = useFileLibraryNavigation({
        projectStore: { projects: [], kanbanColumns: [] },
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
  return { app, host, navigation, navPath, saveNav, loadContents, clearSelection }
}

describe('文件库全局搜索定位', () => {
  it('工作区文件夹从路径引用打开，旧数字目录引用不会触发跳转', async () => {
    const mounted = mountNavigation()
    try {
      await mounted.navigation.jumpToTarget({ kind: 'folder', id: 73 })
      expect(mounted.navPath.value).toEqual([])
      expect(mounted.loadContents).not.toHaveBeenCalled()

      await mounted.navigation.jumpToTarget({
        kind: 'folder', id: 0,
        pathFile: { directoryId: 12, directoryName: '开发工作区', relativePath: '源码/前端' },
      })
      expect(mounted.navPath.value).toEqual([
        { type: 'disk-workspace', name: '开发工作区', workspaceDirectoryId: 12 },
        { type: 'disk-workspace', name: '源码', workspaceDirectoryId: 12, relativePath: '源码' },
        { type: 'disk-workspace', name: '前端', workspaceDirectoryId: 12, relativePath: '源码/前端' },
      ])
      expect(mounted.loadContents).toHaveBeenCalledOnce()
    } finally {
      mounted.app.unmount()
      mounted.host.remove()
    }
  })

  it('项目空间文件命中时使用授权路径跳到所属项目目录', async () => {
    const mounted = mountNavigation()
    vi.mocked(filesApi.location).mockResolvedValue({
      file: { projectId: 308, workspaceDirectoryId: null } as never,
      pathFile: { directoryId: 'project:308', relativePath: '设计/参考/示例.md' },
    } as never)

    try {
      await mounted.navigation.jumpToTarget({ kind: 'file', id: 21183 })

      expect(mounted.navPath.value).toEqual([
        { type: 'projects', name: '项目文件', color: null },
        { type: 'project', id: 308, name: '项目', color: null },
        { type: 'disk-project', name: '设计', workspaceDirectoryId: undefined, relativePath: '设计' },
        { type: 'disk-project', name: '参考', workspaceDirectoryId: undefined, relativePath: '设计/参考' },
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
