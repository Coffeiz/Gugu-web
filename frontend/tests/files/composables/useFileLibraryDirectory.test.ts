import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { filesApi, foldersApi, trashApi } from '@/services/api'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import type { NavSeg } from '@/utils/filesNav'
import { beginAccountBoundary } from '@/utils/accountBoundary'

vi.mock('@/services/api', () => ({
  filesApi: { list: vi.fn(), all: vi.fn(), tree: vi.fn(), version: vi.fn() },
  foldersApi: { list: vi.fn(), all: vi.fn() },
  trashApi: { counts: vi.fn(), list: vi.fn(), listFolders: vi.fn() },
}))

vi.mock('vue-i18n', async () => {
  const vue = await import('vue')
  return { useI18n: () => ({ t: (key: string) => key, locale: vue.ref('zh-CN') }) }
})

const file = { id: 18, displayName: '当前目录文件', ext: 'md' } as FileMeta
const folder = { id: 28, name: '子目录', fileCount: 3 } as FolderMeta

describe('文件库目录按需加载', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(filesApi.list).mockResolvedValue([file] as never)
    vi.mocked(filesApi.tree).mockResolvedValue({ projects: [], personalCount: 1, personalRootCount: 2 })
    vi.mocked(foldersApi.list).mockResolvedValue([folder] as never)
    vi.mocked(trashApi.counts).mockResolvedValue({ fileCount: 3, folderCount: 2, totalCount: 5 })
    vi.mocked(trashApi.list).mockResolvedValue([] as never)
    vi.mocked(trashApi.listFolders).mockResolvedValue([] as never)
  })

  function setup(type: string, segment: NavSeg | null) {
    const replaceDirectorySnapshot = vi.fn()
    const currentType = ref(type)
    const currentSeg = ref(segment)
    const loading = ref(false)
    const directory = useFileLibraryDirectory({
      projectStore: { projects: [], kanbanColumns: [] },
      cacheStore: {
        loaded: false,
        allFiles: [],
        getPersonalRootFolders: () => [], getPersonalRootFiles: () => [],
        getProjectRootFolders: () => [], getProjectRootFiles: () => [],
        getSubFolders: () => [], getFolderFiles: () => [],
        getWorkspaceFolders: () => [], getWorkspaceFiles: () => [],
        replaceDirectorySnapshot,
      },
      currentType,
      currentSeg,
      loading,
      sortKey: ref('name'), sortDir: ref('asc'),
    })
    return { ...directory, currentType, currentSeg, loading, replaceDirectorySnapshot }
  }

  it('个人根目录只请求该目录数据，不触发全量 files/folders API', async () => {
    const page = setup('personal', { type: 'personal' })

    page.loadContents()
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([file]))

    expect(filesApi.list).toHaveBeenCalledWith({ space: 'personal', projectId: undefined, folderId: undefined, workspaceDirectoryId: undefined })
    expect(foldersApi.list).toHaveBeenCalledWith({ projectId: undefined, parentId: undefined, workspaceDirectoryId: undefined })
    expect(filesApi.all).not.toHaveBeenCalled()
    expect(foldersApi.all).not.toHaveBeenCalled()
    expect(page.replaceDirectorySnapshot).toHaveBeenCalledWith({ space: 'personal' }, [file], [folder])
  })

  it('根页面用聚合计数显示个人根目录项目数，不为计数下载全量列表', async () => {
    const page = setup('root', null)

    page.loadContents()
    await vi.waitFor(() => expect(page.contents.value.folders.find(item => item.id === 'personal')?.count).toBe(2))
    await vi.waitFor(() => expect(page.contents.value.folders.find(item => item.id === 'trash')?.count).toBe(5))

    expect(filesApi.tree).toHaveBeenCalledOnce()
    expect(trashApi.counts).toHaveBeenCalledOnce()
    expect(trashApi.list).not.toHaveBeenCalled()
    expect(trashApi.listFolders).not.toHaveBeenCalled()
    expect(filesApi.all).not.toHaveBeenCalled()
    expect(foldersApi.all).not.toHaveBeenCalled()
  })

  it('工作区子目录同时限定工作区与父文件夹', async () => {
    const page = setup('folder', { type: 'folder', folderId: 34, space: 'workspace', workspaceDirectoryId: 12 })

    page.loadContents()
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([file]))

    expect(filesApi.list).toHaveBeenCalledWith({ space: 'workspace', projectId: undefined, folderId: 34, workspaceDirectoryId: 12 })
    expect(foldersApi.list).toHaveBeenCalledWith({ projectId: undefined, parentId: 34, workspaceDirectoryId: 12 })
    expect(filesApi.all).not.toHaveBeenCalled()
  })

  it('切入尚未缓存的目录时先移除旧根目录卡片，再显示目标目录内容', async () => {
    const page = setup('root', null)
    page.loadContents()
    page.currentType.value = 'personal'
    page.currentSeg.value = { type: 'personal' }
    page.contents.value = {
      folders: [{ id: 'trash', type: 'trash', displayName: '回收站' } as never],
      files: [],
    }

    page.loadContents()

    expect(page.contents.value).toEqual({ folders: [], files: [] })
    expect(page.loading.value).toBe(true)
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([file]))
  })

  it('重进已访问目录先恢复该目录快照，同时在后台刷新', async () => {
    const page = setup('personal', { type: 'personal' })
    page.loadContents()
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([file]))

    let resolveFiles!: (rows: unknown[]) => void
    let resolveFolders!: (rows: unknown[]) => void
    vi.mocked(filesApi.list).mockImplementationOnce(() => new Promise(resolve => { resolveFiles = resolve }) as never)
    vi.mocked(foldersApi.list).mockImplementationOnce(() => new Promise(resolve => { resolveFolders = resolve }) as never)
    page.currentType.value = 'workspace'
    page.currentSeg.value = { type: 'workspace', workspaceDirectoryId: 12 } as NavSeg
    page.loadContents()
    expect(page.contents.value).toEqual({ folders: [], files: [] })

    page.currentType.value = 'personal'
    page.currentSeg.value = { type: 'personal' }
    page.loadContents()

    expect(page.contents.value.files).toEqual([file])
    expect(page.loading.value).toBe(false)
    resolveFiles([])
    resolveFolders([])
  })

  it('删除后先剔除所有旧目录快照，并阻止删除前请求把卡片复活', async () => {
    const page = setup('personal', { type: 'personal' })
    page.loadContents()
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([file]))

    let resolvePreDelete!: (rows: FileMeta[]) => void
    vi.mocked(filesApi.list)
      .mockImplementationOnce(() => new Promise(resolve => { resolvePreDelete = resolve }) as never)
      .mockResolvedValueOnce([] as never)
    page.loadContents() // 删除前启动的目录读取仍会返回旧列表

    page.removeFilesFromSnapshots([file.id])
    expect(page.contents.value.files).toEqual([])
    page.loadContents() // 删除提交后重新读取权威目录
    await vi.waitFor(() => expect(page.contents.value.files).toEqual([]))

    resolvePreDelete([file])
    await Promise.resolve()
    await Promise.resolve()

    expect(page.contents.value.files).toEqual([])
  })

  it('账号切换后丢弃旧账号尚未返回的目录响应', async () => {
    const page = setup('personal', { type: 'personal' })
    let resolveFiles!: (rows: unknown[]) => void
    let resolveFolders!: (rows: unknown[]) => void
    vi.mocked(filesApi.list).mockImplementationOnce(() => new Promise(resolve => { resolveFiles = resolve }) as never)
    vi.mocked(foldersApi.list).mockImplementationOnce(() => new Promise(resolve => { resolveFolders = resolve }) as never)

    page.loadContents()
    beginAccountBoundary()
    await nextTick()
    resolveFiles([file])
    resolveFolders([folder])
    await Promise.resolve()
    await Promise.resolve()

    expect(page.contents.value).toEqual({ folders: [], files: [] })
    expect(page.replaceDirectorySnapshot).not.toHaveBeenCalled()
  })
})
