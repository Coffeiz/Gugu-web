import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { filesApi, foldersApi, trashApi, type CursorPage } from '@/services/api'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import type { NavSeg } from '@/utils/filesNav'
import { beginAccountBoundary } from '@/utils/accountBoundary'

vi.mock('@/services/api', () => ({
  filesApi: { page: vi.fn() },
  foldersApi: { page: vi.fn() },
  trashApi: { page: vi.fn(), foldersPage: vi.fn() },
}))

vi.mock('vue-i18n', async () => {
  const vue = await import('vue')
  return { useI18n: () => ({ t: (key: string) => key, locale: vue.ref('zh-CN') }) }
})

const file = { id: 18, displayName: '当前目录文件', ext: 'md' } as FileMeta
const nextFile = { id: 19, displayName: '下一页文件', ext: 'md' } as FileMeta
const folder = { id: 28, name: '子目录', fileCount: 3 } as FolderMeta
const page = <T>(items: T[], next_cursor: string | null = null, has_more = false): CursorPage<T> => ({ items, next_cursor, has_more })

describe('文件库目录按需分页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(filesApi.page).mockResolvedValue(page([file], 'file-next', true) as never)
    vi.mocked(foldersApi.page).mockResolvedValue(page([folder]) as never)
    vi.mocked(trashApi.page).mockResolvedValue(page([file], 'trash-next', true) as never)
    vi.mocked(trashApi.foldersPage).mockResolvedValue(page([], null, false) as never)
  })

  function setup(type: string, segment: NavSeg | null) {
    const directories = new Map<string, { files: FileMeta[]; folders: FolderMeta[]; fileCursor: string | null; folderCursor: string | null; fileHasMore: boolean; folderHasMore: boolean }>()
    const setDirectoryPage = vi.fn((scope, files, folders, append = false) => {
      const key = `${scope.space}:${scope.projectId ?? 0}:${scope.workspaceDirectoryId ?? 0}:${scope.folderId ?? 0}`
      const old = directories.get(key)
      directories.set(key, {
        files: append ? [...(old?.files ?? []), ...files.items] : files.items,
        folders: append ? [...(old?.folders ?? []), ...folders.items] : folders.items,
        fileCursor: files.next_cursor ?? old?.fileCursor ?? null,
        folderCursor: folders.next_cursor ?? old?.folderCursor ?? null,
        fileHasMore: files.has_more, folderHasMore: folders.has_more,
      })
    })
    const currentType = ref(type)
    const currentSeg = ref(segment)
    const loading = ref(false)
    const directory = useFileLibraryDirectory({
      projectStore: { projects: [], kanbanColumns: [] },
      cacheStore: {
        getDirectory: scope => directories.get(`${scope.space}:${scope.projectId ?? 0}:${scope.workspaceDirectoryId ?? 0}:${scope.folderId ?? 0}`) ?? null,
        setDirectoryPage,
        getPersonalRootFiles: () => [],
        getProjectRootFolders: () => [], getProjectRootFiles: () => [],
        getSubFolders: () => [], getFolderFiles: () => [],
        getWorkspaceFolders: () => [], getWorkspaceFiles: () => [],
      },
      currentType, currentSeg, loading, sortKey: ref('name'), sortDir: ref('asc'),
    })
    return { ...directory, currentType, currentSeg, loading, setDirectoryPage }
  }

  it('只取当前目录首屏，接近末尾时用 cursor 追加下一页', async () => {
    const pageState = setup('personal', { type: 'personal' })
    pageState.loadContents()
    await vi.waitFor(() => expect(pageState.contents.value.files).toEqual([file]))

    expect(filesApi.page).toHaveBeenCalledWith({
      space: 'personal', projectId: undefined, folderId: undefined,
      workspaceDirectoryId: undefined, sortBy: 'name', sortOrder: 'asc',
    })
    expect(foldersApi.page).toHaveBeenCalledWith({
      projectId: undefined, parentId: undefined, workspaceDirectoryId: undefined,
      sortBy: 'name', sortOrder: 'asc',
    })

    vi.mocked(filesApi.page).mockResolvedValueOnce(page([nextFile]) as never)
    await pageState.loadMore()
    expect(filesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'file-next' }))
    expect(pageState.contents.value.files.map(item => item.id)).toEqual([18, 19])
    expect(pageState.setDirectoryPage).toHaveBeenLastCalledWith(
      { space: 'personal', sortBy: 'name', sortOrder: 'asc' }, page([nextFile]), page([], null, false), true,
    )
  })

  it('根页面不触发全局文件或回收站计数扫描', async () => {
    const pageState = setup('root', null)
    pageState.loadContents()
    expect(pageState.contents.value.folders.find(item => item.id === 'personal')?.count).toBeNull()
  })

  it('Workspace 子目录分页请求同时限定 Workspace 和父目录', async () => {
    const pageState = setup('folder', { type: 'folder', folderId: 34, space: 'workspace', workspaceDirectoryId: 12 })
    pageState.loadContents()
    await vi.waitFor(() => expect(pageState.contents.value.files).toEqual([file]))
    expect(filesApi.page).toHaveBeenCalledWith(expect.objectContaining({
      space: 'workspace', folderId: 34, workspaceDirectoryId: 12,
    }))
    expect(foldersApi.page).toHaveBeenCalledWith(expect.objectContaining({ parentId: 34, workspaceDirectoryId: 12 }))
  })

  it('账号切换后丢弃尚未返回的目录页', async () => {
    let resolveFiles!: (value: CursorPage<FileMeta>) => void
    let resolveFolders!: (value: CursorPage<FolderMeta>) => void
    vi.mocked(filesApi.page).mockImplementationOnce(() => new Promise(resolve => { resolveFiles = resolve }) as never)
    vi.mocked(foldersApi.page).mockImplementationOnce(() => new Promise(resolve => { resolveFolders = resolve }) as never)
    const pageState = setup('personal', { type: 'personal' })
    pageState.loadContents()
    beginAccountBoundary()
    await nextTick()
    resolveFiles(page([file]))
    resolveFolders(page([folder]))
    await Promise.resolve(); await Promise.resolve()
    expect(pageState.contents.value).toEqual({ folders: [], files: [] })
  })
})
