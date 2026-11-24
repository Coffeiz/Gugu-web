import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { diskTrashApi, filesApi, pathFilesApi } from '@/services/api'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import { beginAccountBoundary } from '@/utils/accountBoundary'
import type { NavSeg } from '@/utils/filesNav'

vi.mock('@/services/api', () => ({
  filesApi: { page: vi.fn(), libraryCounts: vi.fn() },
  pathFilesApi: { entries: vi.fn() },
  diskTrashApi: { list: vi.fn() },
}))
vi.mock('vue-i18n', async () => {
  const vue = await import('vue')
  return { useI18n: () => ({ t: (key: string) => key, locale: vue.ref('zh-CN') }) }
})

describe('文件库分类目录', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pathFilesApi.entries).mockResolvedValue([])
    vi.mocked(diskTrashApi.list).mockResolvedValue([])
    vi.mocked(filesApi.libraryCounts).mockResolvedValue({ personalFileCount: 0, personalFolderCount: 0, projectFileCount: 0, projectFolderCount: 0, trashFileCount: 0, trashFolderCount: 0 })
  })
  function setup(type: string, segment: NavSeg | null = null) {
    return useFileLibraryDirectory({ projectStore: { projects: [], kanbanColumns: [] },
      currentType: ref(type), currentSeg: ref(segment), loading: ref(false), sortKey: ref('name'), sortDir: ref('asc') })
  }

  it('根目录统计读取磁盘结果，不请求文件或目录分页', async () => {
    vi.mocked(pathFilesApi.entries).mockResolvedValue([
      { name: 'shell.txt', relativePath: 'shell.txt', kind: 'file', size: 12, mimeType: 'text/plain' },
      { name: '子目录', relativePath: '子目录', kind: 'directory', size: 0, mimeType: null },
    ])
    const directory = setup('root')
    directory.loadContents()
    await vi.waitFor(() => expect(directory.contents.value.folders.find(item => item.id === 'personal'))
      .toMatchObject({ fileCount: 1, folderCount: 1 }))
    expect(filesApi.page).not.toHaveBeenCalled()
  })

  it('路径视图不请求旧文件分页接口', () => {
    for (const type of ['personal', 'project', 'disk-personal', 'disk-project', 'disk-workspace']) {
      setup(type, { type, id: 1, relativePath: '子目录', workspaceDirectoryId: 2 }).loadContents()
    }
    expect(filesApi.page).not.toHaveBeenCalled()
  })

  it('账号切换后丢弃尚未返回的根目录统计', async () => {
    let resolveEntries!: (value: Awaited<ReturnType<typeof pathFilesApi.entries>>) => void
    vi.mocked(pathFilesApi.entries).mockImplementationOnce(() => new Promise(resolve => { resolveEntries = resolve }))
    const directory = setup('root')
    directory.loadContents()
    beginAccountBoundary()
    await nextTick()
    resolveEntries([{ name: '旧账号.txt', relativePath: '旧账号.txt', kind: 'file', size: 1, mimeType: 'text/plain' }])
    await Promise.resolve(); await Promise.resolve()
    expect(directory.contents.value).toEqual({ folders: [], files: [] })
  })
})
